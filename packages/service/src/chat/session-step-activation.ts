/**
 * Which activation of a craftbook step a task session serves.
 *
 * A looping craftbook re-enters the same step id on every pass
 * (spreadsheet-model's `evaluate → build`), and each pass is dispatched to
 * its own session. `taskRef` + `stepId` cannot tell those sessions apart, so
 * a session records the activation it was bound to in
 * `ChatSession.stepActivationId`: the step's `lastActivatedAt`, the same key
 * TaskRunner dispatches and prunes under.
 *
 * The binding is written only where the runtime decides a session serves a
 * pass — dispatch, a gate verdict re-pin, a runtime re-drive, and the
 * current-turn gate self-loop adoption. A session with no binding (created
 * before it existed, or by an ad-hoc path) is never judged stale.
 */
import type { ChatSession, Task, TaskCraftbookStep } from '@bendyline/gezel';

type ActivationBinding = Pick<ChatSession, 'taskRef' | 'stepId' | 'stepActivationId'>;

/** The step's current activation, or undefined when it has never been activated. */
export function currentStepActivation(
  task: Pick<Task, 'craftbook'>,
  stepId: string,
): string | undefined {
  return task.craftbook.steps.find((step) => step.id === stepId)?.lastActivatedAt;
}

/**
 * True when `record` is pinned to `step` but bound to an EARLIER activation
 * of it: the task left the step and came back, and a newer session owns this
 * pass. Such a session may still be running a turn (a nudge, a user message),
 * but its tool trace is evidence about a pass the task has already judged.
 */
export function servesEarlierActivation(
  record: ActivationBinding,
  taskRef: string,
  step: Pick<TaskCraftbookStep, 'id' | 'lastActivatedAt'>,
): boolean {
  return (
    record.taskRef === taskRef &&
    record.stepId === step.id &&
    record.stepActivationId !== undefined &&
    step.lastActivatedAt !== undefined &&
    record.stepActivationId !== step.lastActivatedAt
  );
}

/**
 * True when `record` is bound to a pass of a DIFFERENT step of this task than
 * `step`. A gate that routes the task back to another step re-activates that
 * step under its own dispatch while the turn that triggered it is still pinned
 * to the gated step, so that turn's ending says nothing about the new pass.
 */
export function servesAnotherStep(
  record: ActivationBinding,
  taskRef: string,
  step: Pick<TaskCraftbookStep, 'id'>,
): boolean {
  return (
    record.taskRef === taskRef &&
    record.stepId !== undefined &&
    record.stepActivationId !== undefined &&
    record.stepId !== step.id
  );
}

/**
 * Bind `record` to `activation`, clearing a binding that belonged to the
 * step it was pinned to before. Returns whether anything changed.
 */
export function bindStepActivation(
  record: ActivationBinding,
  activation: string | undefined,
): boolean {
  if (record.stepActivationId === activation) return false;
  if (activation === undefined) delete record.stepActivationId;
  else record.stepActivationId = activation;
  return true;
}
