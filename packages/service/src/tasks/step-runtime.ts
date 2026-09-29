import type { Task } from '@bendyline/gezel';

export {
  bumpStepActivation,
  scriptBranchGoto as findBranchGoto,
  isOwnerStep,
  scriptShouldAutoAdvance as shouldAutoAdvance,
  stepOwnerGezelId,
} from '@bendyline/gezel';

/** Return the catalog identity of the main craftbook walked by this task. */
export function mainBookSource(task: Task): { catalogId: string; version?: string } {
  const main = task.sourceCraftbookIds?.find((source) => source.role === 'main');
  if (main) {
    return { catalogId: main.catalogId, ...(main.version ? { version: main.version } : {}) };
  }
  return { catalogId: task.craftbook.id };
}
