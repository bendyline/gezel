import type { Task, TaskCraftbookStep } from '@bendyline/gezel';

export {
  scriptBranchGoto as findBranchGoto,
  scriptShouldAutoAdvance as shouldAutoAdvance,
} from '@bendyline/gezel';

/**
 * Stamp an activation and clear state that belongs to the previous pass.
 * Self-loop gate rejections can preserve their finite recovery budget.
 */
export function bumpStepActivation(
  steps: TaskCraftbookStep[],
  stepId: string,
  at: string,
  opts?: { preserveGateBudget?: boolean },
): TaskCraftbookStep[] {
  return steps.map((step) => {
    if (step.id !== stepId) return step;
    const {
      completedAt: _done,
      onEnterCompletedAt: _entered,
      gateAttempts: _gateAttempts,
      gateProgressAttempts: _gateProgressAttempts,
      lastGateReject: _lastGateReject,
      redriveCount: _redriveCount,
      lastRedriveAt: _lastRedriveAt,
      restartResumeCount: _restartResumeCount,
      lastRestartResumeAt: _lastRestartResumeAt,
      ...rest
    } = step;
    void _done;
    void _entered;
    void _gateAttempts;
    void _gateProgressAttempts;
    void _lastGateReject;
    void _redriveCount;
    void _lastRedriveAt;
    void _restartResumeCount;
    void _lastRestartResumeAt;

    const bumped = {
      ...rest,
      attemptCount: (step.attemptCount ?? 0) + 1,
      lastActivatedAt: at,
    };
    if (!opts?.preserveGateBudget) return bumped;

    return {
      ...bumped,
      ...(step.gateAttempts !== undefined ? { gateAttempts: step.gateAttempts } : {}),
      ...(step.gateProgressAttempts !== undefined
        ? { gateProgressAttempts: step.gateProgressAttempts }
        : {}),
      ...(step.lastGateReject !== undefined ? { lastGateReject: step.lastGateReject } : {}),
    };
  });
}

/** Resolve the gezel accountable for a step from its three assignee levels. */
export function stepOwnerGezelId(task: Task, step: TaskCraftbookStep): string | undefined {
  if (step.assignee?.kind === 'gezel') return step.assignee.gezelId;
  if (step.suggestedGezelId) return step.suggestedGezelId;
  return task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined;
}

/** Return the catalog identity of the main craftbook walked by this task. */
export function mainBookSource(task: Task): { catalogId: string; version?: string } {
  const main = task.sourceCraftbookIds?.find((source) => source.role === 'main');
  if (main) {
    return { catalogId: main.catalogId, ...(main.version ? { version: main.version } : {}) };
  }
  return { catalogId: task.craftbook.id };
}
