/**
 * Whether a task-step session may still change its task's status or advance
 * its steps.
 *
 * A step session serves one ACTIVATION of one step: `ChatSession.stepActivationId`
 * is the step's `lastActivatedAt` when the runtime dispatched it (see
 * chat/session-step-activation.ts). Once the task moves on, or loops back and
 * re-activates the step for a newer pass, that session's turn is about work
 * the task has already judged — but nothing stops it from talking. Wild-caught
 * on invoice-run (qwen3.8-27b, 2026-10-01): evaluate's gate looped the task
 * back to draft, the reviewer's stale turn was re-prompted anyway, and it set
 * the task active twice, tried to advance `evaluate`, then paused the whole run
 * four minutes later. The end-of-turn auto-advance already refused that
 * session; its explicit calls did not.
 *
 * The binding decides, not the role: a session with no recorded activation
 * (ad-hoc, created before the binding existed, the Meester's front-door chat
 * running `manage_task`), a session bound to another task, and the current
 * pass's session are all left alone. First-party clients never reach this.
 */
import { type Task, stepOwnerGezelId } from '@bendyline/gezel';

export interface StepSessionBinding {
  gezelId?: string;
  taskRef?: string;
  stepId?: string;
  stepActivationId?: string;
}

/**
 * The model-facing refusal for `binding` acting on `task`, or null when the
 * session still owns the step it was dispatched for (or was never bound to
 * one). Pure; the caller supplies the live session record and the task.
 */
export function staleStepSessionRefusal(
  binding: StepSessionBinding | null | undefined,
  task: Task | null | undefined,
): string | null {
  if (!binding?.taskRef || !binding.stepId || !binding.stepActivationId) return null;
  if (!task || task.ref !== binding.taskRef) return null;
  const ownStep = task.craftbook.steps.find((step) => step.id === binding.stepId);
  if (task.activeStepId === binding.stepId) {
    // An activation the step never recorded cannot be judged; leave it alone.
    if (!ownStep?.lastActivatedAt || ownStep.lastActivatedAt === binding.stepActivationId) {
      return null;
    }
    return `Your pass at step \`${binding.stepId}\` on ${task.ref} is over: the task looped back and a newer pass of that step owns it now. Don't change the task — end your turn.`;
  }
  const active = task.activeStepId
    ? task.craftbook.steps.find((step) => step.id === task.activeStepId)
    : undefined;
  const moved = active
    ? `the task is now on \`${active.id}\``
    : 'the task has no active step any more';
  const yours =
    active && binding.gezelId && stepOwnerGezelId(task, active) === binding.gezelId
      ? ` \`${active.id}\` is yours as well; the runtime re-engages you with its procedure once this turn ends.`
      : '';
  return `Your step \`${binding.stepId}\` is no longer the active step on ${task.ref} — ${moved}. Don't change the task — end your turn.${yours}`;
}
