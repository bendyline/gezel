import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { CodeReviewManifestSchema } from '@bendyline/gezel';
import { projectCodeReviewsFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { GitManager, GitReviewSnapshot } from './manager.js';
import { CodeReviewManager, ReviewInProgressError } from './reviews.js';

vi.mock('./review-task.js', () => ({
  createReviewTask: vi.fn(),
}));
vi.mock('../tasks/entry-dispatch.js', () => ({
  dispatchTaskEntry: vi.fn(async () => ({ enqueued: true, gezelId: 'rex' })),
}));

const { createReviewTask } = await import('./review-task.js');
const { dispatchTaskEntry } = await import('../tasks/entry-dispatch.js');

let home: string;
let store: Store;
let manager: CodeReviewManager;
let projectId: string;
let taskStore: Map<string, Task>;
let taskNum = 0;

function fakeTask(status: Task['status'] = 'active'): Task {
  taskNum++;
  const ref = `${projectId}/${taskNum}`;
  const task = {
    projectId,
    num: taskNum,
    ref,
    title: 'Code review',
    status,
    assignee: { kind: 'gezel', gezelId: 'rex' },
    craftbook: {
      id: 'inline',
      name: 'Inline',
      steps: [
        { id: 'review-report', name: 'Report', createdAt: 'now' },
        { id: 'review-done', name: 'Done', terminal: true, createdAt: 'now' },
      ],
      entryStepId: 'review-report',
      createdAt: 'now',
      updatedAt: 'now',
    },
    activeStepId: 'review-report',
    createdAt: 'now',
    updatedAt: 'now',
  } as unknown as Task;
  taskStore.set(ref, task);
  return task;
}

function snapshot(kind: 'commit' | 'pr'): GitReviewSnapshot {
  return {
    kind,
    branch: kind === 'pr' ? 'feature/x' : 'main',
    headSha: 'abc123',
    baseRef: kind === 'pr' ? 'origin/main' : 'HEAD',
    baseSha: kind === 'pr' ? 'def456' : 'abc123',
    files: [
      { path: 'src/a.ts', kind: 'modified', additions: 3, deletions: 1 },
      { path: 'img/logo.png', kind: 'added', binary: true },
    ],
    totalFiles: 2,
    filesTruncated: false,
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+new line\n',
    diffTruncated: false,
    ...(kind === 'pr'
      ? {
          commits: [
            {
              sha: 'abc123',
              shortSha: 'abc123',
              author: 'Ada',
              date: 'now',
              subject: 'change',
              filesChanged: 1,
              additions: 1,
              deletions: 0,
            },
          ],
          commitsTruncated: false,
        }
      : {}),
    notes: [],
  };
}

const git = {
  snapshotWorkingChanges: vi.fn(async () => snapshot('commit')),
  snapshotBranchDiff: vi.fn(async () => snapshot('pr')),
} as unknown as GitManager;

const tasks = {
  getByRef: vi.fn(async (ref: string) => taskStore.get(ref) ?? null),
  setStatus: vi.fn(async (pid: string, num: number, status: Task['status']) => {
    const task = taskStore.get(`${pid}/${num}`);
    if (task) (task as { status: Task['status'] }).status = status;
  }),
};

const contentIndex = { refresh: vi.fn(async () => null) };
const workspaceIndex = { refresh: vi.fn(async () => ({})) };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-reviews-'));
  store = new Store({ home });
  await store.ensureLayout();
  const project = await store.createProject({ name: 'demo' });
  projectId = project.id;
  taskStore = new Map();
  taskNum = 0;
  vi.mocked(createReviewTask).mockImplementation(async () => ({
    task: fakeTask(),
    gezelId: 'rex',
    gezelName: 'Rex',
    usedCraftbook: false,
  }));
  vi.mocked(dispatchTaskEntry).mockClear();
  manager = new CodeReviewManager({
    home,
    store,
    git,
    tasks: tasks as never,
    taskRunner: {} as never,
    catalog: {} as never,
    chat: {} as never,
    contentIndex: contentIndex as never,
    workspaceIndex: workspaceIndex as never,
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function project() {
  const p = await store.getProject(projectId);
  if (!p) throw new Error('project missing');
  return p;
}

/** The background chain (index refresh → dispatch) settles on next ticks. */
async function settleBackground(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('CodeReviewManager.start', () => {
  it('persists a running record, writes the snapshot artifacts, and dispatches', async () => {
    const record = await manager.start(await project(), 'commit');
    expect(record.status).toBe('running');
    expect(record.kind).toBe('commit');
    expect(record.taskRef).toBe(`${projectId}/1`);
    expect(record.filesChanged).toBe(2);
    expect(record.additions).toBe(3);
    expect(record.manifestPath).toBe(`reviews/${record.id}/manifest.json`);

    const manifestRaw = await store.readProjectArtifact(projectId, record.manifestPath);
    const manifest = CodeReviewManifestSchema.parse(JSON.parse(manifestRaw ?? '{}'));
    expect(manifest.reviewId).toBe(record.id);
    expect(manifest.files).toHaveLength(2);
    const diff = await store.readProjectArtifact(projectId, record.diffPath);
    expect(diff).toContain('+new line');

    const file = JSON.parse(await readFile(projectCodeReviewsFile(home, projectId), 'utf8'));
    expect(file.reviews).toHaveLength(1);
    expect(file.reviews[0].id).toBe(record.id);

    await settleBackground();
    expect(contentIndex.refresh).toHaveBeenCalledWith(projectId);
    expect(dispatchTaskEntry).toHaveBeenCalledTimes(1);
  });

  it('rejects a second review of the same kind while one runs, allows the other kind', async () => {
    await manager.start(await project(), 'commit');
    await expect(manager.start(await project(), 'commit')).rejects.toBeInstanceOf(
      ReviewInProgressError,
    );
    const pr = await manager.start(await project(), 'pr');
    expect(pr.kind).toBe('pr');
    expect(pr.commitCount).toBe(1);
    const all = await manager.list(projectId);
    expect(all).toHaveLength(2);
  });
});

describe('CodeReviewManager settle + cancel', () => {
  it('settleForTask flips the matching running record', async () => {
    const record = await manager.start(await project(), 'commit');
    const changed = await manager.settleForTask(projectId, record.taskRef, 'complete');
    expect(changed).toBe(1);
    const after = await manager.get(projectId, record.id);
    expect(after?.status).toBe('complete');
    expect(after?.outcome).toBe('complete');
    expect(after?.settledAt).toBeTruthy();
    // Idempotent — a second settle changes nothing.
    expect(await manager.settleForTask(projectId, record.taskRef, 'canceled')).toBe(0);
  });

  it('cancel stops the task and settles the record; repeat cancels are no-ops', async () => {
    const record = await manager.start(await project(), 'commit');
    const canceled = await manager.cancel(await project(), record.id);
    expect(tasks.setStatus).toHaveBeenCalledWith(projectId, 1, 'canceled');
    expect(canceled.status).toBe('canceled');
    const again = await manager.cancel(await project(), record.id);
    expect(again.status).toBe('canceled');
  });
});

describe('CodeReviewManager reconcile', () => {
  it('marks a running record whose task vanished as error', async () => {
    const record = await manager.start(await project(), 'commit');
    taskStore.delete(record.taskRef);
    const all = await manager.list(projectId);
    expect(all[0]?.status).toBe('error');
    expect(all[0]?.error).toContain('deleted');
  });

  it('settles a running record whose task finished while we were down', async () => {
    const record = await manager.start(await project(), 'commit');
    const task = taskStore.get(record.taskRef);
    if (task) (task as { status: Task['status'] }).status = 'complete';
    const all = await manager.list(projectId);
    expect(all[0]?.status).toBe('complete');
    expect(all[0]?.outcome).toBe('complete');
  });
});

describe('CodeReviewManager pruning + enrich', () => {
  it('keeps at most 50 records', async () => {
    for (let i = 0; i < 55; i++) {
      const record = await manager.start(await project(), 'commit');
      await manager.settleForTask(projectId, record.taskRef, 'complete');
    }
    const all = await manager.list(projectId);
    expect(all.length).toBeLessThanOrEqual(50);
  });

  it('enrich joins live task progress for running records', async () => {
    const record = await manager.start(await project(), 'commit');
    const enriched = await manager.enrich(projectId, record);
    expect(enriched.taskStatus).toBe('active');
    expect(enriched.stepsTotal).toBe(2);
    expect(enriched.activeStepName).toBe('Report');
    const task = taskStore.get(record.taskRef);
    if (task) (task as { status: Task['status'] }).status = 'paused';
    const paused = await manager.enrich(projectId, record);
    expect(paused.needsAttention).toBe(true);
  });
});
