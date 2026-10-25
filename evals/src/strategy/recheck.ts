import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { evaluateCraftbookGateChecks } from '../craftbooks/gates.ts';
import {
  contractScopedSpec,
  interpolateTaskTokens,
  knownCitationPathsForSpec,
  successChecksForSpec,
} from '../craftbooks/scenario.ts';
import type { CraftbookEvalSpec } from '../craftbooks/types.ts';
import { contractTask, trialReader } from './contract-grade.ts';

/**
 * Files the live check builds from the daemon's state rather than reading
 * from disk, and checks that need the scenario's hidden oracle files.
 * Neither can be reproduced from a trial folder.
 */
const VIRTUAL_FILES = new Set(['task-graph.md', 'task-notes.md']);
const LIVE_ONLY_KINDS = new Set(['nodeScriptPasses']);

/**
 * Live failures the re-check cannot reproduce, which therefore stand:
 * hidden oracle runs, the task graph and notes, fixtures, History, mocks.
 */
export const LIVE_ONLY_FAILURE =
  /did not pass when run with node|task-graph\.md|task-notes\.md|has not finished|unchanged fixture|history |mock |seeded workspace input/i;

/**
 * Re-run a book's test checks over one finished trial's saved files. Used
 * when a test is corrected after a run: the same deliverables are judged by
 * the corrected checks, with no rerun and no new sample. File checks only:
 * what `LIVE_ONLY_FAILURE` names was judged live and is not re-read here.
 * Null when the trial has no task from the book.
 */
export async function recheckTrialFiles(
  trialDir: string,
  spec: CraftbookEvalSpec,
): Promise<string[] | null> {
  let state: { tasks?: { tasks?: Task[] } | Task[] };
  try {
    state = JSON.parse(await readFile(join(trialDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks?.tasks ?? []);
  const task = contractTask(tasks, spec.craftbookId);
  if (!task) return null;
  const scoped = task.craftbook.contract ? contractScopedSpec(spec, task).spec : spec;
  const tokens = {
    'task.dir': task.artifactDir ?? `tasks/${task.num}`,
    'task.num': String(task.num),
  };
  const checks = interpolateTaskTokens(successChecksForSpec(scoped), tokens).filter((check) => {
    const file = (check as { file?: unknown }).file;
    return (
      !LIVE_ONLY_KINDS.has(check.kind) && !(typeof file === 'string' && VIRTUAL_FILES.has(file))
    );
  });
  const result = await evaluateCraftbookGateChecks(checks, trialReader(trialDir, task.projectId), {
    knownCitationPaths: interpolateTaskTokens(knownCitationPathsForSpec(scoped), tokens),
  });
  return result.failures;
}
