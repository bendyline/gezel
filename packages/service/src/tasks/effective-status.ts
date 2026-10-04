/**
 * Reads one task and its ancestor chain to resolve inherited lifecycle state.
 * Chat and handoff checks use this instead of loading every historical task in
 * the project. The existing core projection defines pause/completion/cancel
 * inheritance, including missing parents and cycles. Reads are fresh on every
 * call so a parent pause or resume takes effect at the next dispatch boundary.
 */
import { type Task, parseTaskRef, withEffectiveTaskStatuses } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

type TaskReader = Pick<Store, 'readTask'>;

export async function readTaskWithEffectiveStatus(
  store: TaskReader,
  projectId: string,
  num: number,
): Promise<Task | null> {
  const task = await store.readTask(projectId, num);
  if (!task) return null;
  const lineage = [task];
  const seen = new Set([task.ref]);
  let parentRef = task.parentTaskRef;
  while (parentRef && !seen.has(parentRef)) {
    seen.add(parentRef);
    const parsed = parseTaskRef(parentRef);
    if (!parsed) break;
    const parent = await store.readTask(parsed.projectId, parsed.num);
    if (!parent) break;
    lineage.push(parent);
    parentRef = parent.parentTaskRef;
  }
  return withEffectiveTaskStatuses(lineage)[0] ?? null;
}
