import { createLogger } from '@bendyline/gezel';
import { isEngineRefusal } from '../chat/handoff-retry-delay.js';
import type { TaskManager } from './manager.js';

const log = createLogger('tasks');

/**
 * The task note a failed handoff leaves, which the pause card's "Open the
 * task" leads the person to. An engine that refused the turn never ran the
 * step, so the note says that in plain words instead of quoting the pool's
 * message: "Not enough graphics memory to load qwen3.5-9b-q4 (about 6.3 GB
 * on the card)…" sat on a bakery owner's task (default/2, 2026-11-09).
 * A turn that ran and failed keeps its detail for whoever retries it.
 */
export function failedHandoffNote(stepId: string, detail: string): string {
  if (isEngineRefusal(detail)) {
    return `# Paused: this step couldn't start\n\nStep \`${stepId}\` never started. The computer didn't have room to load its model just then, usually because another model was still busy or unloading. Nothing was lost.\n\nTry again once other work has finished.`;
  }
  return `# Handoff failed — paused for help\n\nThe automatic handoff for step \`${stepId}\` failed after its bounded retries: ${detail}\n\nRetry the step, reassign it, or set the task active again.`;
}

export interface TaskStepRef {
  projectId: string;
  num: number;
  stepId: string;
  taskRef: string;
}

/**
 * One exit for a handoff the runtime could not carry: the runner reaches it
 * when the dispatch itself rejects, the chat manager when the detached sends
 * spend their bounded retries. It re-checks the step is still the live one,
 * so a task that moved on (or was paused by a person) is left alone.
 *
 * `stopping` reports whether the service is shutting down. A handoff that
 * fails then does so because the service is going away, not because the step
 * is stuck: the task stays active and rehydrates on the next boot. Pausing it
 * here is what a quit, restart, or update did to every task mid-step.
 */
export async function pauseTaskAfterFailedHandoff(
  tasks: TaskManager,
  { projectId, num, stepId, taskRef, detail }: TaskStepRef & { detail: string },
  stopping: () => boolean,
): Promise<void> {
  if (stopping()) {
    log.info(`[tasks] ${taskRef} step "${stepId}": handoff stopped by shutdown, not paused`);
    return;
  }
  const current = await tasks.get(projectId, num);
  if (!current || current.status !== 'active' || current.activeStepId !== stepId) return;
  await tasks
    .appendNote(projectId, num, {
      text: failedHandoffNote(stepId, detail),
      author: { kind: 'user' },
      stepId,
    })
    .catch(() => {});
  await tasks.setStatus(projectId, num, 'paused');
  const paused = await tasks.get(projectId, num);
  if (paused) {
    await tasks.emitNeedsHelp({
      projectId,
      task: paused,
      stepId,
      reason: 'step_stalled',
      detail: `Handoff for step "${stepId}" failed after bounded retries: ${detail}`,
    });
  }
  log.warn(
    `[tasks] ${taskRef} step "${stepId}": handoff failed after bounded retries — paused for help`,
  );
}

/**
 * The person pressed Stop while a gezel was working this step. Ending the
 * turn alone does not stop the task: the stuck-step sweep re-drives an
 * active step that has gone quiet, and a restart rehydrates every active
 * task. Pausing is the state both respect, and Resume is the way back.
 * No needs-help card: the person already knows, because they did it.
 * Returns whether the task was paused.
 */
export async function pauseTaskStoppedByUser(
  tasks: TaskManager,
  { projectId, num, stepId, taskRef }: TaskStepRef,
): Promise<boolean> {
  const current = await tasks.get(projectId, num);
  if (!current || current.status !== 'active' || current.activeStepId !== stepId) return false;
  await tasks
    .appendNote(projectId, num, {
      text: `# Stopped\n\nYou stopped step \`${stepId}\` while it was running, so the task is paused. Resume it when you want the step to continue.`,
      author: { kind: 'user' },
      stepId,
    })
    .catch(() => {});
  await tasks.setStatus(projectId, num, 'paused');
  log.info(`[tasks] ${taskRef} step "${stepId}": stopped by the user — task paused`);
  return true;
}
