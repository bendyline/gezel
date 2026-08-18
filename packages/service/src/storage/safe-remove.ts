import { lstat, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { activeMachineSharedHome } from '@bendyline/gezel/paths';
import { isPathInside, realpathContained } from '../fs/safe-paths.js';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import type { StoragePathEntry } from './registry.js';

const log = createLogger('storage');

/**
 * The one funnel every cleanup deletion passes through.
 *
 * Cleanup is the only feature in Gezel that removes whole trees on a user's
 * say-so, and the paths it works from are assembled out of config the user
 * controls — externalized folder roots, project working directories. So the
 * containment check is not a formality: it is the difference between
 * reclaiming disk and deleting somebody's source repository.
 *
 * Everything here refuses rather than repairs. A path that fails any check is
 * skipped and reported, never coerced into something safe-looking.
 */

export class UndeletablePathError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'UndeletablePathError';
  }
}

export interface RemoveGuardOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Throws unless `path` is a real location inside the home directory that
 * cleanup is allowed to remove.
 */
export async function assertPathDeletable(path: string, opts: RemoveGuardOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const target = resolve(path);
  const home = resolve(opts.home);

  if (!isAbsolute(path)) {
    throw new UndeletablePathError(path, 'Only absolute paths can be removed.');
  }
  if (target === home) {
    // Cleanup empties categories. Removing the home directory itself is the
    // uninstaller's job, and doing it here would take the daemon's own
    // runtime state with it mid-run.
    throw new UndeletablePathError(path, 'The Gezel home folder itself is never removed.');
  }

  const shared = activeMachineSharedHome(env);
  if (shared && isPathInside(target, shared)) {
    throw new UndeletablePathError(path, 'Machine-shared content belongs to the installation.');
  }

  const sharedAssets = env[SHARED_ASSETS_ENV]?.trim();
  if (sharedAssets && isAbsolute(sharedAssets)) {
    if (isPathInside(target, sharedAssets)) {
      throw new UndeletablePathError(path, 'Machine-wide models are read-only to this process.');
    }
  }

  // Cheap containment first, then the symlink-resolving check. A path that
  // looks contained can still resolve outside via a link in any segment.
  if (!isPathInside(target, home)) {
    throw new UndeletablePathError(path, 'Outside the Gezel folder.');
  }
  if (!(await realpathContained(home, target))) {
    throw new UndeletablePathError(path, 'Resolves outside the Gezel folder.');
  }

  // A symlinked category root would be unlinked rather than emptied, which
  // silently leaves the real content on disk while reporting it freed.
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new UndeletablePathError(path, 'This location is a link, not a folder.');
    }
  } catch (err) {
    if (err instanceof UndeletablePathError) throw err;
    // Missing is fine — removal of a path that is already gone is a no-op.
  }
}

/**
 * Remove a guarded path, tolerating the transient file locks that make a
 * naive `rm` flaky on Windows. Mirrors `removeModelDir`'s retry ladder: brief
 * antivirus / indexer holds clear in a few hundred milliseconds, while a
 * genuinely open file never clears and deserves an actionable message rather
 * than a raw EBUSY.
 */
export async function removeGuardedTree(path: string, opts: RemoveGuardOptions): Promise<void> {
  await assertPathDeletable(path, opts);

  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const locked =
        code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
      if (locked && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
        continue;
      }
      if (locked) {
        throw new Error(
          'Could not delete these files — something still has them open. Close any running chats or downloads that use them, then try again.',
        );
      }
      throw err;
    }
  }
}

/**
 * Remove one registry entry plus the tracking files that must not outlive it.
 *
 * A toolset tree deleted while its install record survives leaves the daemon
 * insisting a toolset is installed when its files are gone: nothing
 * re-installs it, and the failure only shows up later as a missing tool.
 * Co-deletion is part of the same step for that reason.
 */
export async function removeEntry(
  entry: StoragePathEntry,
  opts: RemoveGuardOptions,
): Promise<void> {
  await removeGuardedTree(entry.path, opts);
  for (const tracking of entry.coDelete ?? []) {
    try {
      await removeGuardedTree(tracking, opts);
    } catch (err) {
      // The payload is already gone; a surviving tracking file is a
      // correctness problem worth logging loudly, but re-adding the payload
      // is not an option, so the job continues.
      log.warn(
        `[cleanup] removed ${entry.path} but could not remove its record ${tracking}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
