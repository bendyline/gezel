import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTaskFile } from '@bendyline/gezel/paths';
import { errorToResponse } from '@bendyline/gezel/runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskWriteConflictError } from '../fs/task-files-store.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let tasks: TaskManager;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-concurrency-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Fixture' });
  tasks = new TaskManager(store);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('keeps a completed pause when an earlier retitle finishes late', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const arrived = deferred();
  const release = deferred();
  const original = store.writeTask.bind(store);
  let blocked = false;
  const spy = vi.spyOn(store, 'writeTask').mockImplementation(async (next) => {
    if (!blocked && next.title === 'Retitled' && next.status === 'active') {
      blocked = true;
      arrived.resolve();
      await release.promise;
    }
    return original(next);
  });
  try {
    const retitle = tasks.update('fixture', task.num, { title: 'Retitled' });
    await arrived.promise;
    await tasks.setStatus('fixture', task.num, 'paused');
    release.resolve();
    expect(await retitle).toMatchObject({ title: 'Retitled', status: 'paused' });
    expect(await store.readTask('fixture', task.num)).toMatchObject({
      title: 'Retitled',
      status: 'paused',
    });
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('rejects stale transitions across Store instances before changing metadata or prose', async () => {
  const task = await tasks.create('fixture', {
    title: 'Before',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const otherStore = new Store({ home });
  const stale = (await otherStore.readTask('fixture', task.num))!;
  await tasks.update('fixture', task.num, { description: 'new user description' });
  await tasks.setStatus('fixture', task.num, 'canceled');
  const conflict = await otherStore
    .writeTask({ ...stale, status: 'complete' })
    .catch((error: unknown) => error);
  expect(conflict).toBeInstanceOf(TaskWriteConflictError);
  expect(errorToResponse(conflict, { exposeUnknown: false })).toMatchObject({
    status: 409,
    body: { error: expect.stringContaining('changed while it was being edited') },
  });
  expect(await store.readTask('fixture', task.num)).toMatchObject({
    status: 'canceled',
    description: 'new user description',
  });
});

it('starts legacy tasks at revision zero and protects their first overlapping writes', async () => {
  const task = await tasks.create('fixture', {
    title: 'Legacy',
    assignee: { kind: 'user' },
    steps: [{ name: 'Work' }],
  });
  const file = projectTaskFile(home, 'fixture', task.num);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.revision;
  await writeFile(file, JSON.stringify(saved));
  const first = (await store.readTask('fixture', task.num))!;
  const second = (await store.readTask('fixture', task.num))!;
  await store.writeTask({ ...first, status: 'paused' });
  await expect(store.writeTask({ ...second, title: 'stale' })).rejects.toBeInstanceOf(
    TaskWriteConflictError,
  );
  expect(await store.readTask('fixture', task.num)).toMatchObject({
    title: 'Legacy',
    status: 'paused',
    revision: 1,
  });
});
