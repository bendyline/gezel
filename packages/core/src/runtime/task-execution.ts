import { effectiveGeneralistModeSetting } from '../generalist-mode.js';
import type { Task } from '../schemas/task.js';
import { pinCraftbookOwner } from '../task-execution.js';
import { executionModeForStrategy, resolveTaskStrategy } from '../task-strategy.js';
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
  if (!task.executionMode) {
    // Outcome runs only on the desktop; here its closest strategy stands in.
    const strategy = resolveTaskStrategy(
      {
        ...(config.taskStrategy ? { taskStrategy: config.taskStrategy } : {}),
        ...(effectiveGeneralistModeSetting(config)
          ? { generalistMode: effectiveGeneralistModeSetting(config) }
          : {}),
      },
      owner?.provider ?? config.provider ?? 'llama-cpp',
    );
    task.executionMode = executionModeForStrategy(strategy === 'outcome' ? 'generalist' : strategy);
  }
  task.strategy ??= task.executionMode;
  if (task.executionMode === 'generalist' && owner)
    pinCraftbookOwner(task.craftbook.steps, owner.id);
}
