#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Download the pinned ordinary pnpm npm package, verify its tarball and
 * embedded license, and stage the extracted JavaScript runtime at
 * `packages/app/dist/pnpm-bundle/`.
 *
 * Gezel launches `bin/pnpm.mjs` with its separately bundled Node runtime
 * on Windows, macOS, and Linux. No pnpm standalone executable is shipped.
 *
 * Called from the app's tsup build. The verified package is cached outside
 * `dist/`, which tsup cleans on every build.
 *
 * Environment:
 *   GEZEL_PNPM_SKIP=1 — skip the download entirely (dev mode; callers
 *                       fall back to system pnpm).
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extractTar } from 'tar';

import { pruneForeignBinariesWithReport } from '../../../scripts/prune-foreign-binaries.mjs';

// See fetch-node.mjs: Node's default 250ms per-address connect timeout
// is too aggressive for Windows→Cloudflare TCP handshakes.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

async function importPinned() {
  // Read the pins directly so we do not need a compile step first.
  const src = await readFile(join(appRoot, 'src', 'pnpm-version.ts'), 'utf8');
  const versionMatch = src.match(/PNPM_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!versionMatch) throw new Error('cannot parse PNPM_VERSION');
  const packageShaMatch = src.match(/PNPM_PACKAGE_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/);
  if (!packageShaMatch) throw new Error('cannot parse PNPM_PACKAGE_SHA256');
  const licenseShaMatch = src.match(/PNPM_LICENSE_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/);
  if (!licenseShaMatch) throw new Error('cannot parse PNPM_LICENSE_SHA256');
  return {
    version: versionMatch[1],
    packageSha: packageShaMatch[1].toLowerCase(),
    licenseSha: licenseShaMatch[1].toLowerCase(),
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function downloadBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true;
}

async function main() {
  if (process.env.GEZEL_PNPM_SKIP === '1') {
    console.log('[fetch-pnpm] GEZEL_PNPM_SKIP=1 — skipping bundle.');
    return;
  }

  const { version, packageSha, licenseSha } = await importPinned();
  if (/^0+$/.test(packageSha) || /^0+$/.test(licenseSha)) {
    throw new Error(
      `[fetch-pnpm] pnpm-version.ts has a placeholder sha. Run \`node scripts/bump-pnpm.mjs ${version}\` to populate it, or set GEZEL_PNPM_SKIP=1 to skip the bundle for this build.`,
    );
  }

  const cacheDir = resolve(appRoot, '.cache', 'native-runtime', 'pnpm-bundle');
  const cacheEntry = join(cacheDir, 'bin', 'pnpm.mjs');
  const cacheRuntime = join(cacheDir, 'dist', 'pnpm.mjs');
  const cacheVersion = join(cacheDir, 'version.txt');
  const cachePackageSha = join(cacheDir, 'package.sha256');
  const cacheLicense = join(cacheDir, 'LICENSE.txt');
  const distDir = resolve(appRoot, 'dist', 'pnpm-bundle');

  let cacheValid = false;
  try {
    cacheValid =
      (await isFile(cacheEntry)) &&
      (await isFile(cacheRuntime)) &&
      (await readFile(cacheVersion, 'utf8')).trim() === version &&
      (await readFile(cachePackageSha, 'utf8')).trim() === packageSha &&
      (await sha256File(cacheLicense)) === licenseSha;
  } catch {
    /* no valid existing cache */
  }

  if (cacheValid) {
    console.log(`[fetch-pnpm] pnpm v${version} already cached at ${cacheDir}`);
  } else {
    const packageUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
    console.log(`[fetch-pnpm] downloading ${packageUrl}`);
    const archive = await downloadBytes(packageUrl);
    const actualPackageSha = createHash('sha256').update(archive).digest('hex');
    if (actualPackageSha !== packageSha) {
      throw new Error(
        `[fetch-pnpm] package sha256 mismatch for v${version}: expected ${packageSha}, got ${actualPackageSha}`,
      );
    }

    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
    const archivePath = join(cacheDir, 'package.tgz');
    await writeFile(archivePath, archive);
    await extractTar({ file: archivePath, cwd: cacheDir, strip: 1 });
    await rm(archivePath, { force: true });

    const metadata = JSON.parse(await readFile(join(cacheDir, 'package.json'), 'utf8'));
    if (metadata.name !== 'pnpm' || metadata.version !== version) {
      throw new Error(
        `[fetch-pnpm] extracted package identity mismatch: expected pnpm@${version}, got ${metadata.name}@${metadata.version}`,
      );
    }
    if (!(await isFile(cacheEntry)) || !(await isFile(cacheRuntime))) {
      throw new Error('[fetch-pnpm] extracted package is missing bin/pnpm.mjs or dist/pnpm.mjs');
    }

    const embeddedLicense = join(cacheDir, 'LICENSE');
    const actualLicenseSha = await sha256File(embeddedLicense);
    if (actualLicenseSha !== licenseSha) {
      throw new Error(
        `[fetch-pnpm] license sha256 mismatch for v${version}: expected ${licenseSha}, got ${actualLicenseSha}`,
      );
    }
    const licenseText = await readFile(embeddedLicense, 'utf8');
    if (!licenseText.includes('MIT License')) {
      throw new Error('[fetch-pnpm] embedded package license did not contain the expected terms');
    }

    // The ordinary package includes standalone-executable build artifacts
    // that are not used by the JavaScript CLI and would duplicate ~18 MB.
    await rm(join(cacheDir, 'artifacts'), { recursive: true, force: true });
    await cp(embeddedLicense, cacheLicense);
    await writeFile(cacheVersion, `${version}\n`, 'utf8');
    await writeFile(cachePackageSha, `${packageSha}\n`, 'utf8');
    console.log(`[fetch-pnpm] cached pnpm v${version} (package + license sha256 verified)`);
  }

  // Stage cache → dist on every build.
  await rm(distDir, { recursive: true, force: true });
  await cp(cacheDir, distDir, { recursive: true });
  await pruneForeignBinariesWithReport(distDir);
  await writeFile(join(distDir, 'version.txt'), `${version}\n`, 'utf8');

  // The supervisor re-hashes both load-bearing JavaScript entrypoints
  // before installing the bundle into the Gezel home.
  const manifest = [
    `${await sha256File(join(distDir, 'bin', 'pnpm.mjs'))}  bin/pnpm.mjs`,
    `${await sha256File(join(distDir, 'dist', 'pnpm.mjs'))}  dist/pnpm.mjs`,
  ];
  await writeFile(join(distDir, 'sha256.txt'), `${manifest.join('\n')}\n`, 'utf8');
  console.log(`[fetch-pnpm] staged ${join(distDir, 'bin', 'pnpm.mjs')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
