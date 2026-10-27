/**
 * `TaskManager.list({ status })`, `listChildren` and project stabilization
 * read from the store's status and lineage indexes, not the project's whole
 * task history. These pin what they return and that, once a project's index
 * is built, they only read the tasks that can match.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTasksDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskFilesStore } from '../fs/task-files-store.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let tasks: TaskManager;

const seed = (title: string, extra: { parentTaskRef?: string } = {}) =>
  tasks.create('website', {
    title,
    assignee: { kind: 'user' },
    steps: [{ name: 'Main' }],
    ...extra,
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-status-listing-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Website' });
  tasks = new TaskManager(store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

it('lists active tasks by reading only the live ones, newest first', async () => {
  const done: number[] = [];
  for (let i = 0; i < 12; i++) {
    const task = await seed(`Done ${i}`);
    await tasks.setStatus('website', task.num, 'complete');
    done.push(task.num);
  }
  const older = await seed('Older live');
  const newer = await seed('Newer live');

  // A restarted service starts with empty indexes: the first listing reads
  // the project once, later ones read only the active bucket.
  const restarted = new TaskManager(new Store({ home }));
  const reads = vi.spyOn(TaskFilesStore.prototype, 'readTask');
  expect(
    (await restarted.list({ projectId: 'website', status: 'active' })).map((t) => t.num),
  ).toEqual([newer.num, older.num]);
  reads.mockClear();
  expect((await restarted.list({ status: 'active' })).map((t) => t.num).sort()).toEqual(
    [older.num, newer.num].sort(),
  );
  const readNums = reads.mock.calls.map(([, num]) => num);
  expect(readNums.length).toBeGreaterThan(0);
  expect(readNums.some((num) => done.includes(num))).toBe(false);
});

it('follows status changes and leaves out a child its paused parent holds', async () => {
  const parent = await seed('Collection');
  const child = await seed('Batch', { parentTaskRef: parent.ref });
  const draft = await tasks.create('website', {
    title: 'Plan',
    assignee: { kind: 'user' },
    steps: [{ name: 'Main' }],
    status: 'draft',
  });
  const active = async () => (await tasks.list({ status: 'active' })).map((t) => t.num).sort();
  expect(await active()).toEqual([parent.num, child.num].sort());
  expect((await tasks.list({ status: 'draft' })).map((t) => t.num)).toEqual([draft.num]);

  await tasks.setStatus('website', parent.num, 'paused');
  expect(await active()).toEqual([]);
  await tasks.setStatus('website', parent.num, 'active');
  await tasks.setStatus('website', child.num, 'complete');
  expect(await active()).toEqual([parent.num]);
});

it('skips a task whose file vanished behind the store', async () => {
  const kept = await seed('Kept');
  const gone = await seed('Gone');
  expect((await tasks.list({ status: 'active' })).length).toBe(2);
  await rm(join(projectTasksDir(home, 'website'), String(gone.num)), { recursive: true });
  expect((await tasks.list({ status: 'active' })).map((t) => t.num)).toEqual([kept.num]);
  expect((await store.projectTaskSummary('website')).taskCount).toBe(1);
});

it('lists children from the lineage index and still stabilizes a finished project', async () => {
  const parent = await seed('Collection');
  const first = await seed('Batch 1', { parentTaskRef: parent.ref });
  const second = await seed('Batch 2', { parentTaskRef: parent.ref });
  await seed('Unrelated');
  await tasks.setStatus('website', first.num, 'complete');
  expect((await tasks.listChildren(parent.ref)).map((t) => t.num).sort()).toEqual(
    [first.num, second.num].sort(),
  );
  expect((await tasks.listChildren(parent.ref, { status: 'active' })).map((t) => t.num)).toEqual([
    second.num,
  ]);

  for (const task of await tasks.list({ status: 'active' })) {
    await tasks.setStatus('website', task.num, 'complete');
  }
  expect((await store.getProject('website'))?.status).toBe('stable');
});
