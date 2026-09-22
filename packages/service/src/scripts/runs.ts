/**
 * Where the desktop keeps script run records: one JSON file per run under
 * the project's `scripts/runs/<date>/`. Written atomically, because the
 * shared runner persists after every host call, and settled at boot when
 * a daemon died mid-run.
 */
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type ScriptRun, createLogger, markScriptRunInterrupted } from '@bendyline/gezel';
import { projectScriptRunFile, projectScriptRunsDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

const log = createLogger('scripts');

export async function writeProjectScriptRun(home: string, run: ScriptRun): Promise<void> {
  const date = run.startedAt.slice(0, 10);
  const file = projectScriptRunFile(home, run.projectId, date, run.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(run, null, 2));
}

export async function readProjectScriptRun(
  home: string,
  projectId: string,
  runId: string,
): Promise<ScriptRun | null> {
  const runsDir = projectScriptRunsDir(home, projectId);
  let dates: string[];
  try {
    dates = await readdir(runsDir);
  } catch {
    return null;
  }
  for (const date of dates) {
    const file = projectScriptRunFile(home, projectId, date, runId);
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      return JSON.parse(await readFile(file, 'utf8')) as ScriptRun;
    } catch {
      /* not in this date dir, keep looking */
    }
  }
  return null;
}

/**
 * Mark every run still `running` as interrupted. Never replays anything: a
 * persisted call may already have changed files. Unreadable files are
 * skipped, and nothing here throws, since it runs at boot.
 */
export async function recoverInterruptedScriptRuns(
  home: string,
  projectIds: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  let settled = 0;
  for (const projectId of projectIds) {
    const runsDir = projectScriptRunsDir(home, projectId);
    let dates: string[];
    try {
      dates = await readdir(runsDir);
    } catch {
      continue;
    }
    for (const date of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let files: string[];
      try {
        files = await readdir(
          projectScriptRunFile(home, projectId, date, '').replace(/[/\\]$/, ''),
        );
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        const file = projectScriptRunFile(home, projectId, date, name.slice(0, -5));
        try {
          const run = JSON.parse(await readFile(file, 'utf8')) as ScriptRun;
          if (!markScriptRunInterrupted(run, now())) continue;
          await writeFileAtomic(file, JSON.stringify(run, null, 2));
          settled += 1;
        } catch (err) {
          log.warn(
            `[scripts] could not settle run record ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  return settled;
}
