/**
 * "Try again" for a task that paused for help.
 *
 * Every pause-for-help path (gate budget spent, plateau, stalled step,
 * spent task budget, a gate that could not run) ends the same way: the
 * task is `paused`, a note explains what went wrong, and a needs-input
 * card is filed. Getting back to work used to mean flipping the status
 * to active by hand — and that alone usually did nothing, because the
 * counters that tripped the pause are still spent: the step's re-drive
 * budget is at max, its gate-attempt trail still reads as a plateau, and
 * the task's unattended-spend accumulator is still over the hard cap. The
 * scheduler would re-escalate on its next sweep and pause it right back.
 *
 * So a retry is three things, not one: clear the recovery counters, flip
 * the status, and re-drive the assignee NOW rather than waiting out the
 * scheduler's stall window. The dispatch continues the step's existing
 * session (`resumeExisting`) so the model can see its own failed
 * attempts, and the `retry` seed points it at the note that says why it
 * stopped — a retry that repeats the attempt verbatim is a wasted turn.
 *
 * Deliberately does NOT judge whether retrying can succeed. A gate
 * pinned on an unresolved craftbook placeholder cannot pass however many
 * times it runs, but the fix for that is an edit the user makes between
 * the pause and the click — refusing the retry would just hide the
 * button from the person who already fixed it.
 */

import type { Task } from '@bendyline/gezel';
import { createLogger, projectAllowsAmbientWork } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { type TaskManager, stepOwnerGezelId } from './manager.js';
import type { TaskRunner } from './runner.js';

const log = createLogger('tasks');

export interface TaskRetryDeps {
  store: Pick<Store, 'getProject' | 'getGezel'>;
  tasks: Pick<
    TaskManager,
    'get' | 'setStatus' | 'appendNote' | 'resetStepRecoveryBudget' | 'ensureActiveStepEntered'
  >;
  taskRunner: Pick<TaskRunner, 'enqueueHandoff'>;
  /** Optional so tests can drive the helper without a ChatManager. */
  chat?: { resetTaskBudget(taskRef: string): void };
}

/** Why nothing was re-driven. Mirrors {@link EntryDispatchResult}'s shape. */
export type TaskRetryHoldReason =
  | 'not-paused'
  | 'no-active-step'
  | 'spawn-host'
  | 'no-assignee'
  | 'project-inactive';

export interface TaskRetryResult {
  task: Task;
  /** Whether a turn was actually queued for the assignee. */
  dispatched: boolean;
  gezelId?: string;
  assigneeName?: string;
  reason?: TaskRetryHoldReason;
}

/**
 * Returns `null` when the task doesn't exist. `not-paused` leaves the
 * task untouched — the caller's view was stale and the work is either
 * already running or finished.
 */
export async function retryPausedTask(
  deps: TaskRetryDeps,
  projectId: string,
  num: number,
): Promise<TaskRetryResult | null> {
  const task = await deps.tasks.get(projectId, num);
  if (!task) return null;
  if (task.status !== 'paused') {
    return { task, dispatched: false, reason: 'not-paused' };
  }

  const stepId = task.activeStepId;
  if (stepId) {
    await deps.tasks.resetStepRecoveryBudget(projectId, num, stepId, {
      redriveCount: 0,
      clearGateAttempts: true,
    });
  }
  await deps.tasks
    .appendNote(projectId, num, {
      text: '# Retry requested\n\nThe user asked for another attempt at this step. The re-drive and completion-gate budgets were reset, so the counters that paused the task are no longer spent. Read the note above this one for why it stopped, and take a different approach — repeating the attempt that failed will pause it again.',
      author: { kind: 'user' },
      ...(stepId ? { stepId } : {}),
    })
    .catch(() => {});
  deps.chat?.resetTaskBudget(task.ref);

  const active = await deps.tasks.setStatus(projectId, num, 'active');

  // Spawn hosts never run their own steps (their children do), so flipping
  // the host back to active IS the whole retry — kicking it would make its
  // inert wait step run as real work.
  if (task.cron || task.fanout) {
    return { task: active, dispatched: false, reason: 'spawn-host' };
  }

  // A setup failure is what paused some tasks in the first place. Re-run any
  // still-unprepared onEnter hooks before queuing a model, otherwise Try again
  // would reproduce the original bug by dispatching against missing inputs.
  const entrance = await deps.tasks.ensureActiveStepEntered(projectId, num);
  if (entrance.status === 'failed') {
    throw new Error(
      `Could not restart ${task.ref}: setup for its current step failed again. The task remains paused; see its latest note for details.`,
    );
  }
  if (entrance.status === 'advanced') {
    return {
      task: entrance.task,
      // Auto-advancing setup dispatches the successor through the normal
      // activation hook when one remains.
      dispatched: entrance.task.status === 'active',
    };
  }

  const prepared = entrance.task;
  const preparedStepId = prepared.activeStepId;
  const preparedStep = preparedStepId
    ? prepared.craftbook.steps.find((candidate) => candidate.id === preparedStepId)
    : undefined;
  if (!preparedStepId || !preparedStep) {
    return { task: prepared, dispatched: false, reason: 'no-active-step' };
  }
  const gezelId = stepOwnerGezelId(prepared, preparedStep);
  if (!gezelId) {
    return { task: prepared, dispatched: false, reason: 'no-assignee' };
  }
  const assigneeName = (await deps.store.getGezel(gezelId).catch(() => null))?.name;
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (project && !projectAllowsAmbientWork(project)) {
    log.info(`[tasks] retry dispatch skipped for ${prepared.ref}: project not active`);
    return {
      task: prepared,
      dispatched: false,
      gezelId,
      ...(assigneeName ? { assigneeName } : {}),
      reason: 'project-inactive',
    };
  }

  deps.taskRunner.enqueueHandoff({
    gezelId,
    projectId,
    taskRef: prepared.ref,
    stepId: preparedStepId,
    kind: 'retry',
    // Continue the thread that stalled: its tool evidence and the model's
    // own failed attempts are the context a second try needs.
    resumeExisting: true,
    ...(prepared.nightShift?.enabled === true ? { nightShift: true } : {}),
    ...(preparedStep.lastActivatedAt ? { activationAt: preparedStep.lastActivatedAt } : {}),
  });
  log.info(
    `[tasks] retry dispatched: ${prepared.ref} step ${preparedStepId} → ${assigneeName ?? gezelId}`,
  );
  return { task: prepared, dispatched: true, gezelId, ...(assigneeName ? { assigneeName } : {}) };
}
