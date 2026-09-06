import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Did the craftbook actually drive the trial?
 *
 * A `craftbook-<bookId>` scenario in `artifact-task` mode sends a freehand
 * kickoff prompt to a worker gezel and grades the file that appears. Nothing
 * in that path requires the book to be invoked — and in practice it usually
 * is not: a passing trial can mean "a model wrote a good report", not "this
 * recipe works". The distinction was recorded only as an `info` issue on the
 * template audit (`eval.artifact-only`), never as per-trial evidence, so no
 * run could tell you which of the two it had measured.
 *
 * This derives that evidence after the fact from artifacts the trial already
 * captured, so it costs the run nothing and applies retroactively to every
 * trial directory ever written:
 *
 * - `state.json` holds the tasks that were still LIVE at teardown.
 * - `recording/task-history/` holds the ones that had already COMPLETED and
 *   moved out of live state — a task that ran the book to its terminal step
 *   is exactly the case that leaves state.json, so reading only the former
 *   would report the best outcome as "never ran".
 *
 * Reported, never graded. Turning it into a gate would fail ~88% of the
 * bundled craftbook evals in one commit; that is a policy call for whoever
 * owns the suite, and it needs this measurement to exist first.
 */
export interface CraftbookDroveSummary {
  /** Craftbook id under test, parsed from a `craftbook-<id>` scenario id. */
  craftbookId: string;
  /** Tasks observed in the trial (live + completed), across every project. */
  tasksObserved: number;
  /** Of those, how many were sourced from this craftbook. */
  craftbookTasks: number;
  /** True when at least one such task completed or sat on a terminal step. */
  reachedTerminal: boolean;
  /**
   * The headline: did this trial exercise the RECIPE (`drove`), or only the
   * model's ability to produce the deliverable freehand (`artifact-only`)?
   * `unknown` when the trial captured no task state to read.
   */
  verdict: 'drove' | 'artifact-only' | 'unknown';
}

interface TaskLike {
  ref?: string;
  status?: string;
  activeStepId?: string;
  craftbook?: { id?: string; steps?: Array<{ id?: string; terminal?: boolean }> };
  sourceCraftbookIds?: Array<{ catalogId?: string }>;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The `craftbook-*` scenarios that are NOT "run this library book" trials.
 * They grade a craftbook the model AUTHORED, repaired, or chose — so no task
 * sourced from a bundled book is expected, and drive-through says nothing
 * about them. Reporting them as `artifact-only` would read as a defect.
 * Mirrored in `evals/scripts/craftbook_matrix_report.py`.
 */
const AUTHORING_SCENARIO_IDS = new Set([
  'craftbook-author-fanout',
  'craftbook-author-gate-script',
  'craftbook-author-linear',
  'craftbook-author-params',
  'craftbook-edit-midtask',
  'craftbook-export-generalize',
  'craftbook-find-vs-create',
  'craftbook-route-multi',
]);

/**
 * `craftbook-a11y-audit` → `a11y-audit`. Returns null for a non-craftbook
 * scenario and for the authoring scenarios above.
 */
export function craftbookIdFromScenarioId(scenarioId: string): string | null {
  if (AUTHORING_SCENARIO_IDS.has(scenarioId)) return null;
  const m = /^craftbook-(.+)$/.exec(scenarioId);
  return m?.[1] ?? null;
}

function liveTasks(runDir: string): TaskLike[] {
  const state = readJson<{ tasks?: { tasks?: TaskLike[] } | TaskLike[] }>(
    join(runDir, 'state.json'),
  );
  const raw = state?.tasks;
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.tasks)) return raw.tasks;
  return [];
}

function completedTasks(runDir: string): TaskLike[] {
  const dir = join(runDir, 'recording', 'task-history');
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const parsed = readJson<TaskLike | TaskLike[]>(join(dir, n));
    if (!parsed) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function matchesCraftbook(task: TaskLike, craftbookId: string): boolean {
  if (task.craftbook?.id === craftbookId) return true;
  return (task.sourceCraftbookIds ?? []).some((s) => s.catalogId === craftbookId);
}

function isTerminal(task: TaskLike): boolean {
  if (task.status === 'complete') return true;
  const active = task.craftbook?.steps?.find((s) => s.id === task.activeStepId);
  return active?.terminal === true;
}

/**
 * Summarize craftbook drive-through for one trial directory. Returns null for
 * a scenario that is not a `craftbook-*` trial, or when no task state was
 * captured at all (pre-`state.json` trials) — an absent record is reported as
 * absent rather than as a negative result.
 */
export function summarizeCraftbookDrove(
  runDir: string,
  scenarioId: string,
): CraftbookDroveSummary | null {
  const craftbookId = craftbookIdFromScenarioId(scenarioId);
  if (!craftbookId) return null;
  const hasState = existsSync(join(runDir, 'state.json'));
  const tasks = [...liveTasks(runDir), ...completedTasks(runDir)];
  const matching = tasks.filter((t) => matchesCraftbook(t, craftbookId));
  const reachedTerminal = matching.some(isTerminal);
  const verdict: CraftbookDroveSummary['verdict'] = !hasState
    ? 'unknown'
    : matching.length > 0
      ? 'drove'
      : 'artifact-only';
  return {
    craftbookId,
    tasksObserved: tasks.length,
    craftbookTasks: matching.length,
    reachedTerminal,
    verdict,
  };
}
