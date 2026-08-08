import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Task } from '@bendyline/gezel';
import {
  type ExternalFolders,
  gezelPaths,
  projectTaskAboutFile,
  projectTaskFile,
  projectTaskNextIdFile,
  projectTasksDir,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from './atomic.js';

export interface TaskFilesStoreOptions {
  home: string;
  external?: ExternalFolders;
}

/** Owns the file layout and legacy hydration for project task aggregates. */
export class TaskFilesStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly taskNumLocks = new Map<string, Promise<number>>();

  constructor(opts: TaskFilesStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
  }

  async nextProjectTaskNum(projectId: string): Promise<number> {
    const prior = this.taskNumLocks.get(projectId) ?? Promise.resolve(0);
    const next = prior.then(async () => {
      const file = projectTaskNextIdFile(this.home, projectId, this.external);
      let current = 0;
      try {
        const raw = await readFile(file, 'utf8');
        current = Number.parseInt(raw.trim(), 10);
        if (!Number.isFinite(current) || current < 0) current = 0;
      } catch {
        /* first allocation */
      }
      const num = current + 1;
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, `${num}\n`);
      return num;
    });
    this.taskNumLocks.set(projectId, next);
    return next;
  }

  async writeTask(task: Task): Promise<void> {
    const file = projectTaskFile(this.home, task.projectId, task.num, this.external);
    await mkdir(dirname(file), { recursive: true });
    const { description, ...rest } = task;
    await writeFileAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
    if (description !== undefined && description.trim().length > 0) {
      await this.writeTaskAbout(task.projectId, task.num, description);
    } else {
      await this.deleteTaskAbout(task.projectId, task.num);
    }
  }

  async readTask(projectId: string, num: number): Promise<Task | null> {
    try {
      const raw = await readFile(projectTaskFile(this.home, projectId, num, this.external), 'utf8');
      const parsed = normalizeLegacyTaskShape(JSON.parse(raw));
      const about = await this.readTaskAbout(projectId, num);
      if (about.length > 0) parsed.description = about;
      return parsed;
    } catch {
      return null;
    }
  }

  async readTaskAbout(projectId: string, num: number): Promise<string> {
    try {
      return await readFile(projectTaskAboutFile(this.home, projectId, num, this.external), 'utf8');
    } catch {
      return '';
    }
  }

  async writeTaskAbout(projectId: string, num: number, body: string): Promise<void> {
    const file = projectTaskAboutFile(this.home, projectId, num, this.external);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, body);
  }

  async deleteTaskAbout(projectId: string, num: number): Promise<void> {
    const file = projectTaskAboutFile(this.home, projectId, num, this.external);
    try {
      await rm(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const names = await safeReaddir(projectTasksDir(this.home, projectId, this.external));
    const tasks: Task[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const task = await this.readTask(projectId, Number.parseInt(name, 10));
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => b.num - a.num);
    return tasks;
  }

  async listAllTasks(): Promise<Task[]> {
    const projectIds = await safeReaddir(gezelPaths(this.home).projects);
    const all: Task[] = [];
    for (const id of projectIds) {
      all.push(...(await this.listProjectTasks(id)));
    }
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return all;
  }
}

/** Map the pre-craftbook task shape onto the current aggregate. */
function normalizeLegacyTaskShape(raw: unknown): Task {
  const task = raw as Record<string, unknown>;
  if (task.craftbook || !Array.isArray(task.phases)) return task as unknown as Task;

  const { phases, activePhaseId, ...rest } = task;
  const legacyPhases = phases as Array<Record<string, unknown>>;
  const createdAt =
    typeof task.createdAt === 'string' ? task.createdAt : '1970-01-01T00:00:00.000Z';
  const updatedAt = typeof task.updatedAt === 'string' ? task.updatedAt : createdAt;
  const ids = legacyPhases.map((phase, index) =>
    typeof phase.id === 'string' ? phase.id : `step-${index + 1}`,
  );
  const steps = legacyPhases.map((phase, index) => {
    const step: Record<string, unknown> = {
      id: ids[index],
      name: typeof phase.name === 'string' ? phase.name : `Step ${index + 1}`,
      createdAt: typeof phase.createdAt === 'string' ? phase.createdAt : createdAt,
    };
    if (typeof phase.description === 'string') step.description = phase.description;
    if (typeof phase.suggestedGezelId === 'string') {
      step.suggestedGezelId = phase.suggestedGezelId;
    }
    if (typeof phase.suggestedRole === 'string') step.suggestedRole = phase.suggestedRole;
    if (typeof phase.completedAt === 'string') step.completedAt = phase.completedAt;
    if (index < legacyPhases.length - 1) step.next = ids[index + 1];
    else step.terminal = true;
    return step;
  });
  if (steps.length === 0) {
    ids.push('main');
    steps.push({
      id: 'main',
      name: typeof task.title === 'string' ? task.title : 'Task',
      createdAt,
      terminal: true,
    });
  }

  return {
    ...rest,
    craftbook: {
      id: 'legacy',
      name: typeof task.title === 'string' ? task.title : 'Task',
      steps,
      entryStepId: ids[0],
      createdAt,
      updatedAt,
    },
    ...(typeof activePhaseId === 'string' ? { activeStepId: activePhaseId } : {}),
  } as unknown as Task;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
