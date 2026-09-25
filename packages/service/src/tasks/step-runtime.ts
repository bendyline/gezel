import type { Task, TaskCraftbookStep } from '@bendyline/gezel';

export {
  bumpStepActivation,
  scriptBranchGoto as findBranchGoto,
  scriptShouldAutoAdvance as shouldAutoAdvance,
} from '@bendyline/gezel';

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
