/**
 * fetch-duckdb.mjs — stage the pinned DuckDB CLI into the Electron bundle.
 *
 * DuckDB is vendored, not built. The DuckDB Foundation publishes a
 * precompiled single-file CLI that is already Developer ID signed and
 * notarized on macOS and Authenticode signed on Windows, so Gezel ships those
 * exact bytes. This is the same provenance rule the bundled Node runtime
 * follows — see the `signIgnore` block in electron-builder.yml. Re-signing a
 * vendor binary replaces their attestation with ours and destroys the
 * "hash-comparable against the vendor's own manifest" property that makes
 * redistributing someone else's executable defensible in the first place.
 *
 * That is also why DuckDB is not in `native/` any more: it has no build
 * script and no artifact in the `native-v*` release. It is a bundled runtime
 * alongside node and pnpm.
 *
 * Emits `packages/app/dist/duckdb-bundle/`:
 *   duckdb[.exe]   the vendor binary, byte-identical to their release
 *   version.txt    the pinned version, read by the supervisor's installer
 *   LICENSE.txt    DuckDB's MIT license, version-scoped
 *   sha256.txt     bundle-local integrity manifest (see bundle-manifest.ts)
 *
 * Env:
 *   GEZEL_DUCKDB_SKIP=1              omit the bundle (dev iteration)
 *   GEZEL_DUCKDB_TARGET_PLATFORM     cross-stage for another platform
 *   GEZEL_DUCKDB_TARGET_ARCH
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..');
const DOWNLOAD_ATTEMPTS = 3;

async function removeTree(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 2,
    retryDelay: 100,
  });
}

/**
 * Read the pin out of core's TypeScript source rather than importing core's
 * build output, so this script runs before (or without) a core build — same
 * reason fetch-node.mjs parses `node-version.ts`.
 */
async function importPinned() {
  const src = await readFile(
    join(repoRoot, 'packages', 'core', 'src', 'native', 'duckdb-pin.ts'),
    'utf8',
  );
  const one = (name) => {
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*['"]([^'"]+)['"]`));
    if (!m) throw new Error(`[fetch-duckdb] cannot parse ${name}`);
    return m[1];
  };
  const table = (name, pattern) => {
    const block = src.match(new RegExp(`export const ${name}[^{]*\\{([\\s\\S]*?)\\n\\};`));
    if (!block) throw new Error(`[fetch-duckdb] cannot parse ${name}`);
    const out = {};
    for (const line of block[1].split('\n')) {
      const m = line.match(new RegExp(`^\\s*['"]([^'"]+)['"]\\s*:\\s*['"](${pattern})['"]`));
      if (m) out[m[1]] = m[2];
    }
    if (Object.keys(out).length === 0) throw new Error(`[fetch-duckdb] ${name} parsed empty`);
    return out;
  };
  return {
    version: one('DUCKDB_VERSION'),
    commit: one('DUCKDB_COMMIT'),
    licenseSha: one('DUCKDB_LICENSE_SHA256').toLowerCase(),
    assets: table('DUCKDB_ASSET', '[^\'"]+'),
    archiveShas: table('DUCKDB_ARCHIVE_SHA256', '[0-9a-fA-F]{64}'),
    binaryShas: table('DUCKDB_BINARY_SHA256', '[0-9a-fA-F]{64}'),
  };
}

function platformKey(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function downloadTo(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const partial = `${dest}.partial-${process.pid}-${attempt}`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
      await rm(dest, { force: true });
      await copyFile(partial, dest);
      await rm(partial, { force: true });
      return;
    } catch (err) {
      lastError = err;
      if (attempt === DOWNLOAD_ATTEMPTS) break;
      const delayMs = 500 * 2 ** (attempt - 1);
      console.warn(`[fetch-duckdb] ${err}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Read one named file out of a ZIP, using only Node built-ins.
 *
 * `packages/app` has no zip dependency and adding one for a build script is
 * not worth an install; DuckDB's CLI archive holds a single stored-or-
 * deflated entry, which is a small amount of well-specified parsing. The
 * caller verifies the returned bytes against the pinned sha256, so a parsing
 * mistake fails the build loudly rather than staging wrong bytes.
 *
 * ZIP64 is rejected rather than half-handled — the CLI archives are tens of
 * megabytes and will not reach the 4 GiB threshold, so encountering it means
 * something changed upstream that deserves a human.
 */
function readZipEntry(buf, wantName) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new Error('ZIP64 archives are not supported by this reader');
  }

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('corrupt ZIP central directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === wantName || name.endsWith(`/${wantName}`)) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('corrupt ZIP local file header');
      }
      // The local header's name/extra lengths are authoritative for locating
      // the data; they legitimately differ from the central directory's.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      if (method !== 0 && method !== 8) {
        throw new Error(`unsupported ZIP compression method ${method}`);
      }
      const raw = buf.subarray(start, start + compressedSize);
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      if (data.length !== uncompressedSize) {
        throw new Error(
          `ZIP entry ${name} inflated to ${data.length} bytes, header says ${uncompressedSize}`,
        );
      }
      return data;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function main() {
  const distDir = resolve(appRoot, 'dist', 'duckdb-bundle');
  if (process.env.GEZEL_DUCKDB_SKIP === '1') {
    await removeTree(distDir);
    console.log('[fetch-duckdb] GEZEL_DUCKDB_SKIP=1 — skipping bundle.');
    return;
  }

  const platform = process.env.GEZEL_DUCKDB_TARGET_PLATFORM ?? process.platform;
  const arch = process.env.GEZEL_DUCKDB_TARGET_ARCH ?? process.arch;
  const key = platformKey(platform, arch);
  if (!key) {
    // Not fatal: DuckDB publishes no build for this host, and the daemon
    // degrades to "data query engine unavailable" rather than failing to boot.
    await removeTree(distDir);
    console.log(`[fetch-duckdb] no DuckDB build for ${platform}/${arch} — skipping bundle.`);
    return;
  }

  const { version, commit, licenseSha, assets, archiveShas, binaryShas } = await importPinned();
  const asset = assets[key];
  const archiveSha = archiveShas[key]?.toLowerCase();
  const binarySha = binaryShas[key]?.toLowerCase();
  if (!asset || !archiveSha || !binarySha || /^0+$/.test(archiveSha)) {
    throw new Error(
      `[fetch-duckdb] duckdb-pin.ts has no usable pin for ${key}. Run \`node scripts/bump-duckdb.mjs ${version}\`, or set GEZEL_DUCKDB_SKIP=1 to skip the bundle for this build.`,
    );
  }

  const outName = platform === 'win32' ? 'duckdb.exe' : 'duckdb';
  // Persistent cache outside dist/ — tsup --clean wipes dist every build.
  const cacheDir = resolve(appRoot, '.cache', 'native-runtime', 'duckdb-bundle', key);
  const cacheBinary = join(cacheDir, outName);
  const cacheVersion = join(cacheDir, 'version.txt');
  const cacheLicense = join(cacheDir, 'LICENSE.txt');

  // ── Step 1: ensure the cache holds the pinned binary ─────────────
  let cacheValid = false;
  try {
    const cached = await stat(cacheBinary);
    const cachedVersion = (await readFile(cacheVersion, 'utf8').catch(() => '')).trim();
    if (cached.isFile() && cachedVersion === version) {
      cacheValid = (await sha256File(cacheBinary)) === binarySha;
    }
  } catch {
    /* no cache */
  }

  if (cacheValid) {
    console.log(`[fetch-duckdb] ${key} v${version} already cached at ${cacheBinary}`);
  } else {
    await mkdir(cacheDir, { recursive: true });
    const url = `https://github.com/duckdb/duckdb/releases/download/v${version}/${asset}`;
    console.log(`[fetch-duckdb] downloading ${url}`);
    const scratch = await mkdtemp(join(tmpdir(), 'gezel-duckdb-fetch-'));
    const tmpArchive = join(scratch, asset);
    try {
      await downloadTo(url, tmpArchive);
      const actual = await sha256File(tmpArchive);
      if (actual !== archiveSha) {
        throw new Error(
          `[fetch-duckdb] archive sha256 mismatch for ${key} v${version}: expected ${archiveSha}, got ${actual}`,
        );
      }
      // The CLI archive holds a single `duckdb` at its root, but match by
      // name so an upstream layout change fails loudly rather than staging
      // an empty bundle.
      const data = readZipEntry(await readFile(tmpArchive), outName);
      if (!data) {
        throw new Error(`[fetch-duckdb] no '${outName}' inside ${asset}`);
      }
      await writeFile(cacheBinary, data);
    } finally {
      await removeTree(scratch);
    }
    // The binary digest is the one that matters downstream: the bundle ships
    // the extracted executable with no archive around it, so this is what the
    // supervisor's install step and sha256.txt can both be checked against.
    const stagedSha = await sha256File(cacheBinary);
    if (stagedSha !== binarySha) {
      throw new Error(
        `[fetch-duckdb] binary sha256 mismatch for ${key} v${version}: expected ${binarySha}, got ${stagedSha}`,
      );
    }
    if (platform !== 'win32') await chmod(cacheBinary, 0o755);
    await writeFile(cacheVersion, `${version}\n`, 'utf8');
    console.log(`[fetch-duckdb] cached ${cacheBinary} (v${version}, sha256 verified)`);
  }

  // DuckDB's MIT license, fetched at the pinned commit so the text tracks the
  // exact tree we redistribute.
  const cachedLicense = await stat(cacheLicense).catch(() => null);
  const licenseValid =
    cachedLicense?.isFile() &&
    cachedLicense.size > 0 &&
    (await sha256File(cacheLicense)) === licenseSha;
  if (!licenseValid) {
    const licenseUrl = `https://raw.githubusercontent.com/duckdb/duckdb/${commit}/LICENSE`;
    console.log(`[fetch-duckdb] downloading ${licenseUrl}`);
    await downloadTo(licenseUrl, cacheLicense);
    const actual = await sha256File(cacheLicense);
    if (actual !== licenseSha) {
      throw new Error(
        `[fetch-duckdb] license sha256 mismatch at ${commit}: expected ${licenseSha}, got ${actual}`,
      );
    }
  }

  // ── Step 2: stage cache → dist on every build ───────────────────
  await removeTree(distDir);
  await mkdir(distDir, { recursive: true });
  await copyFile(cacheBinary, join(distDir, outName));
  await copyFile(cacheLicense, join(distDir, 'LICENSE.txt'));
  if (process.platform !== 'win32') await chmod(join(distDir, outName), 0o755);
  await writeFile(join(distDir, 'version.txt'), `${version}\n`, 'utf8');
  await writeFile(join(distDir, 'sha256.txt'), `${binarySha}  ${outName}\n`, 'utf8');
  console.log(`[fetch-duckdb] staged ${join(distDir, outName)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
