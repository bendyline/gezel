import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  action: 'fresh-install' | 'upgraded' | 'up-to-date' | 'no-bundle';
}

/**
 * Resolve the node bundle's source directory, mirroring
 * `defaultPnpmBundleDir` in extract-pnpm.ts. Dev:
 * `packages/app/dist/node-bundle/`. Packaged:
 * `app.asar.unpacked/dist/node-bundle/`.
 */
export function defaultNodeBundleDir(mainMetaUrl: string): string {
  const mainDir = dirname(fileURLToPath(mainMetaUrl));
  return resolve(mainDir, 'node-bundle');
}

/**
 * Copy the bundled Node.js binary (if one shipped) into `<home>/bin/`
 * on first launch, or upgrade it when a newer bundle lands with a
 * later Gezel release. A missing bundle (dev, or `GEZEL_NODE_SKIP=1`
 * at build time) is not fatal — returns `no-bundle` and the caller
 * falls back to whatever `node` is on PATH.
 */
export async function installNodeIfNeeded(opts: NodeInstallOptions): Promise<NodeInstallResult> {
  const { home, bundleDir, logger } = opts;

  if (!existsSync(bundleDir)) {
    logger?.info?.(`[supervisor] no node bundle at ${bundleDir}; will fall back to system node`);
    return { binaryPath: null, version: null, action: 'no-bundle' };
  }

  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'node.exe' : 'node';
  const versionFilePath = join(bundleDir, 'version.txt');
  const bundleBinary = join(bundleDir, binaryName);

  // If fetch-node wrote no binary (placeholder shas / skipped), be honest:
  // there's nothing to install.
  if (!existsSync(bundleBinary) || !existsSync(versionFilePath)) {
    logger?.info?.(
      '[supervisor] node bundle dir exists but no binary inside (placeholder); falling back to system node',
    );
    return { binaryPath: null, version: null, action: 'no-bundle' };
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

  if (installedVersion === shippedVersion && existsSync(installedBinary)) {
    return {
      binaryPath: installedBinary,
      version: installedVersion,
      action: 'up-to-date',
    };
  }

  await mkdir(installDir, { recursive: true });
  logger?.info?.(
    installedVersion
      ? `[supervisor] upgrading bundled node ${installedVersion} → ${shippedVersion}`
      : `[supervisor] installing bundled node v${shippedVersion}`,
  );
  await cp(bundleBinary, installedBinary, { force: true });
  if (!isWindows) {
    try {
      await chmod(installedBinary, 0o755);
    } catch {
      /* best-effort */
    }
  }
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
