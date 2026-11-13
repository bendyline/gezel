import { normalizeArtifactPath } from '../path-rules.js';
import type { TaskCraftbook } from '../schemas/task.js';
import { stepCheckedArtifactPaths } from '../tools/results.js';

/**
 * Whether a task reads `path` from the artifacts drawer: a contract
 * deliverable placed there (a folder deliverable covers the files inside
 * it), or a file the active step's checks read from the drawer.
 *
 * `write_artifact` refuses a path a workspace file already holds, to stop a
 * side-drawer copy of a project file. When the task reads that path from the
 * drawer, the refusal blocks the one write that delivers the work: a Gemma 4
 * E4B owner that first wrote `tasks/eval/report.md` into the workspace by
 * mistake was then refused the right drawer three times, and the turn aborted
 * with nothing delivered (review re-measurement, 2026-11-12).
 */
export function taskReadsArtifactAt(
  task: { activeStepId?: string | undefined; craftbook: Pick<TaskCraftbook, 'steps' | 'contract'> },
  path: string,
): boolean {
  const target = normalizeArtifactPath(path).replace(/\/+$/, '');
  if (!target) return false;
  const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
  if (stepCheckedArtifactPaths(step).includes(target)) return true;
  return (task.craftbook.contract?.deliverables ?? []).some((d) => {
    if (d.artifact !== true) return false;
    const where = normalizeArtifactPath(d.path).replace(/\/+$/, '');
    return where !== '' && (target === where || target.startsWith(`${where}/`));
  });
}
