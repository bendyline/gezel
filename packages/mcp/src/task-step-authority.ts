import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult } from './tool-contracts.js';

export interface TaskStepMutationScope {
  taskRef: string;
  sessionStepId: string;
  activeStepId?: string;
  /** True once this MCP process successfully completed its own step. */
  transitionCompleted: boolean;
  /**
   * True when the gezel behind this session also owns the step that is
   * active now — a generalist owner, or the same specialist on adjacent
   * steps. The runtime re-engages that session with the new step's
   * procedure once this turn ends; telling it to yield to "the active
   * step's gezel" sends it looking for someone else (Opus, 2026-09-19).
   */
  activeStepOwnedBySession?: boolean;
}

/**
 * Explain why a task-scoped session may no longer mutate project data.
 *
 * A step session owns writes only while its snapshotted step is active. A
 * successful advance transfers that ownership to the successor immediately;
 * the old model must not turn its handoff receipt into one last write.
 */
export function taskStepMutationRejection(scope: TaskStepMutationScope): string | null {
  const { taskRef, sessionStepId, activeStepId, transitionCompleted } = scope;
  if (!taskRef || !sessionStepId) return null;
  if (!transitionCompleted && activeStepId === sessionStepId) return null;

  const active = activeStepId
    ? ` The active step is now "${activeStepId}".`
    : ' This session already completed its step.';
  const yieldTo =
    activeStepId && scope.activeStepOwnedBySession
      ? `That step is yours as well: end this turn now, and the runtime re-engages you with the "${activeStepId}" procedure in front of you.`
      : "Stop this turn and yield to the active step's gezel.";
  return `Step "${sessionStepId}" on ${taskRef} no longer owns project writes.${active} ${yieldTo} Do not rewrite, append to, move, or delete the completed step's deliverable.`;
}

/**
 * The daemon's refusal of a status change or step advance from a session
 * whose step pass is over (`stale_task_step`, service scope-guard), or null
 * for any other failure. The hint is the whole instruction — end the turn —
 * so callers return it verbatim instead of decorating it with retry advice.
 */
export function staleTaskStepRefusal(err: unknown): string | null {
  return daemonRefusal(err, 'stale_task_step');
}

/**
 * The daemon's refusal of a task launch from a turn that answers a
 * scheduled check-in (`check_in_turn`, service scope-guard), or null. Like
 * {@link staleTaskStepRefusal}, the hint is the whole instruction.
 */
export function checkInTurnRefusal(err: unknown): string | null {
  return daemonRefusal(err, 'check_in_turn');
}

/** {@link checkInTurnRefusal} as the task tools' non-retryable result. */
export function checkInTurnResult(err: unknown): CallToolResult | null {
  const hint = checkInTurnRefusal(err);
  return hint ? errorResult(hint, { code: 'check_in_turn', retryable: false }) : null;
}

function daemonRefusal(err: unknown, code: string): string | null {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (!details || typeof details !== 'object') return null;
  const { error, hint } = details as { error?: unknown; hint?: unknown };
  return error === code && typeof hint === 'string' && hint.trim() ? hint : null;
}

/**
 * Whether the runtime has bound this session to the current pass of its own
 * step, which ends the completion latch. A self-looping step (the nightly
 * oversight review) re-activates the step it completes, and the next dispatch
 * binds the same session to that pass. The latch alone refused every write of
 * every later pass the subprocess served (2026-10-08). The binding moves only
 * on a dispatch, so the turn that advanced still cannot write after its
 * handoff.
 */
export function sessionReboundToCurrentPass(args: {
  sessionStepId: string;
  activeStepId: string | undefined;
  activeStepActivation: string | undefined;
  sessionActivation: string | undefined;
}): boolean {
  return (
    args.activeStepId === args.sessionStepId &&
    !!args.activeStepActivation &&
    args.sessionActivation === args.activeStepActivation
  );
}
