import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File, verifyBundleManifest } from './bundle-manifest.js';
import { redirectAsarToUnpacked } from './extract-bundle.js';

export interface NodeInstallOptions {
  /** User home root — binary lands at `<home>/bin/node[.exe]`. */
  home: string;
  /** Source directory (electron app's `dist/node-bundle/`). */
  bundleDir: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface NodeInstallResult {
  /** Absolute path to the installed binary, or null when no bundle was shipped. */
  binaryPath: string | null;
  /** Shipped version from bundle's `version.txt`, or null when absent. */
  version: string | null;
  action: 'fresh-install' | 'upgraded' | 'refreshed' | 'up-to-date' | 'no-bundle';
  /** True only when the shipped manifest authenticated the installed bytes. */
  verified: boolean;
}

/**
 * Resolve the node bundle's source directory, mirroring
 * `defaultPnpmBundleDir` in extract-pnpm.ts. Dev:
 * `packages/app/dist/node-bundle/`. Packaged:
 * `app.asar.unpacked/dist/node-bundle/`.
 */
export function defaultNodeBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return redirectAsarToUnpacked(resolve(mainDir, 'node-bundle'));
}

/**
 * Copy the bundled Node.js binary (if one shipped) into `<home>/bin/`
 * on first launch, or upgrade it when a newer bundle lands with a
 * later Gezel release. A missing bundle (dev, or `GEZEL_NODE_SKIP=1`
 * at build time) is not fatal — returns `no-bundle`. Packaged callers
 * must fail closed; development callers may explicitly fall back to PATH.
 */
export async function installNodeIfNeeded(opts: NodeInstallOptions): Promise<NodeInstallResult> {
  const { home, bundleDir, logger } = opts;

  if (!existsSync(bundleDir)) {
    logger?.info?.(`[supervisor] no node bundle at ${bundleDir}`);
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'node.exe' : 'node';
  const versionFilePath = join(bundleDir, 'version.txt');
  const bundleBinary = join(bundleDir, binaryName);

  // If fetch-node wrote no binary (placeholder shas / skipped), be honest:
  // there's nothing to install.
  if (!existsSync(bundleBinary) || !existsSync(versionFilePath)) {
    logger?.info?.('[supervisor] node bundle dir exists but no binary inside (placeholder)');
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const shippedVersion = (await readFile(versionFilePath, 'utf8')).trim();
  const installDir = join(home, 'bin');
  const installedBinary = join(installDir, binaryName);
  const installedVersionFile = join(installDir, 'node.version');

  let installedVersion: string | null = null;
  try {
    installedVersion = (await readFile(installedVersionFile, 'utf8')).trim();
  } catch {
    /* fresh install */
  }

  // Re-hash the bundled binary against the bundle's sha256.txt (written
  // by fetch-node.mjs) before trusting either a new copy or the existing
  // installed binary. The old version-only fast path let modified bytes
  // survive indefinitely behind a matching node.version marker.
  const integrity = await verifyBundleManifest(bundleDir, [binaryName]);
  if (!integrity.ok) {
    logger?.warn?.(
      `[supervisor] node bundle failed integrity check (${integrity.reason}); refusing to install`,
    );
    return { binaryPath: null, version: null, action: 'no-bundle', verified: false };
  }

  const bundleDigest = await sha256File(bundleBinary);
  if (installedVersion === shippedVersion && existsSync(installedBinary)) {
    const installedFile = await lstat(installedBinary);
    const installedDigest = installedFile.isFile() ? await sha256File(installedBinary) : null;
    if (installedDigest === bundleDigest) {
      return {
        binaryPath: installedBinary,
        version: installedVersion,
        action: 'up-to-date',
        verified: !integrity.skipped,
      };
    }
    logger?.warn?.(
      `[supervisor] installed bundled node v${shippedVersion} failed byte verification; refreshing it from the shipped bundle`,
    );
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    installedVersion === shippedVersion
      ? `[supervisor] refreshing bundled node v${shippedVersion}`
      : installedVersion
        ? `[supervisor] upgrading bundled node ${installedVersion} → ${shippedVersion}`
        : `[supervisor] installing bundled node v${shippedVersion}`,
  );
  const stagingBinary = `${installedBinary}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingBinary, { force: true });
  await cp(bundleBinary, stagingBinary, { force: true });
  if (!isWindows) {
    try {
      await chmod(stagingBinary, 0o755);
    } catch {
      /* best-effort */
    }
  }

  // Verify a same-directory staging file before replacing the active runtime.
  // Removing the exact destination before rename also prevents copyFile from
  // following a corrupt or user-created destination symlink.
  const staged = await stat(stagingBinary);
  const stagedDigest = staged.isFile() ? await sha256File(stagingBinary) : null;
  if (!staged.isFile() || stagedDigest !== bundleDigest) {
    await rm(stagingBinary, { force: true });
    await rm(installedVersionFile, { force: true });
    throw new Error(
      `[supervisor] staged-copy verify failed: ${stagingBinary} is missing or its bytes differ from the authenticated bundle`,
    );
  }
  await rm(installedBinary, { recursive: true, force: true });
  await rename(stagingBinary, installedBinary);
  await writeFile(installedVersionFile, `${shippedVersion}\n`, 'utf8');

  const installedDigest = await sha256File(installedBinary);
  if (installedDigest !== bundleDigest) {
    await rm(installedBinary, { force: true });
    await rm(installedVersionFile, { force: true });
    throw new Error(
      `[supervisor] post-install verify failed: ${installedBinary} differs from the authenticated bundle`,
    );
  }

  return {
    binaryPath: installedBinary,
    version: shippedVersion,
    action:
      installedVersion === shippedVersion
        ? 'refreshed'
        : installedVersion
          ? 'upgraded'
          : 'fresh-install',
    verified: !integrity.skipped,
  };
}
