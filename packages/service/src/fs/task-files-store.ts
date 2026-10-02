import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { KeyedLock, type Task, TaskSchema, createLogger, isSafeEntityId } from '@bendyline/gezel';
import {
  type ExternalFolders,
  gezelPaths,
  projectArtifactsDir,
  projectDiffpacksDir,
  projectDiffpacksFile,
  projectTaskAboutFile,
  projectTaskFile,
  projectTaskNextIdFile,
  projectTasksDir,
} from '@bendyline/gezel/paths';
import { HttpStatusError } from '@bendyline/gezel/runtime';
import { writeFileAtomic } from './atomic.js';
import { isSyncJunkName } from './sync-junk.js';

export interface TaskFilesStoreOptions {
  home: string;
  external?: ExternalFolders;
}

const taskWriteLocks = new KeyedLock();
const taskNumLocks = new KeyedLock();
const log = createLogger('task-store');

export class TaskWriteConflictError extends HttpStatusError {
  constructor(ref: string) {
    super(`Task ${ref} changed while it was being edited. Reload it and retry.`, 409);
    this.name = 'TaskWriteConflictError';
  }
}

/** Owns the file layout and legacy hydration for project task aggregates. */
export class TaskFilesStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly invalidTasks = new Map<string, string>();

  constructor(opts: TaskFilesStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
  }

  async nextProjectTaskNum(projectId: string): Promise<number> {
    // Task numbers are the identity scheme for tasks and diffpacks, so one
    // failed allocation must stay one failed allocation — the previous
    // hand-rolled chain kept the rejected promise as the queue head and
    // refused every later allocation for the project until restart.
    const file = projectTaskNextIdFile(this.home, projectId, this.external);
    return taskNumLocks.run(resolve(file), async () => {
      let current = 0;
      try {
        const raw = await readFile(file, 'utf8');
        current = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
        if (!Number.isSafeInteger(current) || current < 0) {
          log.warn(`Recovering invalid task counter ${file} from the existing task identities.`);
          current = 0;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(
            `Cannot read task counter ${file}; check its permissions before creating a task.`,
            { cause: err },
          );
        }
      }
      // A restored/stale counter can be valid yet lower than the surviving
      // tasks or outputs. Include every directory that reserves task IDs,
      // even when its task.json has been deleted or damaged.
      for (const dir of [
        projectTasksDir(this.home, projectId, this.external),
        join(projectArtifactsDir(this.home, projectId, this.external), 'tasks'),
        projectDiffpacksDir(this.home, projectId, this.external),
      ]) {
        for (const name of await readdirIfPresent(dir)) {
          if (/^\d+$/.test(name)) current = Math.max(current, reservedTaskNum(name, dir));
        }
      }
      const packsFile = projectDiffpacksFile(this.home, projectId);
      try {
        const packs = JSON.parse(await readFile(packsFile, 'utf8')) as { diffpacks?: unknown };
        if (!packs || !Array.isArray(packs.diffpacks)) throw new Error('invalid diffpacks list');
        for (const pack of packs.diffpacks) {
          if (!isRecord(pack) || typeof pack.packId !== 'string')
            throw new Error('invalid proposal identity');
          if (/^\d+$/.test(pack.packId))
            current = Math.max(current, reservedTaskNum(pack.packId, packsFile));
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(
            `Cannot recover task identities from ${packsFile}; repair it before creating a task.`,
            { cause: err },
          );
        }
      }
      const num = current + 1;
      if (!Number.isSafeInteger(num))
        throw new Error(`Task numbers are exhausted for ${projectId}.`);
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, `${num}\n`);
      return num;
    });
  }

  /** Reject stale aggregates and advance the caller's revision after a successful save. */
  async writeTask(task: Task): Promise<void> {
    const file = projectTaskFile(this.home, task.projectId, task.num, this.external);
    return taskWriteLocks.run(resolve(file), () => this.writeTaskVersion(file, task));
  }

  /** Creation never replaces an existing task, including legacy revision-zero records. */
  async createTask(task: Task): Promise<void> {
    const file = projectTaskFile(this.home, task.projectId, task.num, this.external);
    return taskWriteLocks.run(resolve(file), () => this.writeTaskVersion(file, task, true));
  }

  private async writeTaskVersion(file: string, task: Task, createOnly = false): Promise<void> {
    let current: Task | undefined;
    try {
      current = JSON.parse(await readFile(file, 'utf8')) as Task;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (
      (createOnly && current !== undefined) ||
      (current?.revision ?? 0) !== (task.revision ?? 0)
    ) {
      throw new TaskWriteConflictError(task.ref);
    }
    const revision = (current?.revision ?? 0) + 1;
    await mkdir(dirname(file), { recursive: true });
    // `effectiveStatus` is a runtime projection of the ancestry graph. Never
    // persist it: resuming a parent must reveal the child's unchanged own
    // status rather than a stale inherited snapshot.
    const { description, effectiveStatus: _effectiveStatus, ...rest } = task;
    void _effectiveStatus;
    await writeFileAtomic(file, `${JSON.stringify({ ...rest, revision }, null, 2)}\n`, {
      noReplace: createOnly,
    });
    if (description !== undefined && description.trim().length > 0) {
      await this.writeTaskAbout(task.projectId, task.num, description);
    } else {
      await this.deleteTaskAbout(task.projectId, task.num);
    }
    task.revision = revision;
  }

  async readTask(projectId: string, num: number): Promise<Task | null> {
    const file = projectTaskFile(this.home, projectId, num, this.external);
    return taskWriteLocks.run(resolve(file), () => this.readTaskVersion(projectId, num));
  }

  private async readTaskVersion(projectId: string, num: number): Promise<Task | null> {
    const file = projectTaskFile(this.home, projectId, num, this.external);
    try {
      const raw = await readFile(file, 'utf8');
      const normalized = normalizeLegacyTaskShape(JSON.parse(raw));
      const validated = TaskSchema.safeParse(normalized);
      if (!validated.success) {
        throw new Error(
          validated.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        );
      }
      // Validate known fields but keep additive fields (including nested
      // ones) so an older daemon does not erase newer metadata on save.
      const parsed = normalized as Task;
      if (
        parsed.projectId !== projectId ||
        parsed.num !== num ||
        parsed.ref !== `${projectId}/${num}`
      ) {
        throw new Error('task identity does not match its storage path');
      }
      if (
        ![parsed.createdAt, parsed.updatedAt].every((stamp) => Number.isFinite(Date.parse(stamp)))
      ) {
        throw new Error('createdAt and updatedAt must be valid timestamps');
      }
      const about = await this.readTaskAbout(projectId, num);
      if (about.length > 0) parsed.description = about;
      this.invalidTasks.delete(file);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.invalidTasks.delete(file);
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (this.invalidTasks.get(file) !== message) {
        log.warn(
          `Skipping unreadable task ${file}: ${message}. Repair this file or restore it from a backup.`,
        );
        this.invalidTasks.set(file, message);
      }
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
      // The projects root is an ordinary user-visible directory, so apply the
      // same centralized sync/OS-junk policy as other filesystem scanners.
      // Entity validation is a second boundary: it rejects `.git`, arbitrary
      // dot folders, and any other name that cannot safely be a project id.
      if (!isSafeEntityId(id) || isSyncJunkName(id)) continue;
      all.push(...(await this.listProjectTasks(id)));
    }
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return all;
  }
}

/** Map the pre-craftbook task shape onto the current aggregate. */
function normalizeLegacyTaskShape(raw: unknown): unknown {
  if (!isRecord(raw)) throw new Error('task must be an object');
  const task = raw;
  if (task.craftbook || !Array.isArray(task.phases)) return task;

  const { phases, activePhaseId, ...rest } = task;
  const legacyPhases = phases as unknown[];
  if (!legacyPhases.every(isRecord)) throw new Error('legacy phases must contain objects');
  for (const phase of legacyPhases) {
    for (const key of [
      'id',
      'name',
      'description',
      'createdAt',
      'completedAt',
      'suggestedGezelId',
      'suggestedRole',
    ]) {
      if (phase[key] !== undefined && typeof phase[key] !== 'string')
        throw new Error(`invalid legacy phase ${key}`);
    }
  }
  if (activePhaseId !== undefined && typeof activePhaseId !== 'string')
    throw new Error('invalid activePhaseId');
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
    createdAt,
    updatedAt,
    craftbook: {
      id: 'legacy',
      name: typeof task.title === 'string' ? task.title : 'Task',
      steps,
      entryStepId: ids[0],
      createdAt,
      updatedAt,
    },
    ...(typeof activePhaseId === 'string' ? { activeStepId: activePhaseId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reservedTaskNum(value: string, source: string): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num))
    throw new Error(`Invalid task number ${value} in ${source}; repair it before creating a task.`);
  return num;
}

async function readdirIfPresent(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Cannot read task identities in ${path}; check its permissions before creating a task.`,
      { cause: err },
    );
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
