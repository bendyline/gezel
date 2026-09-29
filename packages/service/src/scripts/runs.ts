/**
 * Where the desktop keeps script run records: one JSON file per run under
 * the project's `scripts/runs/<date>/`, written atomically.
 *
 * A run whose record says `running` also has an in-flight marker,
 * `scripts/runs/.in-flight/<runId>`, holding its date folder. The marker is
 * written before the first `running` record and removed after the final one,
 * so boot settles a dead daemon's runs by reading the markers alone; the
 * history, which grows without bound, is never scanned.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ScriptRun,
  createLogger,
  isSafeEntityId,
  markScriptRunInterrupted,
} from '@bendyline/gezel';
import { projectScriptRunFile, projectScriptRunsDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

const log = createLogger('scripts');

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** Markers this process has written and not yet removed, by path. */
const markedInFlight = new Set<string>();

function inFlightDir(home: string, projectId: string): string {
  return join(projectScriptRunsDir(home, projectId), '.in-flight');
}

export async function writeProjectScriptRun(home: string, run: ScriptRun): Promise<void> {
  const date = run.startedAt.slice(0, 10);
  const file = projectScriptRunFile(home, run.projectId, date, run.id);
  const marker = join(inFlightDir(home, run.projectId), run.id);
  if (run.status === 'running' && !markedInFlight.has(marker)) {
    // Before the record: a `running` record without its marker would never be settled.
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, date, 'utf8');
    markedInFlight.add(marker);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(run, null, 2));
  if (run.status !== 'running') {
    markedInFlight.delete(marker);
    // A leftover marker beside a finished record is harmless: boot drops it.
    await rm(marker, { force: true }).catch((err: unknown) =>
      log.warn(`[scripts] could not clear in-flight marker ${marker}: ${describe(err)}`),
    );
  }
}

/** The record's path, trying the marker's date folder before searching every one. */
async function findProjectScriptRunFile(
  home: string,
  projectId: string,
  runId: string,
  dateHint?: string,
): Promise<string | null> {
  const isFile = (path: string) =>
    stat(path).then(
      (s) => s.isFile(),
      () => false,
    );
  if (dateHint && DATE_DIR.test(dateHint)) {
    const hinted = projectScriptRunFile(home, projectId, dateHint, runId);
    if (await isFile(hinted)) return hinted;
  }
  let dates: string[];
  try {
    dates = await readdir(projectScriptRunsDir(home, projectId));
  } catch {
    return null;
  }
  for (const date of dates) {
    if (!DATE_DIR.test(date) || date === dateHint) continue;
    const file = projectScriptRunFile(home, projectId, date, runId);
    if (await isFile(file)) return file;
  }
  return null;
}

export async function readProjectScriptRun(
  home: string,
  projectId: string,
  runId: string,
): Promise<ScriptRun | null> {
  const file = await findProjectScriptRunFile(home, projectId, runId);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ScriptRun;
  } catch {
    return null;
  }
}

/**
 * Mark every run a dead daemon left `running` as interrupted. Never replays
 * anything: a persisted call may already have changed files. Only in-flight
 * markers are read, so boot cost does not grow with run history. A marker
 * whose record cannot be read stays for the next boot; nothing here throws,
 * since it runs at boot.
 */
export async function recoverInterruptedScriptRuns(
  home: string,
  projectIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  let settled = 0;
  for (const projectId of projectIds) {
    const dir = inFlightDir(home, projectId);
    let markers: string[];
    try {
      markers = await readdir(dir);
    } catch {
      continue;
    }
    for (const runId of markers) {
      if (!isSafeEntityId(runId)) continue;
      const marker = join(dir, runId);
      try {
        const dateHint = await readFile(marker, 'utf8').catch(() => undefined);
        const file = await findProjectScriptRunFile(home, projectId, runId, dateHint?.trim());
        if (file) {
          const run = parseRun(await readFile(file, 'utf8'), file);
          if (run && markScriptRunInterrupted(run, now())) {
            await writeFileAtomic(file, JSON.stringify(run, null, 2));
            settled += 1;
          }
        }
        await rm(marker, { force: true });
      } catch (err) {
        log.warn(`[scripts] could not settle run ${projectId}/${runId}: ${describe(err)}`);
      }
    }
  }
  return settled;
}

/** A record that is not JSON can never be settled; keeping its marker would only repeat this. */
function parseRun(text: string, file: string): ScriptRun | null {
  try {
    return JSON.parse(text) as ScriptRun;
  } catch (err) {
    log.warn(`[scripts] unreadable run record ${file}: ${describe(err)}`);
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
