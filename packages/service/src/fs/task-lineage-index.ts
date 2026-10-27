/**
 * TaskLineageIndex
 *
 * An in-memory parent → children map over one store's tasks. Resuming a task
 * can reveal dormant descendants (a child inherits its ancestors' pause), so
 * the task runner re-reads the resumed task's subtree. Without this index the
 * only way to find that subtree was to read every task the project ever ran:
 * on a 115k-task media-review project each resume took 1.5–3 minutes and held
 * the status request open the whole time (2026-10-26).
 *
 * The store feeds the index. Every task it reads or writes is noted, and a
 * project counts as complete once one full listing of it has run to the end
 * (the boot rehydration does this for every live project). Tasks created after
 * that listing began are noted when they are written, so the index stays
 * complete for the life of the process. Until a project is complete,
 * `TaskFilesStore.listChildTaskNums` lists the project once to build it.
 *
 * Only tasks that name a parent take memory: two map entries each.
 *
 * Related files: `task-files-store.ts` (feeds and queries it),
 * `tasks/runner.ts` (`rehydrateFromStore({ rootTaskRef })`),
 * `tasks/effective-status.ts` (how a child inherits its ancestors' status).
 *
 * Gotchas: the index is only as current as the writes this process made. A
 * task file changed behind the store's back (a hand edit, a sync from another
 * machine) is noted on its next read. Callers must re-read each child and
 * check its `parentTaskRef`: an entry can outlive the task it names.
 */
import type { Task } from '@bendyline/gezel';

interface ProjectLineage {
  complete: boolean;
  /** Child task number → its parent's ref. */
  parentOf: Map<number, string>;
  /** Parent ref → child task numbers. */
  childrenOf: Map<string, Set<number>>;
}

export class TaskLineageIndex {
  private readonly projects = new Map<string, ProjectLineage>();

  /** Record (or correct) one task's parent link as it stands on disk. */
  note(task: Pick<Task, 'projectId' | 'num' | 'parentTaskRef'>): void {
    const previous = this.projects.get(task.projectId)?.parentOf.get(task.num);
    if (previous === task.parentTaskRef) return;
    const lineage = this.project(task.projectId);
    if (previous !== undefined) {
      const siblings = lineage.childrenOf.get(previous);
      siblings?.delete(task.num);
      if (siblings?.size === 0) lineage.childrenOf.delete(previous);
      lineage.parentOf.delete(task.num);
    }
    if (task.parentTaskRef) {
      lineage.parentOf.set(task.num, task.parentTaskRef);
      let children = lineage.childrenOf.get(task.parentTaskRef);
      if (!children) {
        children = new Set();
        lineage.childrenOf.set(task.parentTaskRef, children);
      }
      children.add(task.num);
    }
  }

  /** A full listing of the project finished: every task in it has been noted. */
  markComplete(projectId: string): void {
    this.project(projectId).complete = true;
  }

  isComplete(projectId: string): boolean {
    return this.projects.get(projectId)?.complete === true;
  }

  /** Numbers of the tasks in `projectId` noted as children of `parentRef`, ascending. */
  childNums(projectId: string, parentRef: string): number[] {
    const children = this.projects.get(projectId)?.childrenOf.get(parentRef);
    return children ? [...children].sort((a, b) => a - b) : [];
  }

  private project(projectId: string): ProjectLineage {
    let lineage = this.projects.get(projectId);
    if (!lineage) {
      lineage = { complete: false, parentOf: new Map(), childrenOf: new Map() };
      this.projects.set(projectId, lineage);
    }
    return lineage;
  }
}
