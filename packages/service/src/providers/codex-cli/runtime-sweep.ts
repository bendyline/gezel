/**
 * Prunes the per-session Codex homes that session.ts builds under
 * `<runtimeDir>/<projectId>/<sessionId>/`. Each home holds Codex's resumable
 * rollout, its state databases and a copy of its system skills (5–9 MB), and
 * nothing else ever removed one. Callers that open a session per work item
 * (batch pipelines drive thousands a day) filled the user's disk at tens of
 * gigabytes a day.
 *
 * A home survives while it was used within `maxAgeMs` and is one of the
 * `maxHomes` most recently used; a home used within `minAgeMs` always
 * survives, so a sweep never races a batch that is still fanning out.
 * Recency is the home directory's mtime, which session.ts stamps at the start
 * of every turn. Removing a home only costs Codex-side history: the session's
 * next `codex exec resume` fails as a SessionResumeError and ChatManager
 * starts a fresh thread.
 *
 * Related: session.ts (ensureCodexHome stamps the mtime), provider.ts
 * (schedules a sweep at most every RUNTIME_SWEEP_INTERVAL_MS),
 * runtime-sweep.test.ts.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('codex-cli');

const HOUR_MS = 60 * 60 * 1000;

/** Homes idle longer than this are removed. */
export const CODEX_HOME_MAX_AGE_MS = 14 * 24 * HOUR_MS;
/** At most this many homes are kept, newest first. */
export const CODEX_HOME_MAX_COUNT = 1000;
/** Homes used more recently than this are never removed. */
export const CODEX_HOME_MIN_AGE_MS = HOUR_MS;
/** How often a long-running provider repeats the sweep. */
export const RUNTIME_SWEEP_INTERVAL_MS = 6 * HOUR_MS;

export interface CodexHomeSweepOptions {
  runtimeDir: string;
  maxAgeMs?: number;
  maxHomes?: number;
  minAgeMs?: number;
  now?: number;
}

export interface CodexHomeSweepResult {
  scanned: number;
  removed: number;
}

export async function sweepCodexHomes(opts: CodexHomeSweepOptions): Promise<CodexHomeSweepResult> {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? CODEX_HOME_MAX_AGE_MS;
  const maxHomes = opts.maxHomes ?? CODEX_HOME_MAX_COUNT;
  const minAgeMs = opts.minAgeMs ?? CODEX_HOME_MIN_AGE_MS;

  const homes: Array<{ path: string; mtimeMs: number }> = [];
  for (const project of await listDirs(opts.runtimeDir)) {
    const projectDir = join(opts.runtimeDir, project);
    for (const session of await listDirs(projectDir)) {
      const path = join(projectDir, session);
      const mtimeMs = await mtimeOf(path);
      if (mtimeMs !== null) homes.push({ path, mtimeMs });
    }
  }
  homes.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let removed = 0;
  for (const [rank, home] of homes.entries()) {
    const age = now - home.mtimeMs;
    if (age < minAgeMs) continue;
    if (age <= maxAgeMs && rank < maxHomes) continue;
    // A turn that started since the scan has stamped the home; leave it.
    if ((await mtimeOf(home.path)) !== home.mtimeMs) continue;
    try {
      await rm(home.path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn(
        `[codex-cli] could not remove idle session home ${home.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { scanned: homes.length, removed };
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
