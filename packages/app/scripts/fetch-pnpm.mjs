#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Download the pinned pnpm binary for the current build's platform, verify
 * its sha256 against `packages/app/src/pnpm-version.ts`, and write it plus
 * pnpm's matching redistribution terms to `packages/app/dist/pnpm-bundle/`
 * so Electron can ship both asar-unpacked.
 *
 * Called from the app's tsup build. Idempotent: if the binary is already
 * on disk with the right sha, does nothing.
 *
 * Environment:
 *   GEZEL_PNPM_TARGET_PLATFORM — override node's process.platform (for CI).
 *   GEZEL_PNPM_TARGET_ARCH     — override node's process.arch.
 *   GEZEL_PNPM_SKIP=1          — skip the download entirely (dev mode;
 *                                callers fall back to system pnpm).
 */
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { x as extractTar } from 'tar';

// See fetch-node.mjs: Node's default 250ms per-address connect timeout
// is too aggressive for Windows→Cloudflare TCP handshakes, causing
// fetch to fail in ~550ms even though the network is fine.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

async function importPinned() {
  // Read the pins directly so we don't need a compile step first.
  const src = await readFile(join(appRoot, 'src', 'pnpm-version.ts'), 'utf8');
  const versionMatch = src.match(/PNPM_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!versionMatch) throw new Error('cannot parse PNPM_VERSION');
  const licenseShaMatch = src.match(/PNPM_LICENSE_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/);
  if (!licenseShaMatch) throw new Error('cannot parse PNPM_LICENSE_SHA256');
  const runtimeShaMatch = src.match(/PNPM_RUNTIME_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/);
  if (!runtimeShaMatch) throw new Error('cannot parse PNPM_RUNTIME_SHA256');
  const shaBlock = src.match(/PNPM_SHA256[^{]*\{([\s\S]*?)\}/);
  if (!shaBlock) throw new Error('cannot parse PNPM_SHA256');
  const shas = {};
  for (const line of shaBlock[1].split('\n')) {
    const m = line.match(/^\s*['"]([^'"]+)['"]\s*:\s*['"]([0-9a-fA-F]{64})['"]/);
    if (m) shas[m[1]] = m[2].toLowerCase();
  }
  return {
    version: versionMatch[1],
    licenseSha: licenseShaMatch[1].toLowerCase(),
    runtimeSha: runtimeShaMatch[1].toLowerCase(),
    shas,
  };
}

function releaseKey(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

function platformPackageUrl(key, version) {
  const names = {
    'macos-arm64': 'macos-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win-x64': 'win-x64',
  };
  const name = names[key];
  if (!name) throw new Error(`[fetch-pnpm] unsupported platform key: ${key}`);
  return `https://registry.npmjs.org/@pnpm/${name}/-/${name}-${version}.tgz`;
}

function runtimePackageUrl(version) {
  return `https://registry.npmjs.org/@pnpm/exe/-/exe-${version}.tgz`;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function downloadTo(url, dest) {
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
}

async function downloadBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractTarEntry(tgz, wanted) {
  const tar = gunzipSync(tgz);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size)) throw new Error(`invalid tar entry size for ${path}`);
    const start = offset + 512;
    if (path === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`[fetch-pnpm] tar entry ${wanted} was not found`);
}

async function main() {
  if (process.env.GEZEL_PNPM_SKIP === '1') {
    console.log('[fetch-pnpm] GEZEL_PNPM_SKIP=1 — skipping bundle.');
    return;
  }

  const platform = process.env.GEZEL_PNPM_TARGET_PLATFORM ?? process.platform;
  const arch = process.env.GEZEL_PNPM_TARGET_ARCH ?? process.arch;
  const key = releaseKey(platform, arch);
  if (!key) {
    throw new Error(`[fetch-pnpm] unsupported platform/arch: ${platform}/${arch}`);
  }

  const { version, licenseSha, runtimeSha, shas } = await importPinned();
  const expectedSha = shas[key];
  if (!expectedSha || /^0+$/.test(expectedSha)) {
    // Placeholder sha (zeros) is a hard error: an installer shipped with
    // missing shas would silently lose its bundled pnpm and degrade to
    // "fall back to system pnpm" on user machines. Two escape hatches:
    //   - `node scripts/bump-pnpm.mjs <version>` — populate from upstream.
    //   - `GEZEL_PNPM_SKIP=1` — opt out (dev iteration without bumping).
    throw new Error(
      `[fetch-pnpm] pnpm-version.ts has a placeholder sha for ${key}. Run \`node scripts/bump-pnpm.mjs ${version}\` to populate, or set GEZEL_PNPM_SKIP=1 to skip the bundle for this build.`,
    );
  }

  const isWindows = key === 'win-x64';
  // Persistent cache outside `dist/` — see fetch-node.mjs for the
  // detailed why. tsup --clean wipes dist on every build, which would
  // re-download pnpm every time without this.
  const cacheDir = resolve(appRoot, '.cache', 'native-runtime', 'pnpm-bundle');
  const cacheBinary = join(cacheDir, isWindows ? 'pnpm.exe' : 'pnpm');
  const cacheVersion = join(cacheDir, 'version.txt');
  const cacheRuntimeSha = join(cacheDir, 'runtime.sha256');
  const cacheLicense = join(cacheDir, 'LICENSE.txt');
  const distDir = resolve(appRoot, 'dist', 'pnpm-bundle');
  const distBinary = join(distDir, isWindows ? 'pnpm.exe' : 'pnpm');
  const distVersion = join(distDir, 'version.txt');
  const distLicense = join(distDir, 'LICENSE.txt');

  // ── Step 1: ensure the cache holds the right version ────────────
  let cacheValid = false;
  let cachedVersion = '';
  try {
    const cachedBin = await stat(cacheBinary);
    if (cachedBin.isFile()) {
      const currentSha = await sha256File(cacheBinary);
      cachedVersion = await readFile(cacheVersion, 'utf8').catch(() => '');
      const cachedRuntimeSha = await readFile(cacheRuntimeSha, 'utf8').catch(() => '');
      if (
        currentSha === expectedSha &&
        cachedVersion.trim() === version &&
        cachedRuntimeSha.trim() === runtimeSha &&
        (await stat(join(cacheDir, 'dist', 'pnpm.mjs')).catch(() => null))?.isFile()
      ) {
        cacheValid = true;
      }
    }
  } catch {
    /* no existing cache */
  }

  if (cacheValid) {
    console.log(`[fetch-pnpm] ${key} v${version} already cached at ${cacheBinary}`);
  } else {
    const runtimeUrl = runtimePackageUrl(version);
    console.log(`[fetch-pnpm] downloading ${runtimeUrl}`);
    const runtime = await downloadBytes(runtimeUrl);
    const actualRuntimeSha = createHash('sha256').update(runtime).digest('hex');
    if (actualRuntimeSha !== runtimeSha) {
      throw new Error(
        `[fetch-pnpm] runtime sha256 mismatch for v${version}: expected ${runtimeSha}, got ${actualRuntimeSha}`,
      );
    }
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
    const runtimeArchive = join(cacheDir, 'runtime.tgz');
    await writeFile(runtimeArchive, runtime);
    await extractTar({ file: runtimeArchive, cwd: cacheDir, strip: 1 });
    await rm(runtimeArchive, { force: true });
    await writeFile(cacheRuntimeSha, `${runtimeSha}\n`, 'utf8');

    const platformUrl = platformPackageUrl(key, version);
    console.log(`[fetch-pnpm] downloading ${platformUrl}`);
    const binary = extractTarEntry(
      await downloadBytes(platformUrl),
      isWindows ? 'package/pnpm.exe' : 'package/pnpm',
    );
    await writeFile(cacheBinary, binary);
    const actualSha = await sha256File(cacheBinary);
    if (actualSha !== expectedSha) {
      throw new Error(
        `[fetch-pnpm] sha256 mismatch for ${key} v${version}: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    if (!isWindows) await chmod(cacheBinary, 0o755);
    await writeFile(cacheVersion, `${version}\n`, 'utf8');
    console.log(`[fetch-pnpm] cached ${cacheBinary} (v${version}, sha256 verified)`);
  }

  const cachedLicense = await stat(cacheLicense).catch(() => null);
  const licenseValid =
    cachedVersion.trim() === version &&
    cachedLicense?.isFile() &&
    cachedLicense.size > 0 &&
    (await sha256File(cacheLicense)) === licenseSha;
  if (!licenseValid) {
    const licenseUrl = `https://raw.githubusercontent.com/pnpm/pnpm/v${version}/LICENSE`;
    console.log(`[fetch-pnpm] downloading ${licenseUrl}`);
    await downloadTo(licenseUrl, cacheLicense);
    const license = await readFile(cacheLicense, 'utf8');
    if (!license.includes('MIT License')) {
      throw new Error(`[fetch-pnpm] ${licenseUrl} did not contain the expected pnpm terms`);
    }
    const actualLicenseSha = await sha256File(cacheLicense);
    if (actualLicenseSha !== licenseSha) {
      throw new Error(
        `[fetch-pnpm] license sha256 mismatch for v${version}: expected ${licenseSha}, got ${actualLicenseSha}`,
      );
    }
  }

  // ── Step 2: stage cache → dist on every build ───────────────────
  await rm(distDir, { recursive: true, force: true });
  await cp(cacheDir, distDir, { recursive: true });
  await copyFile(cacheLicense, distLicense);
  if (!isWindows) await chmod(distBinary, 0o755);
  await writeFile(distVersion, `${version}\n`, 'utf8');
  // Bundle-local integrity manifest over the two load-bearing files (the
  // launcher binary and the runtime entrypoint; the runtime tree's pin in
  // pnpm-version.ts is tgz-level, which extracted files can't be checked
  // against). The supervisor's extract step re-hashes against this at
  // install time — see extract-pnpm.ts.
  const binName = isWindows ? 'pnpm.exe' : 'pnpm';
  const manifest = [
    `${await sha256File(distBinary)}  ${binName}`,
    `${await sha256File(join(distDir, 'dist', 'pnpm.mjs'))}  dist/pnpm.mjs`,
  ];
  await writeFile(join(distDir, 'sha256.txt'), `${manifest.join('\n')}\n`, 'utf8');
  console.log(`[fetch-pnpm] staged ${distBinary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
