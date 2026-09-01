export interface TaskStepMutationScope {
  taskRef: string;
  sessionStepId: string;
  activeStepId?: string;
  /** True once this MCP process successfully completed its own step. */
  transitionCompleted: boolean;
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
  return `Step "${sessionStepId}" on ${taskRef} no longer owns project writes.${active} Stop this turn and yield to the active step's gezel. Do not rewrite, append to, move, or delete the completed step's deliverable.`;
}
