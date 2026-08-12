import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface ManagedScriptRuntimeDeps {
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * Windows Task Scheduler cannot declare per-action environment variables.
 * When the daemon itself was launched by the exact managed Node path, recover
 * the two runtime variables from the pinned Gezel home. macOS launchd and
 * Linux systemd set them explicitly, but this remains an idempotent backstop.
 */
export function discoverManagedScriptRuntimes(
  home: string,
  deps: ManagedScriptRuntimeDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const path = platform === 'win32' ? win32 : posix;
  const managedNode = path.join(home, 'bin', platform === 'win32' ? 'node.exe' : 'node');
  const launchedPath = path.resolve(execPath);
  const expectedPath = path.resolve(managedNode);
  const sameNode =
    platform === 'win32'
      ? launchedPath.toLowerCase() === expectedPath.toLowerCase()
      : launchedPath === expectedPath;
  if (!sameNode || !exists(managedNode)) return;
  env.GEZEL_NODE_PATH ??= managedNode;

  const managedPnpm = path.join(home, 'bin', 'pnpm-runtime', 'bin', 'pnpm.mjs');
  if (exists(managedPnpm)) env.GEZEL_PNPM_PATH ??= managedPnpm;
}
