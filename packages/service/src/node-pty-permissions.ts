/**
 * Repair the execute bit npm drops from node-pty's macOS `spawn-helper`.
 *
 * This used to run from the service's `postinstall`. It no longer can: npm
 * 11.16 defers install scripts behind `allowScripts` approval, so on a plain
 * `npm install` the hook never fires — and the same is true under
 * `--ignore-scripts` and the equivalent corporate policies. Repairing lazily,
 * immediately before the first PTY spawn, works on every install path and
 * costs a `stat` once per process. It also let the service drop the only
 * install script in the published set.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('terminal');

export interface FixNodePtyPermissionsOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test seam; production resolves node-pty from this package. */
  nodePtyRoot?: string;
}

/**
 * Restore the execute bit npm drops from node-pty's macOS spawn helper.
 * Returns the number of helpers changed and is safe to run repeatedly.
 */
export function fixNodePtyPermissions(opts: FixNodePtyPermissionsOptions = {}): number {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return 0;

  const arch = opts.arch ?? process.arch;
  const nodePtyRoot = opts.nodePtyRoot ?? resolveNodePtyRoot();
  if (!nodePtyRoot) return 0;

  let fixed = 0;
  for (const helper of [
    join(nodePtyRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper'),
    join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (!existsSync(helper)) continue;
    const current = statSync(helper).mode;
    const wanted = current | 0o111;
    if (current === wanted) continue;
    chmodSync(helper, wanted);
    fixed += 1;
  }
  return fixed;
}

let ensured = false;

export interface EnsureNodePtyExecutableOptions {
  /** Test seam; production repairs the resolved node-pty install. */
  fix?: () => number;
}

/**
 * Run the repair once per process, immediately before the first PTY spawn.
 *
 * Never throws. `node_modules` can be read-only or root-owned (containers,
 * Nix, some CI images), where `chmod` fails with EROFS/EPERM — and a terminal
 * that cannot start is strictly worse than one whose helper was already fine.
 * If the bit really is missing, node-pty raises its own spawn error and this
 * debug line is the breadcrumb explaining why we could not fix it.
 */
export function ensureNodePtyExecutable(opts: EnsureNodePtyExecutableOptions = {}): void {
  if (ensured) return;
  ensured = true;
  try {
    const fixed = (opts.fix ?? fixNodePtyPermissions)();
    if (fixed > 0) log.info(`restored execute permission on ${fixed} node-pty spawn-helper`);
  } catch (err) {
    log.debug(
      `could not adjust node-pty spawn-helper permissions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test seam — the memo is process-wide and would leak across cases. */
export function resetNodePtyExecutableMemo(): void {
  ensured = false;
}

function resolveNodePtyRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve('node-pty/package.json'));
  } catch {
    // A source-only install, or an install made with native dependencies
    // omitted. node-pty itself cannot run there, so there is nothing to fix.
    return null;
  }
}
