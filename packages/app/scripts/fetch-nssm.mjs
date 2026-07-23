#!/usr/bin/env node
/**
 * Verify — and, if missing or corrupt, restore — the pinned NSSM 2.24
 * binary at `packages/app/installer/nssm/nssm.exe`.
 *
 * The binary is vendored in-repo (see installer/nssm/README.md for the
 * provenance record and bump procedure), so the normal outcome here is
 * the no-network fast path: sha matches, nothing to do. The download
 * branch exists as a recovery path for a deleted/corrupted working
 * copy, not as the source of the shipped bytes.
 *
 * NSSM wraps `gezeld` as a Windows Service (see
 * installer/nsis-hooks.nsh) and is referenced from electron-builder.yml
 * via `win.extraFiles`. Without it, the NSIS install macro's
 * `"$INSTDIR\nssm.exe" install GezelService ...` calls invoke nothing
 * and the service silently fails to register — same failure mode that
 * cost a 30-minute install.
 *
 * Called from the app's tsup build's `onSuccess` hook (Windows builds
 * only). If the sha ever diverges from the committed binary, upstream
 * has been tampered with (or the URL silently serves something new) —
 * bump intentionally per the README, never by letting a build "fix" it.
 *
 * Environment:
 *   GEZEL_NSSM_SKIP=1   — skip entirely (dev mode without admin /
 *                         non-Windows packaging targets / offline iteration).
 *                         With the binary committed this is rarely needed;
 *                         if the file were absent the local installer would
 *                         ship without nssm.exe and the NSIS macro's calls
 *                         would no-op silently.
 *
 * The CI release workflow (.github/workflows/release-electron.yml)
 * verifies the same pin before packaging — verification only, no
 * download. The committed file is the source of truth; this pin and
 * the README's hashes are cross-checked by src/nssm-binary.test.ts.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Node's default 250ms per-address connect timeout is too aggressive for
// Windows→GitHub/Cloudflare TCP handshakes — same workaround as
// fetch-pnpm/fetch-node.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const NSSM_VERSION = '2.24';
const NSSM_ZIP_URL = `https://nssm.cc/release/nssm-${NSSM_VERSION}.zip`;
// Hash of the win64 nssm.exe inside the zip — what we actually ship.
// Same value the CI release workflow verifies after extraction. We don't
// pin the outer .zip sha because nssm.cc's CDN occasionally re-packs the
// same payload; the extracted binary is the trust boundary.
const NSSM_EXE_SHA256 = 'f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97';
// Path inside the zip to the binary we care about.
const NSSM_EXE_PATH_IN_ZIP = `nssm-${NSSM_VERSION}/win64/nssm.exe`;

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const destPath = join(appRoot, 'installer', 'nssm', 'nssm.exe');

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function downloadTo(url, dest) {
  // nssm.cc is hosted on a slow server that returns 503 under any noticeable
  // load (or during their nightly maintenance window). A few-second retry
  // budget reliably gets past it.
  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      await mkdir(dirname(dest), { recursive: true });
      const file = createWriteStream(dest);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!file.write(value)) await new Promise((r) => file.once('drain', r));
      }
      await new Promise((r) => file.end(r));
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        console.warn(
          `[fetch-nssm] attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${backoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Extract a single file from a zip. We shell out to the bundled `tar`
 * (libarchive on Windows 10 1803+, BSD tar on macOS, GNU tar on Linux —
 * all support zip extraction via the same flag set). One less npm dep
 * to keep in sync.
 */
async function extractFromZip(zipPath, fileInZip, dest) {
  const stagingDir = await import('node:fs/promises').then((m) =>
    m.mkdtemp(join(tmpdir(), 'nssm-extract-')),
  );
  try {
    const tarBin =
      process.platform === 'win32'
        ? join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    await exec(tarBin, ['-xf', zipPath, '-C', stagingDir]);
    const extracted = join(stagingDir, fileInZip);
    if (!existsSync(extracted)) {
      throw new Error(`zip did not contain expected entry ${fileInZip}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(extracted, dest);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.GEZEL_NSSM_SKIP === '1') {
    console.log('[fetch-nssm] GEZEL_NSSM_SKIP=1 — skipping bundle.');
    return;
  }

  // Skip on non-Windows packaging targets. macOS / Linux installers
  // don't use NSSM (they have LaunchDaemons / systemd). When developers
  // build the macOS PKG or .deb from a Linux/Mac host, fetching NSSM is
  // wasted work.
  if (process.platform !== 'win32' && !process.env.GEZEL_NSSM_FORCE) {
    console.log(
      `[fetch-nssm] platform=${process.platform} — NSSM is Windows-only, skipping. Set GEZEL_NSSM_FORCE=1 to override (e.g. cross-building a Windows installer from POSIX).`,
    );
    return;
  }

  // Fast path: destination already exists with the right sha.
  if (existsSync(destPath)) {
    const sha = await sha256File(destPath);
    if (sha === NSSM_EXE_SHA256) {
      console.log(`[fetch-nssm] nssm.exe v${NSSM_VERSION} already at ${destPath}`);
      return;
    }
    console.log(`[fetch-nssm] existing nssm.exe has wrong sha (${sha.slice(0, 12)}…), re-fetching`);
  }

  const zipPath = join(tmpdir(), `nssm-${NSSM_VERSION}.zip`);
  console.log(`[fetch-nssm] downloading ${NSSM_ZIP_URL}`);
  await downloadTo(NSSM_ZIP_URL, zipPath);

  await extractFromZip(zipPath, NSSM_EXE_PATH_IN_ZIP, destPath);
  await rm(zipPath, { force: true });

  const exeSha = await sha256File(destPath);
  if (exeSha !== NSSM_EXE_SHA256) {
    await rm(destPath, { force: true });
    throw new Error(
      `[fetch-nssm] sha256 mismatch for extracted nssm.exe: expected ${NSSM_EXE_SHA256}, got ${exeSha}`,
    );
  }
  const sz = (await stat(destPath)).size;
  console.log(`[fetch-nssm] staged ${destPath} (${(sz / 1024).toFixed(1)} KB, sha256 verified)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
