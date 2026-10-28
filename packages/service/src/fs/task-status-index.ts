/**
 * TaskStatusIndex
 *
 * An in-memory map from a project's live statuses (draft, active, paused) to
 * the task numbers holding them, plus how many tasks the project has and when
 * the newest of them last changed. Finding the active tasks used to mean
 * reading every task the home ever ran: on a 132k-task media-review project
 * the scheduler did that twice per tick, and with 40 workers one tick ran for
 * 17 minutes, so stuck steps and crons were checked about four times an hour
 * (2026-10-27). Only 765 of those tasks were not complete.
 *
 * The store feeds the index exactly as it feeds `TaskLineageIndex`: every task
 * it reads or writes is noted, a missing task is forgotten, and a project
 * counts as complete once one full listing of it has run to the end. Tasks
 * written after that listing began are noted when they are written, so the
 * index stays complete for the life of the process.
 *
 * Usage: `TaskFilesStore.iterateProjectTasksWithStatus` builds the index once
 * (one shared full listing) and then reads only the numbers in the status's
 * bucket; `TaskFilesStore.projectTaskSummary` answers "does the project have
 * tasks, and when did one last change" without reading any.
 *
 * Related files: `task-files-store.ts` (feeds and queries it),
 * `task-lineage-index.ts` (parent links, built by the same listing),
 * `tasks/manager.ts` (`list({ status })`), `tasks/scheduler.ts`.
 *
 * Gotchas: an entry is only as current as the last read or write of its task,
 * so callers re-read each task and check its status. A task file changed
 * behind the store's back (a hand edit, a sync from another machine) is
 * noticed on its next read, or at the next process start. Terminal statuses
 * (complete, canceled) are not bucketed; nothing asks for them by status.
 * `latestUpdatedAt` is a high-water mark: deleting the newest task leaves it.
 */
import type { Task, TaskStatus } from '@bendyline/gezel';

/** What a project's index knows without reading a task. */
export interface ProjectTaskSummary {
  taskCount: number;
  latestUpdatedAt?: string;
}

/** The statuses the index can list tasks by. */
export type LiveTaskStatus = Extract<TaskStatus, 'draft' | 'active' | 'paused'>;

const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<LiveTaskStatus>([
  'draft',
  'active',
  'paused',
]);

interface ProjectStatuses {
  complete: boolean;
  /** Every task number noted in the project. */
  known: Set<number>;
  live: Map<LiveTaskStatus, Set<number>>;
  latestUpdatedMs: number;
  latestUpdatedAt?: string;
}

export class TaskStatusIndex {
  private readonly projects = new Map<string, ProjectStatuses>();

  /** Record (or correct) one task's status as it stands on disk. */
  note(task: Pick<Task, 'projectId' | 'num' | 'status' | 'updatedAt'>): void {
    const project = this.project(task.projectId);
    project.known.add(task.num);
    for (const [status, nums] of project.live) {
      if (status !== task.status) nums.delete(task.num);
    }
    if (LIVE_STATUSES.has(task.status)) {
      const status = task.status as LiveTaskStatus;
      let nums = project.live.get(status);
      if (!nums) {
        nums = new Set();
        project.live.set(status, nums);
      }
      nums.add(task.num);
    }
    const updatedMs = Date.parse(task.updatedAt);
    if (Number.isFinite(updatedMs) && updatedMs > project.latestUpdatedMs) {
      project.latestUpdatedMs = updatedMs;
      project.latestUpdatedAt = task.updatedAt;
    }
  }

  /** The task is gone (or unreadable): drop it from every bucket. */
  forget(projectId: string, num: number): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.known.delete(num);
    for (const nums of project.live.values()) nums.delete(num);
  }

  /** A full listing of the project finished: every task in it has been noted. */
  markComplete(projectId: string): void {
    this.project(projectId).complete = true;
  }

  isComplete(projectId: string): boolean {
    return this.projects.get(projectId)?.complete === true;
  }

  /** Numbers of the tasks in `projectId` noted with `status`, newest (highest) first. */
  nums(projectId: string, status: LiveTaskStatus): number[] {
    const nums = this.projects.get(projectId)?.live.get(status);
    return nums ? [...nums].sort((a, b) => b - a) : [];
  }

  /** How many tasks the project has, and the newest `updatedAt` among them. */
  summary(projectId: string): ProjectTaskSummary {
    const project = this.projects.get(projectId);
    if (!project) return { taskCount: 0 };
    return {
      taskCount: project.known.size,
      ...(project.latestUpdatedAt ? { latestUpdatedAt: project.latestUpdatedAt } : {}),
    };
  }

  private project(projectId: string): ProjectStatuses {
    let project = this.projects.get(projectId);
    if (!project) {
      project = { complete: false, known: new Set(), live: new Map(), latestUpdatedMs: 0 };
      this.projects.set(projectId, project);
    }
    return project;
  }
}
