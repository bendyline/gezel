import type { Task } from '@bendyline/gezel';

/**
 * Whether `stepId`'s completion gate rejected its work at or after `since`.
 *
 * A fixed-action handoff whose turn ends on a rejection is sent again with
 * the verdict already in the step's prompt. That retry is a repair of what
 * the gate named, so it thinks on the reduced budget a gate re-prompt gets
 * (`SendAndWaitOpts.reducedThinking`). A handoff that failed for any other
 * reason, an engine error or a turn that never wrote, keeps the full one.
 *
 * Reads the attempt history as well as `lastGateReject`: a gate that loops
 * back to its own step clears the latter when the step re-activates.
 */
export function stepGateRejectedSince(
  task: Pick<Task, 'craftbook'> | null | undefined,
  stepId: string,
  since: string,
): boolean {
  const step = task?.craftbook?.steps.find((candidate) => candidate.id === stepId);
  if (!step) return false;
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return false;
  const rejectedAt = [
    step.lastGateReject?.at,
    ...(step.gateAttemptHistory ?? []).map((entry) => entry.at),
  ];
  return rejectedAt.some((at) => at !== undefined && Date.parse(at) >= sinceMs);
}
