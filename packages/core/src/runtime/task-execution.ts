import { effectiveGeneralistModeSetting, resolveTaskExecutionMode } from '../generalist-mode.js';
import type { Task } from '../schemas/task.js';
import { pinCraftbookOwner } from '../task-execution.js';
import { requireGezel } from './gezels.js';
import { readConfig } from './projects.js';
import type { PortableRepository } from './repository.js';

/** Resolve exactly once at first activation, under the task's transaction lock. */
export async function resolvePortableTaskExecution(
  repo: PortableRepository,
  task: Task,
): Promise<void> {
  const config = await readConfig(repo);
  const owner =
    task.assignee.kind === 'gezel' ? await requireGezel(repo, task.assignee.gezelId) : undefined;
  task.executionMode ??= resolveTaskExecutionMode(
    effectiveGeneralistModeSetting(config),
    owner?.provider ?? config.provider ?? 'llama-cpp',
  );
  if (task.executionMode === 'generalist' && owner)
    pinCraftbookOwner(task.craftbook.steps, owner.id);
}
