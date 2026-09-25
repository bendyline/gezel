import type { TaskCraftbookStep } from '../schemas/task.js';

/** The curated SDK view is shared by every host; routing and hook internals stay private. */
export function toScriptTaskStep(step: TaskCraftbookStep, activeStepId: string | undefined) {
  const isActive = step.id === activeStepId;
  return {
    id: step.id,
    name: step.name,
    ...(step.description !== undefined ? { description: step.description } : {}),
    status: isActive
      ? ('active' as const)
      : step.completedAt
        ? ('complete' as const)
        : ('pending' as const),
    isActive,
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
    ...(step.attemptCount !== undefined ? { attemptCount: step.attemptCount } : {}),
    ...(step.terminal !== undefined ? { terminal: step.terminal } : {}),
  };
}
