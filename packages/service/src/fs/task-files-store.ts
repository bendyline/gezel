import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  KeyedLock,
  type Task,
  TaskSchema,
  type TaskWorkCredit,
  accrueTaskWork,
  createLogger,
  isSafeEntityId,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { beginPerfWork } from '@bendyline/gezel-inference/internal/perf/responsiveness';
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
import { FileSnapshotCache } from './file-snapshot-cache.js';
import { isSyncJunkName } from './sync-junk.js';
import { TaskLineageIndex } from './task-lineage-index.js';
import {
  type LiveTaskStatus,
  type ProjectTaskSummary,
  TaskStatusIndex,
} from './task-status-index.js';
import { TaskWorkIndex } from './task-work-index.js';

export interface TaskFilesStoreOptions {
  home: string;
  external?: ExternalFolders;
}

const taskWriteLocks = new KeyedLock();
const taskNumLocks = new KeyedLock();
const log = createLogger('task-store');
/**
 * The largest task number a folder in the artifacts drawer may reserve. No
 * project creates a billion tasks; anything above this is a stray folder.
 */
const MAX_DRAWER_TASK_NUM = 1_000_000_000;

export class TaskWriteConflictError extends HttpStatusError {
  constructor(ref: string) {
    super(`Task ${ref} changed while it was being edited. Reload it and retry.`, 409);
    this.name = 'TaskWriteConflictError';
  }
}

/**
 * A task record the reader would refuse. Writing it made the task vanish with
 * no error: every later read skipped the file as unreadable.
 */
export class InvalidTaskWriteError extends HttpStatusError {
  constructor(ref: string, problem: string) {
    super(`Task ${ref} was not saved because it would not load back: ${problem}`, 400);
    this.name = 'InvalidTaskWriteError';
  }
}

/** Owns the file layout and legacy hydration for project task aggregates. */
export class TaskFilesStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly invalidTasks = new Map<string, string>();
  private readonly records = new FileSnapshotCache<Task>(16 * 1024 * 1024);
  private readonly descriptions = new FileSnapshotCache<string>(8 * 1024 * 1024);
  private readonly lineage = new TaskLineageIndex();
  private readonly statuses = new TaskStatusIndex();
  private readonly work = new TaskWorkIndex();
  /** One shared full listing per project that completes every index. */
  private readonly indexBuilds = new Map<string, Promise<void>>();

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
      const tasksDir = projectTasksDir(this.home, projectId, this.external);
      for (const name of await readdirIfPresent(tasksDir)) {
        if (/^\d+$/.test(name)) current = Math.max(current, reservedTaskNum(name, tasksDir));
      }
      // Gezels can create folders in the artifacts drawer, so a folder name
      // there is a hint, not a record: one stray `tasks/99999999999999999999`
      // must not block task creation for the project, and one near the top of
      // the range must not use the range up.
      for (const dir of [
        join(projectArtifactsDir(this.home, projectId, this.external), 'tasks'),
        projectDiffpacksDir(this.home, projectId, this.external),
      ]) {
        for (const name of await readdirIfPresent(dir)) {
          if (!/^\d+$/.test(name)) continue;
          const num = Number(name);
          if (Number.isSafeInteger(num) && num <= MAX_DRAWER_TASK_NUM) {
            current = Math.max(current, num);
          } else {
            log.warn(
              `Ignoring ${join(dir, name)} when numbering tasks: no task can have that number.`,
            );
          }
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
    // `effectiveStatus` is a runtime projection of the ancestry graph. Never
    // persist it: resuming a parent must reveal the child's unchanged own
    // status rather than a stale inherited snapshot.
    const {
      description,
      effectiveStatus: _effectiveStatus,
      ...rest
    } = accrueTaskWork(current, task);
    void _effectiveStatus;
    const text = `${JSON.stringify({ ...rest, revision }, null, 2)}\n`;
    // The record is checked exactly as a read will check it. An inline step
    // whose tool policy removed a protected tool (`ask_user_question`) was
    // created, then skipped as unreadable on every read, and the task
    // silently disappeared (2026-10-08).
    try {
      checkStoredTask(JSON.parse(text), task.projectId, task.num);
    } catch (err) {
      throw new InvalidTaskWriteError(task.ref, err instanceof Error ? err.message : String(err));
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, text, {
      noReplace: createOnly,
    });
    this.noteTask(task);
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
      const cached = await this.records.read(file, async () =>
        checkStoredTask(JSON.parse(await readFile(file, 'utf8')), projectId, num),
      );
      if (!cached) {
        this.invalidTasks.delete(file);
        this.forgetTask(projectId, num);
        return null;
      }
      this.noteTask(cached);
      // TaskManager edits aggregates before persisting them. Keep those
      // drafts separate from the validated, immutable disk snapshot.
      const parsed = structuredClone(cached);
      const about = await this.readTaskAbout(projectId, num);
      if (about.length > 0) parsed.description = about;
      this.invalidTasks.delete(file);
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.forgetTask(projectId, num);
        this.invalidTasks.delete(file);
        return null;
      }
      // A file that does not parse leaves the indexes. One that could not be
      // read right now (EBUSY or EPERM from antivirus, a backup or a synced
      // folder) is still a task: forgetting it left an active task undispatched
      // until restart on a daemon running without the app (1.26300.100 audit).
      if (!code) this.forgetTask(projectId, num);
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
      const file = projectTaskAboutFile(this.home, projectId, num, this.external);
      return (await this.descriptions.read(file, () => readFile(file, 'utf8'))) ?? '';
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

  /** Stream newest first so existence checks can stop without retaining history. */
  async *iterateProjectTasks(projectId: string): AsyncGenerator<Task> {
    const names = await readdirIfReadable(projectTasksDir(this.home, projectId, this.external));
    const nums = (names ?? [])
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => b - a);
    for (const num of nums) {
      const task = await this.readTask(projectId, num);
      if (task) yield task;
    }
    // A listing that failed proves nothing about the project: marking it
    // complete would make it look empty to the scheduler until restart.
    if (!names) return;
    // Every task file in the project has now been read (and noted); tasks
    // created since the directory listing were noted when they were written.
    this.lineage.markComplete(projectId);
    this.statuses.markComplete(projectId);
    this.work.markComplete(projectId);
  }

  /**
   * Tasks in `projectId` whose own status is `status`, newest first, from the
   * status index. The first call for a project that has not been listed in
   * full yet lists it once; later calls read only the tasks in the bucket.
   * Each is re-read, so a stale entry costs one read, never a wrong answer.
   */
  async *iterateProjectTasksWithStatus(
    projectId: string,
    status: LiveTaskStatus,
  ): AsyncGenerator<Task> {
    await this.ensureIndexed(projectId);
    for (const num of this.statuses.nums(projectId, status)) {
      const task = await this.readTask(projectId, num);
      if (task?.status === status) yield task;
    }
  }

  /** {@link iterateProjectTasksWithStatus} across every project, project by project. */
  async *iterateAllTasksWithStatus(status: LiveTaskStatus): AsyncGenerator<Task> {
    for (const id of await this.listProjectIds()) {
      yield* this.iterateProjectTasksWithStatus(id, status);
    }
  }

  /**
   * A gezel's completed steps and tasks across every project, as
   * `countTaskWork` would count them over all tasks. Each project is listed
   * once per process to build the index; later calls read only memory.
   */
  async taskWorkFor(gezelId: string): Promise<TaskWorkCredit> {
    for (const id of await this.listProjectIds()) await this.ensureIndexed(id);
    return this.work.totalsFor(gezelId);
  }

  /** How many tasks `projectId` has and the newest `updatedAt` among them, without reading any. */
  async projectTaskSummary(projectId: string): Promise<ProjectTaskSummary> {
    await this.ensureIndexed(projectId);
    return this.statuses.summary(projectId);
  }

  /**
   * Numbers of the tasks whose `parentTaskRef` is `parentRef`, from the
   * lineage index. The first call for a project that has not been listed in
   * full yet lists it once; later calls read only memory. Entries can be
   * stale, so callers re-read each child and check its parent.
   */
  async listChildTaskNums(projectId: string, parentRef: string): Promise<number[]> {
    await this.ensureIndexed(projectId);
    return this.lineage.childNums(projectId, parentRef);
  }

  private noteTask(task: Task): void {
    this.lineage.note(task);
    this.statuses.note(task);
    this.work.note(task);
  }

  /** The task's file is gone or does not parse. Lineage entries are re-checked by their callers. */
  private forgetTask(projectId: string, num: number): void {
    this.statuses.forget(projectId, num);
    this.work.forget(projectId, num);
  }

  /** List the project once, shared by concurrent callers, unless every index is complete. */
  private async ensureIndexed(projectId: string): Promise<void> {
    if (
      this.lineage.isComplete(projectId) &&
      this.statuses.isComplete(projectId) &&
      this.work.isComplete(projectId)
    )
      return;
    let build = this.indexBuilds.get(projectId);
    if (!build) {
      build = (async () => {
        const end = beginPerfWork('task history: task index build');
        try {
          for await (const _task of this.iterateProjectTasks(projectId)) void _task;
        } finally {
          end();
        }
      })().finally(() => this.indexBuilds.delete(projectId));
      this.indexBuilds.set(projectId, build);
    }
    await build;
  }

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const end = beginPerfWork('task history: full project listing');
    try {
      const tasks: Task[] = [];
      for await (const task of this.iterateProjectTasks(projectId)) tasks.push(task);
      return tasks;
    } finally {
      end();
    }
  }

  async *iterateAllTasks(): AsyncGenerator<Task> {
    for (const id of await this.listProjectIds()) {
      yield* this.iterateProjectTasks(id);
    }
  }

  private async listProjectIds(): Promise<string[]> {
    // The projects root is an ordinary user-visible directory, so apply the
    // same centralized sync/OS-junk policy as other filesystem scanners.
    // Entity validation is a second boundary: it rejects `.git`, arbitrary
    // dot folders, and any other name that cannot safely be a project id.
    return (await safeReaddir(gezelPaths(this.home).projects)).filter(
      (id) => isSafeEntityId(id) && !isSyncJunkName(id),
    );
  }

  async listAllTasks(): Promise<Task[]> {
    const end = beginPerfWork('task history: full global listing');
    try {
      const all: Task[] = [];
      for await (const task of this.iterateAllTasks()) all.push(task);
      all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return all;
    } finally {
      end();
    }
  }
}

/**
 * The stored record as a task, or the reason it is not one. Reads and writes
 * both go through this, so nothing is saved that would not load back.
 */
function checkStoredTask(raw: unknown, projectId: string, num: number): Task {
  const normalized = normalizeLegacyTaskShape(raw);
  const validated = TaskSchema.safeParse(normalized);
  if (!validated.success) {
    throw new Error(
      validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
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
  if (![parsed.createdAt, parsed.updatedAt].every((stamp) => Number.isFinite(Date.parse(stamp)))) {
    throw new Error('createdAt and updatedAt must be valid timestamps');
  }
  return parsed;
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
  return (await readdirIfReadable(path)) ?? [];
}

/** A directory's entries: [] when it does not exist, null when it could not be read. */
async function readdirIfReadable(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? [] : null;
  }
}
