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

export interface InstalledSystemLibrary {
  /** Package root (or entry path, with `withEntry`) of the version on disk. */
  path: string;
  /** Version per the tracking record — not necessarily the pinned one. */
  version: string;
  /** False when this build pins a version other than the one installed. */
  matchesPin: boolean;
}

/**
 * Version-tolerant sibling of {@link resolveSystemLibraryPath}: returns the
 * install that is actually *on disk*, even when this build pins a newer one.
 *
 * The strict resolver's null-on-mismatch is right for eagerly-installed
 * entries, where the boot bootstrap upgrades before anything asks. For an
 * on-demand entry it would strand every existing user the moment the pin
 * moves: `installDirName` embeds the version, so a bumped pin points at a
 * directory nobody has, and Copilot would report "not installed" until each
 * user reinstalled by hand.
 *
 * An SDK one release behind is strictly better than no SDK — the shapes we
 * consume are hand-declared structural interfaces (see the top of
 * `providers/copilot.ts`), so they don't move with the pin. Callers surface
 * `matchesPin: false` as "update available", never as "not installed".
 */
export async function resolveInstalledSystemLibrary(
  home: string,
  toolsetId: string,
  opts: { withEntry?: boolean } = {},
): Promise<InstalledSystemLibrary | null> {
  const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === toolsetId);
  if (!entry || entry.kind !== 'library') return null;

  const tracking = await readSystemTracking(home);
  const installed = tracking.toolsets[toolsetId];
  if (!installed) return null;

  const root = join(
    systemToolsetsInstallDir(home),
    installDirName({ pkg: entry.pkg, version: installed.version }),
    'package',
  );
  if (!existsSync(root)) return null;

  const path = opts.withEntry && entry.entry ? join(root, entry.entry) : root;
  return {
    path,
    version: installed.version,
    matchesPin: installed.version === entry.version && installed.integrity === entry.integrity,
  };
}
