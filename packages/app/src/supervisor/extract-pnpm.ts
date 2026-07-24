import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundleManifest } from './bundle-manifest.js';

export interface PnpmInstallOptions {
  /** User home root — runtime lands at `<home>/bin/pnpm-runtime/`. */
  home: string;
  /** Source directory (electron app's `dist/pnpm-bundle/`). */
  bundleDir: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface PnpmInstallResult {
  /** Absolute path to the installed binary, or null when no bundle was shipped. */
  binaryPath: string | null;
  /** Shipped version from bundle's `version.txt`, or null when absent. */
  version: string | null;
  action: 'fresh-install' | 'upgraded' | 'up-to-date' | 'no-bundle';
}

/**
 * Resolve the pnpm bundle's source directory, mirroring `defaultBundleDir`
 * in extract-bundle.ts. Dev: `packages/app/dist/pnpm-bundle/`. Packaged:
 * `app.asar.unpacked/dist/pnpm-bundle/`.
 */
export function defaultPnpmBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return resolve(mainDir, 'pnpm-bundle');
}

/**
 * Copy the bundled pnpm runtime (if one shipped) into `<home>/bin/pnpm-runtime/` on
 * first launch, or upgrade it when a newer bundle lands with a later
 * Gezel release. A missing bundle (dev, or `GEZEL_PNPM_SKIP=1` at build
 * time) is not fatal — returns `no-bundle` and the caller falls back to
 * whatever `pnpm` is on PATH.
 */
export async function installPnpmIfNeeded(opts: PnpmInstallOptions): Promise<PnpmInstallResult> {
  const { home, bundleDir, logger } = opts;

  if (!existsSync(bundleDir)) {
    logger?.info?.(`[supervisor] no pnpm bundle at ${bundleDir}; will fall back to system pnpm`);
    return { binaryPath: null, version: null, action: 'no-bundle' };
  }

  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'pnpm.exe' : 'pnpm';
  const versionFilePath = join(bundleDir, 'version.txt');
  const bundleBinary = join(bundleDir, binaryName);
  const bundleRuntime = join(bundleDir, 'dist', 'pnpm.mjs');

  // If fetch-pnpm wrote no binary (placeholder shas / skipped), be honest:
  // there's nothing to install.
  if (!existsSync(bundleBinary) || !existsSync(bundleRuntime) || !existsSync(versionFilePath)) {
    logger?.info?.(
      '[supervisor] pnpm bundle dir exists but no binary inside (placeholder); falling back to system pnpm',
    );
    return { binaryPath: null, version: null, action: 'no-bundle' };
  }

  const shippedVersion = (await readFile(versionFilePath, 'utf8')).trim();
  const installDir = join(home, 'bin');
  const installedRuntimeDir = join(installDir, 'pnpm-runtime');
  const installedBinary = join(installedRuntimeDir, binaryName);
  const installedVersionFile = join(installDir, 'pnpm.version');

  let installedVersion: string | null = null;
  try {
    installedVersion = (await readFile(installedVersionFile, 'utf8')).trim();
  } catch {
    /* fresh install */
  }

  if (
    installedVersion === shippedVersion &&
    existsSync(installedBinary) &&
    existsSync(join(installedRuntimeDir, 'dist', 'pnpm.mjs'))
  ) {
    return {
      binaryPath: installedBinary,
      version: installedVersion,
      action: 'up-to-date',
    };
  }

  // Re-hash the load-bearing bundle files against the bundle's
  // sha256.txt (written by fetch-pnpm.mjs) before installing. A
  // corrupted or tampered bundle must not land in <home>/bin — fall
  // back to system pnpm.
  const integrity = await verifyBundleManifest(bundleDir, [binaryName, 'dist/pnpm.mjs']);
  if (!integrity.ok) {
    logger?.warn?.(
      `[supervisor] pnpm bundle failed integrity check (${integrity.reason}); refusing to install — falling back to system pnpm`,
    );
    return { binaryPath: null, version: null, action: 'no-bundle' };
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    installedVersion
      ? `[supervisor] upgrading bundled pnpm ${installedVersion} → ${shippedVersion}`
      : `[supervisor] installing bundled pnpm v${shippedVersion}`,
  );
  const stagingDir = `${installedRuntimeDir}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingDir, { recursive: true, force: true });
  await cp(bundleDir, stagingDir, { recursive: true });
  if (!isWindows) {
    try {
      await chmod(join(stagingDir, binaryName), 0o755);
    } catch {
      /* best-effort */
    }
  }
  await rm(installedRuntimeDir, { recursive: true, force: true });
  await rename(stagingDir, installedRuntimeDir);
  await writeFile(installedVersionFile, `${shippedVersion}\n`, 'utf8');

  // Sanity: verify the copy actually exists.
  const st = await stat(installedBinary);
  if (!st.isFile()) {
    throw new Error(`[supervisor] post-copy verify failed: ${installedBinary} missing`);
  }

  return {
    binaryPath: installedBinary,
    version: shippedVersion,
    action: installedVersion ? 'upgraded' : 'fresh-install',
  };
}
