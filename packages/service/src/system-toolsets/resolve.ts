import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { type PinnedSystemToolset, SYSTEM_TOOLSETS } from './manifest.js';
import { readSystemTracking } from './tracking.js';

/**
 * The on-disk directory name for an installed system-toolset, relative
 * to `systemToolsetsInstallDir(home)`. Shared by the bootstrap (which
 * creates the dir) and the resolver (which reads it back).
 */
export function installDirName(entry: Pick<PinnedSystemToolset, 'pkg' | 'version'>): string {
  const slug = entry.pkg.replace('/', '__');
  return `${slug}@${entry.version}`;
}

/**
 * Locate a `kind: 'library'` system-toolset that's finished installing.
 *
 * Returns the absolute path to the extracted package root (the folder
 * containing the package's own `package.json` + `node_modules`), or
 * `null` if the manifest pin and the tracking record disagree (e.g.,
 * bootstrap hasn't run yet on this launch, a version bump is pending,
 * or the entry is a placeholder that hasn't been assigned a real pin).
 *
 * Pass `withEntry: true` to append the manifest's `entry` path and get
 * a file path that can be passed to `await import(pathToFileURL(...))`.
 *
 * Callers must handle `null` gracefully — on first run, the bootstrap
 * may still be working through its install list.
 */
export async function resolveSystemLibraryPath(
  home: string,
  toolsetId: string,
  opts: { withEntry?: boolean } = {},
): Promise<string | null> {
  const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === toolsetId);
  if (!entry || entry.kind !== 'library') return null;

  const tracking = await readSystemTracking(home);
  const installed = tracking.toolsets[toolsetId];
  if (!installed) return null;
  if (installed.version !== entry.version) return null;
  if (installed.integrity !== entry.integrity) return null;

  const root = join(systemToolsetsInstallDir(home), installDirName(entry), 'package');
  if (!existsSync(root)) return null;

  if (opts.withEntry && entry.entry) {
    return join(root, entry.entry);
  }
  return root;
}
