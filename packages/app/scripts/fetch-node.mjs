#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Download the pinned Node.js release for the current build's
 * platform, verify its sha256 against
 * `packages/app/src/node-version.ts`, and write the `node[.exe]`
 * binary plus the matching Node redistribution terms to
 * `packages/app/dist/node-bundle/` so Electron can ship them
 * asar-unpacked.
 *
 * Mirrors fetch-pnpm.mjs. Two differences:
 *   - Node's Unix releases ship as `.tar.gz`; we extract only the
 *     `bin/node` binary using the `tar` package.
 *   - Windows ships `node.exe` as a standalone binary at
 *     `/dist/vX.Y.Z/win-x64/node.exe` — no extraction.
 *
 * Called from the app's tsup build. Idempotent: if the binary is
 * already on disk with the right version marker (and matching sha on
 * Windows), does nothing.
 *
 * Environment:
 *   GEZEL_NODE_TARGET_PLATFORM — override process.platform (for CI cross-builds).
 *   GEZEL_NODE_TARGET_ARCH     — override process.arch.
 *   GEZEL_NODE_SKIP=1          — skip the download entirely (dev mode;
 *                                the supervisor's extract-node step
 *                                treats a missing bundle as "fall back
 *                                to system node").
 */
import { createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extract } from 'tar';

// Node's Happy Eyeballs (RFC 8305) gives each candidate address only
// 250ms before moving to the next one. On Windows machines that resolve
// nodejs.org to Cloudflare's anycast IPs alongside non-routable IPv6
// addresses, the TCP handshake to Cloudflare takes ~700–1000ms — longer
// than the default — so undici's fetch consistently fails with
// AggregateError ETIMEDOUT in ~550ms while curl (which serializes
// attempts) succeeds. Bump the per-address timeout to 5s so the v4
// connect has time to complete before the algorithm gives up.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const DOWNLOAD_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

async function importPinned() {
  // Read the pins directly so we don't need a compile step first.
  const src = await readFile(join(appRoot, 'src', 'node-version.ts'), 'utf8');
  const versionMatch = src.match(/NODE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!versionMatch) throw new Error('cannot parse NODE_VERSION');
  const licenseShaMatch = src.match(/NODE_LICENSE_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/);
  if (!licenseShaMatch) throw new Error('cannot parse NODE_LICENSE_SHA256');
  const shaBlock = src.match(/NODE_SHA256[^{]*\{([\s\S]*?)\}/);
  if (!shaBlock) throw new Error('cannot parse NODE_SHA256');
  const shas = {};
  for (const line of shaBlock[1].split('\n')) {
    const m = line.match(/^\s*['"]([^'"]+)['"]\s*:\s*['"]([0-9a-fA-F]{64})['"]/);
    if (m) shas[m[1]] = m[2].toLowerCase();
  }
  return { version: versionMatch[1], licenseSha: licenseShaMatch[1].toLowerCase(), shas };
}

function releaseKey(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'macos-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/**
 * Download asset info for a platform key. Shape mirrors fetch-pnpm's
 * single-file download with an extra branch for tarball extraction:
 *   - win-x64: one-file download (raw node.exe); sha is file-level.
 *   - macos/linux: tarball download + single-file extract; sha is
 *     computed on the tarball (matches what Node publishes in
 *     SHASUMS256.txt and what bump-node writes into node-version.ts).
 */
function assetInfo(key, version) {
  const base = `https://nodejs.org/dist/v${version}`;
  if (key === 'win-x64') {
    return {
      url: `${base}/win-x64/node.exe`,
      archive: null,
      outName: 'node.exe',
    };
  }
  // Node's unix tarballs use `darwin` / `linux` in the filename; our
  // key uses `macos` to match pnpm's naming so users see the same
  // label across bundles.
  const dist = key.replace('macos', 'darwin');
  const stem = `node-v${version}-${dist}`;
  return {
    url: `${base}/${stem}.tar.gz`,
    archive: 'tar.gz',
    strip: 2, // strip `node-v{ver}-{os}-{arch}/bin/` so the file lands as `node`
    // tar's filter sees pre-strip paths, so we match the full in-archive path.
    filterTarget: `${stem}/bin/node`,
    outName: 'node',
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function downloadTo(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const partial = `${dest}.partial-${process.pid}-${attempt}`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} from ${url}`);
        error.httpStatus = res.status;
        throw error;
      }
      if (!res.body) throw new Error(`empty response body from ${url}`);

      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
      await rm(dest, { force: true });
      await rename(partial, dest);
      if (attempt > 1) {
        console.log(`[fetch-node] download recovered on attempt ${attempt}/${DOWNLOAD_ATTEMPTS}`);
      }
      return;
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      const status = error?.httpStatus;
      const retryable =
        status === undefined || RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
      if (!retryable || attempt === DOWNLOAD_ATTEMPTS) throw error;

      const delayMs = 500 * 2 ** (attempt - 1);
      console.warn(
        `[fetch-node] download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed for ${url}: ${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs}ms`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}

async function main() {
  if (process.env.GEZEL_NODE_SKIP === '1') {
    console.log('[fetch-node] GEZEL_NODE_SKIP=1 — skipping bundle.');
    return;
  }

  const platform = process.env.GEZEL_NODE_TARGET_PLATFORM ?? process.platform;
  const arch = process.env.GEZEL_NODE_TARGET_ARCH ?? process.arch;
  const key = releaseKey(platform, arch);
  if (!key) {
    throw new Error(`[fetch-node] unsupported platform/arch: ${platform}/${arch}`);
  }

  const { version, licenseSha, shas } = await importPinned();
  const expectedSha = shas[key];
  if (!expectedSha || /^0+$/.test(expectedSha)) {
    // Placeholder sha (zeros) is a hard error: an installer shipped
    // with missing shas would silently lose its bundled Node and the
    // sandbox runner / Copilot login flow would break on user
    // machines. Two escape hatches:
    //   - `node scripts/bump-node.mjs <version>` — populate from upstream.
    //   - `GEZEL_NODE_SKIP=1` — opt out (dev iteration without bumping).
    throw new Error(
      `[fetch-node] node-version.ts has a placeholder sha for ${key}. Run \`node scripts/bump-node.mjs ${version}\` to populate, or set GEZEL_NODE_SKIP=1 to skip the bundle for this build.`,
    );
  }

  const info = assetInfo(key, version);
  // Persistent cache outside `dist/` — tsup --clean wipes dist on every
  // build, which would force a re-download every single time.
  // `.cache/native-runtime/` survives across builds and is gitignored.
  const cacheDir = resolve(appRoot, '.cache', 'native-runtime', 'node-bundle');
  const cacheBinary = join(cacheDir, info.outName);
  const cacheVersion = join(cacheDir, 'version.txt');
  const cacheLicense = join(cacheDir, 'LICENSE.txt');
  // The dist copy is what the supervisor / electron-builder consume.
  const distDir = resolve(appRoot, 'dist', 'node-bundle');
  const distBinary = join(distDir, info.outName);
  const distVersion = join(distDir, 'version.txt');
  const distLicense = join(distDir, 'LICENSE.txt');

  // ── Step 1: ensure the cache holds the right version ────────────
  // Idempotency: for Windows we can re-verify the binary-level sha;
  // for unix the pinned sha is the tarball's, so we use the version
  // marker + presence of a non-empty binary as the cache key.
  let cacheValid = false;
  let cachedVersion = '';
  try {
    cachedVersion = await readFile(cacheVersion, 'utf8').catch(() => '');
    const cachedBin = await stat(cacheBinary);
    if (cachedBin.isFile() && cachedVersion.trim() === version) {
      if (!info.archive) {
        const currentSha = await sha256File(cacheBinary);
        if (currentSha === expectedSha) cacheValid = true;
      } else {
        cacheValid = true;
      }
    }
  } catch {
    /* no existing cache */
  }

  if (cacheValid) {
    console.log(`[fetch-node] ${key} v${version} already cached at ${cacheBinary}`);
  } else {
    await mkdir(cacheDir, { recursive: true });
    console.log(`[fetch-node] downloading ${info.url}`);

    if (!info.archive) {
      // Windows: one-file download, verify the raw binary sha.
      await downloadTo(info.url, cacheBinary);
      const actualSha = await sha256File(cacheBinary);
      if (actualSha !== expectedSha) {
        throw new Error(
          `[fetch-node] sha256 mismatch for ${key} v${version}: expected ${expectedSha}, got ${actualSha}`,
        );
      }
    } else {
      // Unix: tarball → temp file → verify archive sha → extract just
      // the node binary. Using `tar`'s filter+strip means we never
      // materialize the rest of the Node distribution (~100MB of npm,
      // corepack, lib/*), keeping the asar-unpack tiny.
      const scratch = await mkdtemp(join(tmpdir(), 'gezel-node-fetch-'));
      const tmpArchive = join(scratch, `node-${key}.tar.gz`);
      try {
        await downloadTo(info.url, tmpArchive);
        const actualSha = await sha256File(tmpArchive);
        if (actualSha !== expectedSha) {
          throw new Error(
            `[fetch-node] sha256 mismatch for ${key} v${version}: expected ${expectedSha}, got ${actualSha}`,
          );
        }
        await extract({
          file: tmpArchive,
          cwd: cacheDir,
          strip: info.strip,
          filter: (p) => p === info.filterTarget,
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      const extracted = await stat(cacheBinary).catch(() => null);
      if (!extracted?.isFile()) {
        throw new Error(
          `[fetch-node] extract completed but ${cacheBinary} is missing — tar filter may have mismatched`,
        );
      }
      await chmod(cacheBinary, 0o755);
    }
    await writeFile(cacheVersion, `${version}\n`, 'utf8');
    console.log(`[fetch-node] cached ${cacheBinary} (v${version}, sha256 verified)`);
  }

  // Node's top-level LICENSE carries both the Node.js terms and the
  // third-party notices for code incorporated into the runtime. The Windows
  // release is a standalone node.exe, so fetch this version-scoped companion
  // directly instead of assuming a tarball is present on every platform.
  const cachedLicense = await stat(cacheLicense).catch(() => null);
  const licenseValid =
    cachedVersion.trim() === version &&
    cachedLicense?.isFile() &&
    cachedLicense.size > 0 &&
    (await sha256File(cacheLicense)) === licenseSha;
  if (!licenseValid) {
    const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
    console.log(`[fetch-node] downloading ${licenseUrl}`);
    await downloadTo(licenseUrl, cacheLicense);
    const license = await readFile(cacheLicense, 'utf8');
    if (!license.includes('Node.js is licensed for use as follows')) {
      throw new Error(`[fetch-node] ${licenseUrl} did not contain the expected Node.js terms`);
    }
    const actualLicenseSha = await sha256File(cacheLicense);
    if (actualLicenseSha !== licenseSha) {
      throw new Error(
        `[fetch-node] license sha256 mismatch for v${version}: expected ${licenseSha}, got ${actualLicenseSha}`,
      );
    }
  }

  // ── Step 2: stage cache → dist on every build ───────────────────
  // tsup --clean wipes dist between builds, so this always runs.
  // copyFile is fast enough (~80MB Windows, ~few hundred ms) to not
  // be worth a hardlink optimization.
  await mkdir(distDir, { recursive: true });
  await copyFile(cacheBinary, distBinary);
  await copyFile(cacheLicense, distLicense);
  if (process.platform !== 'win32') await chmod(distBinary, 0o755);
  await writeFile(distVersion, `${version}\n`, 'utf8');
  // Bundle-local integrity manifest: hash of the STAGED binary (the unix
  // pin in node-version.ts is the tarball's sha, which the extracted
  // binary can't be checked against). The supervisor's extract step
  // re-hashes against this at install time, extending the pin → download
  // → stage chain through to ~/.gezel/bin.
  const stagedSha = await sha256File(distBinary);
  await writeFile(join(distDir, 'sha256.txt'), `${stagedSha}  ${info.outName}\n`, 'utf8');
  console.log(`[fetch-node] staged ${distBinary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
