/**
 * TaskWorkIndex
 *
 * Each gezel's completed task work (steps and tasks, as `countTaskWork`
 * credits them), summed over every task the store has seen and kept current
 * as tasks change. XP needs these totals; computing them meant reading every
 * task in the home once per gezel per refresh. On a 132k-task home one
 * refresh took 3–8 minutes, and the memory compactor's sweep ran one per
 * gezel back to back (2026-10-27).
 *
 * The store feeds the index exactly as it feeds `TaskStatusIndex`: every task
 * it reads or writes is noted (replacing that task's previous credits), a
 * missing task is forgotten, and a project counts as complete once one full
 * listing of it has run to the end. `TaskFilesStore.taskWorkFor` lists each
 * project once to complete it, then answers from memory.
 *
 * Only tasks that credit someone take memory: one small entry per task.
 *
 * Related files: `task-files-store.ts` (feeds and queries it),
 * `core/src/growth/xp.ts` (`taskWorkCredits`, the crediting rule),
 * `growth/engine.ts` (the consumer), `task-status-index.ts` (the same pattern).
 *
 * Gotchas: like the other task indexes, a task file changed behind the
 * store's back counts at its next read. XP ratchets, so a total that is
 * briefly low never lowers anyone's XP.
 */
import { type Task, type TaskWorkCredit, taskWorkCredits } from '@bendyline/gezel';

/** `[gezelId, completedSteps, completedTasks]` for each gezel one task credits. */
type TaskCredits = Array<[string, number, number]>;

export class TaskWorkIndex {
  /** Project → task number → what that task credits. */
  private readonly credits = new Map<string, Map<number, TaskCredits>>();
  private readonly totals = new Map<string, TaskWorkCredit>();
  private readonly complete = new Set<string>();

  /** Record (or correct) one task's credits as it stands on disk. */
  note(task: Pick<Task, 'projectId' | 'num' | 'status' | 'assignee' | 'craftbook'>): void {
    const next: TaskCredits = [];
    for (const [gezelId, credit] of taskWorkCredits(task)) {
      next.push([gezelId, credit.completedSteps, credit.completedTasks]);
    }
    const project = this.project(task.projectId);
    const previous = project.get(task.num);
    if (previous && sameCredits(previous, next)) return;
    if (previous) this.apply(previous, -1);
    if (next.length > 0) {
      project.set(task.num, next);
      this.apply(next, 1);
    } else {
      project.delete(task.num);
    }
  }

  /** The task is gone (or unreadable): take back what it credited. */
  forget(projectId: string, num: number): void {
    const project = this.credits.get(projectId);
    const previous = project?.get(num);
    if (!project || !previous) return;
    this.apply(previous, -1);
    project.delete(num);
  }

  /** A full listing of the project finished: every task in it has been noted. */
  markComplete(projectId: string): void {
    this.complete.add(projectId);
  }

  isComplete(projectId: string): boolean {
    return this.complete.has(projectId);
  }

  /** The gezel's completed steps and tasks across every noted task. */
  totalsFor(gezelId: string): TaskWorkCredit {
    const total = this.totals.get(gezelId);
    return {
      completedSteps: total?.completedSteps ?? 0,
      completedTasks: total?.completedTasks ?? 0,
    };
  }

  private apply(credits: TaskCredits, sign: 1 | -1): void {
    for (const [gezelId, steps, tasks] of credits) {
      let total = this.totals.get(gezelId);
      if (!total) {
        total = { completedSteps: 0, completedTasks: 0 };
        this.totals.set(gezelId, total);
      }
      total.completedSteps += sign * steps;
      total.completedTasks += sign * tasks;
    }
  }

  private project(projectId: string): Map<number, TaskCredits> {
    let project = this.credits.get(projectId);
    if (!project) {
      project = new Map();
      this.credits.set(projectId, project);
    }
    return project;
  }
}

function sameCredits(a: TaskCredits, b: TaskCredits): boolean {
  return (
    a.length === b.length &&
    a.every(([gezelId, steps, tasks], i) => {
      const other = b[i];
      return other?.[0] === gezelId && other[1] === steps && other[2] === tasks;
    })
  );
}
