import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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
