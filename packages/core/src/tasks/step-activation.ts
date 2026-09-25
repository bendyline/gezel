/**
 * Stamp an activation onto a step and clear the state that belonged to its
 * previous pass. `attemptCount` counts activations, so a loop-back shows as
 * one more pass; a self-loop gate rejection may keep its finite recovery
 * budget, which is the one thing a fresh pass must not reset.
 */
import type { TaskCraftbookStep } from '../schemas/task.js';

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
