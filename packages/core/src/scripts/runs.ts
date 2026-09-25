/**
 * A run record that says `running` after the process that ran it is gone
 * will say so forever. Both hosts settle such records at startup, and
 * neither replays them: a persisted call may already have changed files.
 */
import type { ScriptRun } from '../schemas/script.js';

export const INTERRUPTED_SCRIPT_RUN_ERROR =
  'Script interrupted when Gezel closed. Inspect its calls and saved files before running it again; actions were not replayed.';

/** Mark an interrupted run as failed. Returns false when the run had already finished. */
export function markScriptRunInterrupted(run: ScriptRun, finishedAt: string): boolean {
  if (run.status !== 'running') return false;
  run.status = 'error';
  run.finishedAt = finishedAt;
  run.error = INTERRUPTED_SCRIPT_RUN_ERROR;
  return true;
}
