import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface AutostartRuntimeOptions {
  /** True for a packaged Electron build. Packaged builds never consult PATH. */
  packaged: boolean;
  /** Pinned Gezel home for this Electron launch. */
  home: string;
  /** Runtime authenticated and installed by the supervisor during this launch. */
  bundledNodePath?: string;
  /** pnpm entrypoint authenticated and installed by the supervisor during this launch. */
  bundledPnpmPath?: string;
  /** Test seam; production uses the current platform. */
  platform?: NodeJS.Platform;
  /** Development-only PATH lookup seam. */
  lookupNodeOnPath?: (platform: NodeJS.Platform) => Promise<string | null>;
  /** Filesystem seam for platform-independent tests. */
  statPath?: typeof stat;
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

export function installedNodePath(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathApi(platform).join(home, 'bin', platform === 'win32' ? 'node.exe' : 'node');
}

export function installedPnpmPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathApi(platform).join(home, 'bin', 'pnpm-runtime', 'bin', 'pnpm.mjs');
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

async function assertUsableNode(
  path: string,
  platform: NodeJS.Platform,
  statPath: typeof stat,
): Promise<void> {
  const file = await statPath(path);
  if (!file.isFile()) throw new Error(`${path} is not a file`);
  if (platform !== 'win32' && (file.mode & 0o111) === 0) {
    throw new Error(`${path} is not executable`);
  }
}

async function assertRegularFile(path: string, statPath: typeof stat): Promise<void> {
  const file = await statPath(path);
  if (!file.isFile()) throw new Error(`${path} is not a file`);
}

async function lookupNodeOnPath(platform: NodeJS.Platform): Promise<string | null> {
  const tool = platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(tool, ['node']);
    return (
      stdout
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Select the Node runtime persisted into the OS autostart registration.
 *
 * Packaged builds accept only the exact `<GEZEL_HOME>/bin/node[.exe]` path
 * that the supervisor authenticated and exposed during this launch. This
 * deliberately does not use `which` / `where`: a clean consumer machine is
 * not expected to have a developer Node installation, and an unrelated PATH
 * entry must never replace the release-pinned runtime.
 */
export async function resolveAutostartNodePath(opts: AutostartRuntimeOptions): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const statPath = opts.statPath ?? stat;
  const expectedBundledPath = installedNodePath(opts.home, platform);
  const bundledNodePath = opts.bundledNodePath?.trim();

  if (bundledNodePath) {
    if (opts.packaged && !samePath(bundledNodePath, expectedBundledPath, platform)) {
      throw new Error(
        `Packaged autostart refused an untrusted Node path (${bundledNodePath}); expected the verified bundled runtime at ${expectedBundledPath}.`,
      );
    }
    try {
      await assertUsableNode(bundledNodePath, platform, statPath);
      return bundledNodePath;
    } catch (error) {
      if (opts.packaged) {
        throw new Error(
          `The verified bundled Node runtime is unavailable at ${expectedBundledPath}: ${(error as Error).message}. Restart Gezel to repair it, or reinstall the application.`,
        );
      }
    }
  }

  if (opts.packaged) {
    throw new Error(
      `The verified bundled Node runtime is unavailable at ${expectedBundledPath}. Restart Gezel to repair it, or reinstall the application.`,
    );
  }

  const pathNode = await (opts.lookupNodeOnPath ?? lookupNodeOnPath)(platform);
  if (pathNode) {
    await assertUsableNode(pathNode, platform, statPath);
    return pathNode;
  }
  throw new Error('Node.js was not found in PATH. Development autostart requires Node 20+.');
}

/**
 * Resolve the ordinary pnpm package used by a standalone autostart daemon.
 * Packaged mode requires the supervisor-authenticated entrypoint; development
 * may omit it and let the daemon use its normal PATH fallback.
 */
export async function resolveAutostartPnpmPath(
  opts: AutostartRuntimeOptions,
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const statPath = opts.statPath ?? stat;
  const expectedBundledPath = installedPnpmPath(opts.home, platform);
  const bundledPnpmPath = opts.bundledPnpmPath?.trim();

  if (bundledPnpmPath) {
    if (opts.packaged && !samePath(bundledPnpmPath, expectedBundledPath, platform)) {
      throw new Error(
        `Packaged autostart refused an untrusted pnpm path (${bundledPnpmPath}); expected the verified bundled runtime at ${expectedBundledPath}.`,
      );
    }
    try {
      await assertRegularFile(bundledPnpmPath, statPath);
      return bundledPnpmPath;
    } catch (error) {
      if (opts.packaged) {
        throw new Error(
          `The verified bundled pnpm runtime is unavailable at ${expectedBundledPath}: ${(error as Error).message}. Restart Gezel to repair it, or reinstall the application.`,
        );
      }
    }
  }

  if (opts.packaged) {
    throw new Error(
      `The verified bundled pnpm runtime is unavailable at ${expectedBundledPath}. Restart Gezel to repair it, or reinstall the application.`,
    );
  }
  return undefined;
}
