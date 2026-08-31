import type { ScriptOutputPredicate, ScriptRef, Task, TaskCraftbookStep } from '@bendyline/gezel';

/** Return the first branch whose predicate matches the supplied script output. */
export function findBranchGoto(
  branches: { when: ScriptOutputPredicate; goto: string }[],
  output: unknown,
): string | undefined {
  for (const branch of branches) {
    if (evaluatePredicate(branch.when, output)) return branch.goto;
  }
  return undefined;
}

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

/** Evaluate the on-enter shorthand that decides whether a step advances. */
export function shouldAutoAdvance(ref: ScriptRef, output: unknown): boolean {
  const predicate: ScriptOutputPredicate | undefined =
    ref.autoAdvanceWhen ?? (ref.autoAdvanceOnSuccess ? { op: 'ok' } : undefined);
  if (!predicate) return false;
  return evaluatePredicate(predicate, output);
}

function evaluatePredicate(predicate: ScriptOutputPredicate, output: unknown): boolean {
  switch (predicate.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'ok':
      return !isRecord(output) || output.ok !== false;
    case 'equals':
      return readFieldPath(output, predicate.field) === predicate.value;
    case 'exists': {
      const value = readFieldPath(output, predicate.field);
      const exists = value !== undefined && value !== null;
      return predicate.negate ? !exists : exists;
    }
    case 'gt': {
      const value = readFieldPath(output, predicate.field);
      return typeof value === 'number' && value > predicate.value;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFieldPath(output: unknown, path: string): unknown {
  if (output === null || output === undefined) return undefined;
  let current: unknown = output;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && segment === 'length') {
      current = current.length;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
