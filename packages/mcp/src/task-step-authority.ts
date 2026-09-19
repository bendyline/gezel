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
