import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ambientDir, ambientDisplayStateFile } from '@bendyline/gezel/paths';
import type { AmbientDisplayModule, SavedWallpaper } from './index.js';

/**
 * Platform-agnostic rotator brain. The generator (in gezeld) writes
 * dated PNGs + `latest.png` under `~/.gezel/ambient/`; this runtime
 * decides what to apply and remembers what to restore.
 *
 * Applies always go through one of two alternating slot files
 * (`applied-a.png` / `applied-b.png`), never `latest.png` directly:
 * macOS and GNOME treat "set wallpaper to the path it already has" as a
 * no-op even when the file *content* changed, so the applied path must
 * differ on every apply. The slots also sit outside the generator's
 * dated-file retention, so the file the OS points at is never deleted
 * out from under it.
 */

const DATED_FILE_RE = /^dashboard-\d{8}-\d{4}\.png$/;
const SLOTS = ['applied-a.png', 'applied-b.png'] as const;

export interface AmbientDisplayState {
  restore?: SavedWallpaper;
  lastApplied?: {
    /** Dated filename the applied slot was copied from. */
    source: string;
    slot: (typeof SLOTS)[number];
    mtimeMs: number;
  };
}

export interface AmbientRuntimeDeps {
  home: string;
  module: AmbientDisplayModule;
}

export async function readDisplayState(home: string): Promise<AmbientDisplayState> {
  try {
    const raw = await readFile(ambientDisplayStateFile(home), 'utf8');
    const parsed = JSON.parse(raw) as AmbientDisplayState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDisplayState(home: string, state: AmbientDisplayState): Promise<void> {
  const dir = ambientDir(home);
  await mkdir(dir, { recursive: true });
  const path = ambientDisplayStateFile(home);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

/** Newest dated PNG, falling back to nothing (never `latest.png` — the
 *  generator writes both, and dated names carry the mtime we track). */
export async function newestDatedImage(
  home: string,
): Promise<{ name: string; mtimeMs: number } | null> {
  const dir = ambientDir(home);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const dated = entries.filter((name) => DATED_FILE_RE.test(name)).sort();
  const name = dated[dated.length - 1];
  if (!name) return null;
  const info = await stat(join(dir, name)).catch(() => null);
  if (!info) return null;
  return { name, mtimeMs: info.mtimeMs };
}

export interface ApplyResult {
  applied: boolean;
  reason?: 'no-image' | 'unchanged' | 'unsupported';
  error?: string;
}

/**
 * Apply the newest dated PNG unless it is the one already applied.
 * `force` reapplies regardless (the enable flow and "apply now").
 */
export async function applyLatest(
  deps: AmbientRuntimeDeps,
  opts: { force?: boolean } = {},
): Promise<ApplyResult> {
  const capability = await deps.module.capability();
  if (!capability.supported) return { applied: false, reason: 'unsupported' };

  const newest = await newestDatedImage(deps.home);
  if (!newest) return { applied: false, reason: 'no-image' };

  const state = await readDisplayState(deps.home);
  if (
    !opts.force &&
    state.lastApplied &&
    state.lastApplied.source === newest.name &&
    state.lastApplied.mtimeMs === newest.mtimeMs
  ) {
    return { applied: false, reason: 'unchanged' };
  }

  const dir = ambientDir(deps.home);
  const slot: (typeof SLOTS)[number] =
    state.lastApplied?.slot === 'applied-a.png' ? 'applied-b.png' : 'applied-a.png';
  await copyFile(join(dir, newest.name), join(dir, slot));
  await deps.module.setWallpaper(join(dir, slot));
  await writeDisplayState(deps.home, {
    ...state,
    lastApplied: { source: newest.name, slot, mtimeMs: newest.mtimeMs },
  });
  return { applied: true };
}

/**
 * Opt-in flow: capture the current wallpaper for later restore — but
 * only when no restore record exists yet, so a double-enable can never
 * overwrite the user's real wallpaper with one of our own slots — then
 * apply.
 */
export async function enable(deps: AmbientRuntimeDeps): Promise<ApplyResult> {
  const state = await readDisplayState(deps.home);
  if (!state.restore) {
    const value = await deps.module.getCurrentWallpaper();
    if (value !== null) {
      await writeDisplayState(deps.home, {
        ...state,
        restore: {
          platform: process.platform,
          capturedAt: new Date().toISOString(),
          value,
        },
      });
    }
  }
  return applyLatest(deps, { force: true });
}

export interface DisableResult {
  restored: boolean;
  /** Why the wallpaper was left as-is (surface this to the user). */
  reason?: 'nothing-captured' | 'restore-failed';
}

/**
 * Opt-out flow: put the captured wallpaper back where possible, then
 * drop the restore record either way — a stale record must not restore
 * something ancient months later.
 */
export async function disable(deps: AmbientRuntimeDeps): Promise<DisableResult> {
  const state = await readDisplayState(deps.home);
  const restore = state.restore;
  const next: AmbientDisplayState = {};
  let result: DisableResult;
  if (!restore) {
    result = { restored: false, reason: 'nothing-captured' };
  } else {
    try {
      await deps.module.restoreWallpaper(restore);
      result = { restored: true };
    } catch {
      result = { restored: false, reason: 'restore-failed' };
    }
  }
  await writeDisplayState(deps.home, next);
  return result;
}
