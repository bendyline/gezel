/**
 * fetch-mxc.mjs — stage Microsoft's MXC launcher into the Windows bundle.
 *
 * `wxc-exec.exe` is the standalone launcher for Microsoft eXecution
 * Containers, the boundary sandboxed scripts run inside on Windows. It is
 * vendored, not built: Microsoft publishes it Authenticode-signed inside the
 * `@microsoft/mxc-sdk` npm package, and Gezel ships those exact bytes. That is
 * the DuckDB rule (see fetch-duckdb.mjs) — re-signing a vendor binary replaces
 * their attestation with ours, which is why third-party-binaries.cjs exempts
 * this file from the afterPack signing sweep.
 *
 * Only the launcher and the package license are taken from the tarball; the
 * launcher needs nothing else from it.
 *
 * Emits `packages/app/dist/mxc-bundle/` on Windows targets only:
 *   wxc-exec.exe   the vendor binary for the target arch, byte-identical
 *   version.txt    the pinned version, read by the supervisor's installer
 *   LICENSE.txt    the package's MIT license
 *   sha256.txt     bundle-local integrity manifest (see bundle-manifest.ts)
 *
 * Env:
 *   GEZEL_MXC_SKIP=1              omit the bundle (dev iteration)
 *   GEZEL_MXC_TARGET_PLATFORM     cross-stage for another platform
 *   GEZEL_MXC_TARGET_ARCH
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extractTar } from 'tar';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..');
const DOWNLOAD_ATTEMPTS = 3;
const EXECUTOR = 'wxc-exec.exe';
const PACKAGE_NAME = '@microsoft/mxc-sdk';

async function removeTree(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 2,
    retryDelay: 100,
  });
}

/**
 * Read the pin out of core's TypeScript source rather than core's build
 * output, so this runs before (or without) a core build — same reason
 * fetch-duckdb.mjs does.
 */
async function importPinned() {
  const src = await readFile(
    join(repoRoot, 'packages', 'core', 'src', 'native', 'mxc-pin.ts'),
    'utf8',
  );
  const one = (name) => {
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*['"]([^'"]+)['"]`));
    if (!m) throw new Error(`[fetch-mxc] cannot parse ${name}`);
    return m[1];
  };
  const block = src.match(/export const MXC_EXECUTOR_SHA256[^{]*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error('[fetch-mxc] cannot parse MXC_EXECUTOR_SHA256');
  const executorShas = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*['"]?([\w-]+)['"]?\s*:\s*['"]([0-9a-fA-F]{64})['"]/);
    if (m) executorShas[m[1]] = m[2].toLowerCase();
  }
  if (Object.keys(executorShas).length === 0) {
    throw new Error('[fetch-mxc] MXC_EXECUTOR_SHA256 parsed empty');
  }
  return {
    version: one('MXC_VERSION'),
    tarballUrl: one('MXC_TARBALL_URL'),
    integrity: one('MXC_TARBALL_INTEGRITY'),
    tarballSha: one('MXC_TARBALL_SHA256').toLowerCase(),
    licenseSha: one('MXC_LICENSE_SHA256').toLowerCase(),
    executorShas,
  };
}

function mxcArchFor(arch) {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return null;
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function downloadBytes(url) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt === DOWNLOAD_ATTEMPTS) break;
      const delayMs = 500 * 2 ** (attempt - 1);
      console.warn(`[fetch-mxc] ${err}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true;
}

async function main() {
  const distDir = resolve(appRoot, 'dist', 'mxc-bundle');
  if (process.env.GEZEL_MXC_SKIP === '1') {
    await removeTree(distDir);
    console.log('[fetch-mxc] GEZEL_MXC_SKIP=1 — skipping bundle.');
    return;
  }

  const platform = process.env.GEZEL_MXC_TARGET_PLATFORM ?? process.platform;
  const arch = mxcArchFor(process.env.GEZEL_MXC_TARGET_ARCH ?? process.arch);
  if (platform !== 'win32' || !arch) {
    await removeTree(distDir);
    console.log(`[fetch-mxc] MXC is Windows-only; nothing to stage for ${platform}.`);
    return;
  }

  const { version, tarballUrl, integrity, tarballSha, licenseSha, executorShas } =
    await importPinned();
  const executorSha = executorShas[arch];
  const placeholder = (sha) => !sha || /^0+$/.test(sha);
  if ([tarballSha, licenseSha, executorSha].some(placeholder) || !integrity.startsWith('sha512-')) {
    throw new Error(
      `[fetch-mxc] mxc-pin.ts has a placeholder pin for ${arch}. Run \`node scripts/bump-mxc.mjs ${version}\`, or set GEZEL_MXC_SKIP=1 to skip the bundle for this build.`,
    );
  }

  // Persistent cache outside dist/ — tsup --clean wipes dist every build.
  const cacheDir = resolve(appRoot, '.cache', 'native-runtime', 'mxc-bundle', arch);
  const cacheExecutor = join(cacheDir, EXECUTOR);
  const cacheLicense = join(cacheDir, 'LICENSE.txt');
  const cacheVersion = join(cacheDir, 'version.txt');

  let cacheValid = false;
  try {
    cacheValid =
      (await isFile(cacheExecutor)) &&
      (await readFile(cacheVersion, 'utf8')).trim() === version &&
      (await sha256File(cacheExecutor)) === executorSha &&
      (await sha256File(cacheLicense)) === licenseSha;
  } catch {
    cacheValid = false;
  }

  if (cacheValid) {
    console.log(`[fetch-mxc] ${arch} v${version} already cached at ${cacheExecutor}`);
  } else {
    console.log(`[fetch-mxc] downloading ${tarballUrl}`);
    const tarball = await downloadBytes(tarballUrl);
    const actualIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (actualIntegrity !== integrity) {
      throw new Error(
        `[fetch-mxc] tarball integrity mismatch for v${version}: expected ${integrity}, got ${actualIntegrity}`,
      );
    }
    const actualTarballSha = createHash('sha256').update(tarball).digest('hex');
    if (actualTarballSha !== tarballSha) {
      throw new Error(
        `[fetch-mxc] tarball sha256 mismatch for v${version}: expected ${tarballSha}, got ${actualTarballSha}`,
      );
    }

    const scratch = await mkdtemp(join(tmpdir(), 'gezel-mxc-fetch-'));
    try {
      const tarballPath = join(scratch, 'package.tgz');
      const extractDir = join(scratch, 'x');
      await writeFile(tarballPath, tarball);
      await mkdir(extractDir, { recursive: true });
      const executorEntry = `package/bin/${arch}/${EXECUTOR}`;
      await extractTar({ file: tarballPath, cwd: extractDir, strict: true }, [
        executorEntry,
        'package/LICENSE.md',
        'package/package.json',
      ]);

      const metadata = JSON.parse(
        await readFile(join(extractDir, 'package', 'package.json'), 'utf8'),
      );
      if (metadata.name !== PACKAGE_NAME || metadata.version !== version) {
        throw new Error(
          `[fetch-mxc] extracted package identity mismatch: expected ${PACKAGE_NAME}@${version}, got ${metadata.name}@${metadata.version}`,
        );
      }
      const extractedExecutor = join(extractDir, ...executorEntry.split('/'));
      if (!(await isFile(extractedExecutor))) {
        throw new Error(`[fetch-mxc] no ${executorEntry} inside ${tarballUrl}`);
      }
      const actualExecutorSha = await sha256File(extractedExecutor);
      if (actualExecutorSha !== executorSha) {
        throw new Error(
          `[fetch-mxc] ${EXECUTOR} sha256 mismatch for ${arch} v${version}: expected ${executorSha}, got ${actualExecutorSha}`,
        );
      }
      const extractedLicense = join(extractDir, 'package', 'LICENSE.md');
      const actualLicenseSha = await sha256File(extractedLicense);
      if (actualLicenseSha !== licenseSha) {
        throw new Error(
          `[fetch-mxc] license sha256 mismatch for v${version}: expected ${licenseSha}, got ${actualLicenseSha}`,
        );
      }

      await removeTree(cacheDir);
      await mkdir(cacheDir, { recursive: true });
      await copyFile(extractedExecutor, cacheExecutor);
      await copyFile(extractedLicense, cacheLicense);
      await writeFile(cacheVersion, `${version}\n`, 'utf8');
    } finally {
      await removeTree(scratch);
    }
    console.log(`[fetch-mxc] cached ${cacheExecutor} (v${version}, sha256 verified)`);
  }

  await removeTree(distDir);
  await mkdir(distDir, { recursive: true });
  await copyFile(cacheExecutor, join(distDir, EXECUTOR));
  await copyFile(cacheLicense, join(distDir, 'LICENSE.txt'));
  const stagedSha = await sha256File(join(distDir, EXECUTOR));
  if (stagedSha !== executorSha) {
    throw new Error(`[fetch-mxc] staged ${EXECUTOR} differs from the pin after copy`);
  }
  await writeFile(join(distDir, 'version.txt'), `${version}\n`, 'utf8');
  await writeFile(join(distDir, 'sha256.txt'), `${executorSha}  ${EXECUTOR}\n`, 'utf8');
  console.log(`[fetch-mxc] staged ${join(distDir, EXECUTOR)} (${arch})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
