import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundleManifest } from './bundle-manifest.js';
import { redirectAsarToUnpacked } from './extract-bundle.js';

export interface PnpmInstallOptions {
  /** User home root — runtime lands at `<home>/bin/pnpm-runtime/`. */
  home: string;
  /** Source directory (electron app's `dist/pnpm-bundle/`). */
  bundleDir: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface PnpmInstallResult {
  /** Absolute path to the installed JS entrypoint, or null when no bundle was shipped. */
  entryPath: string | null;
  /** Shipped version from bundle's `version.txt`, or null when absent. */
  version: string | null;
  action: 'fresh-install' | 'upgraded' | 'up-to-date' | 'no-bundle';
  /** True only when the shipped manifest authenticated the installed files. */
  verified: boolean;
}

/**
 * Resolve the pnpm bundle's source directory, mirroring `defaultBundleDir`
 * in extract-bundle.ts. Dev: `packages/app/dist/pnpm-bundle/`. Packaged:
 * `app.asar.unpacked/dist/pnpm-bundle/`.
 */
export function defaultPnpmBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return redirectAsarToUnpacked(resolve(mainDir, 'pnpm-bundle'));
}

/**
 * Copy the bundled ordinary pnpm package (if one shipped) into
 * `<home>/bin/pnpm-runtime/` on first launch, or upgrade it when a newer
 * bundle lands with a later Gezel release. The JavaScript entrypoint is
 * invoked with Gezel's bundled Node runtime on every packaged platform.
 * A missing bundle is not fatal. Packaged callers fail closed; development
 * callers may explicitly fall back to pnpm on PATH.
 */
export async function installPnpmIfNeeded(opts: PnpmInstallOptions): Promise<PnpmInstallResult> {
  const { home, bundleDir, logger } = opts;

  if (!existsSync(bundleDir)) {
    logger?.info?.(`[supervisor] no pnpm bundle at ${bundleDir}`);
    return { entryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const versionFilePath = join(bundleDir, 'version.txt');
  const bundleEntry = join(bundleDir, 'bin', 'pnpm.mjs');
  const bundleRuntime = join(bundleDir, 'dist', 'pnpm.mjs');
  const bundleWorker = join(bundleDir, 'dist', 'worker.js');
  const bundleReflinkCompat = join(bundleDir, 'dist', 'gezel-reflink-compat.cjs');
  const bundleManifest = join(bundleDir, 'sha256.txt');

  if (
    !existsSync(bundleEntry) ||
    !existsSync(bundleRuntime) ||
    !existsSync(bundleWorker) ||
    !existsSync(bundleReflinkCompat) ||
    !existsSync(versionFilePath)
  ) {
    logger?.info?.('[supervisor] pnpm bundle dir exists but is incomplete');
    return { entryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const shippedVersion = (await readFile(versionFilePath, 'utf8')).trim();
  const installDir = join(home, 'bin');
  const installedRuntimeDir = join(installDir, 'pnpm-runtime');
  const installedEntry = join(installedRuntimeDir, 'bin', 'pnpm.mjs');
  const installedVersionFile = join(installDir, 'pnpm.version');
  const installedManifestFile = join(installDir, 'pnpm.sha256');

  let installedVersion: string | null = null;
  try {
    installedVersion = (await readFile(installedVersionFile, 'utf8')).trim();
  } catch {
    /* fresh install */
  }
  const shippedManifest = existsSync(bundleManifest)
    ? (await readFile(bundleManifest, 'utf8')).trim()
    : null;
  let installedManifest: string | null = null;
  try {
    installedManifest = (await readFile(installedManifestFile, 'utf8')).trim();
  } catch {
    /* older or development install */
  }

  const requiredFiles = [
    'bin/pnpm.mjs',
    'dist/pnpm.mjs',
    'dist/worker.js',
    'dist/gezel-reflink-compat.cjs',
  ];

  // Validate the source before the up-to-date shortcut. A version and copied
  // manifest marker alone cannot authenticate installed files that changed
  // after the first launch.
  const integrity = await verifyBundleManifest(bundleDir, requiredFiles);
  if (!integrity.ok) {
    logger?.warn?.(
      `[supervisor] pnpm bundle failed integrity check (${integrity.reason}); refusing to install`,
    );
    return { entryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const installedRuntimeManifest = existsSync(join(installedRuntimeDir, 'sha256.txt'))
    ? (await readFile(join(installedRuntimeDir, 'sha256.txt'), 'utf8')).trim()
    : null;
  const installedIntegrity =
    shippedManifest !== null &&
    installedManifest === shippedManifest &&
    installedRuntimeManifest === shippedManifest
      ? await verifyBundleManifest(installedRuntimeDir, requiredFiles)
      : null;

  if (
    installedVersion === shippedVersion &&
    existsSync(installedEntry) &&
    existsSync(join(installedRuntimeDir, 'dist', 'pnpm.mjs')) &&
    existsSync(join(installedRuntimeDir, 'dist', 'worker.js')) &&
    existsSync(join(installedRuntimeDir, 'dist', 'gezel-reflink-compat.cjs')) &&
    (shippedManifest === null || installedIntegrity?.ok === true)
  ) {
    return {
      entryPath: installedEntry,
      version: installedVersion,
      action: 'up-to-date',
      verified: !integrity.skipped,
    };
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    installedVersion === shippedVersion
      ? `[supervisor] refreshing bundled pnpm v${shippedVersion} (bundle revision changed)`
      : installedVersion
        ? `[supervisor] upgrading bundled pnpm ${installedVersion} → ${shippedVersion}`
        : `[supervisor] installing bundled pnpm v${shippedVersion}`,
  );
  const stagingDir = `${installedRuntimeDir}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingDir, { recursive: true, force: true });
  await cp(bundleDir, stagingDir, { recursive: true });
  await rm(installedRuntimeDir, { recursive: true, force: true });
  await rename(stagingDir, installedRuntimeDir);
  await writeFile(installedVersionFile, `${shippedVersion}\n`, 'utf8');
  if (shippedManifest !== null) {
    await writeFile(installedManifestFile, `${shippedManifest}\n`, 'utf8');
  } else {
    await rm(installedManifestFile, { force: true });
  }

  // Sanity: verify the copy actually exists.
  const st = await stat(installedEntry);
  if (!st.isFile()) {
    throw new Error(`[supervisor] post-copy verify failed: ${installedEntry} missing`);
  }
  const copiedIntegrity = await verifyBundleManifest(installedRuntimeDir, requiredFiles);
  if (!copiedIntegrity.ok || copiedIntegrity.skipped !== integrity.skipped) {
    await rm(installedRuntimeDir, { recursive: true, force: true });
    await rm(installedVersionFile, { force: true });
    await rm(installedManifestFile, { force: true });
    throw new Error(
      `[supervisor] post-copy verify failed: ${copiedIntegrity.reason ?? 'pnpm manifest state changed during installation'}`,
    );
  }

  return {
    entryPath: installedEntry,
    version: shippedVersion,
    action: installedVersion ? 'upgraded' : 'fresh-install',
    verified: !integrity.skipped,
  };
}
