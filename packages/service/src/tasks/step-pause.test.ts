import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskManager } from './manager.js';
import { pauseTaskAfterFailedHandoff, pauseTaskStoppedByUser } from './step-pause.js';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-step-pause-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'p1' });
  tasks = new TaskManager(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function reviewTask() {
  const task = await tasks.create('p1', {
    title: 'Review the patch',
    assignee: { kind: 'gezel', gezelId: 'worker' },
    steps: [
      { id: 'review', name: 'Review', prompt: 'Review the patch.' },
      { id: 'report', name: 'Report', prompt: 'Report back.' },
    ],
    createdBy: { kind: 'user' },
  });
  return { projectId: 'p1', num: task.num, taskRef: task.ref };
}

describe('pauseTaskStoppedByUser', () => {
  it('pauses the task whose running step the person stopped, and says so in its notes', async () => {
    const ref = await reviewTask();
    expect(await pauseTaskStoppedByUser(tasks, { ...ref, stepId: 'review' })).toBe(true);
    const after = await store.readTask('p1', ref.num);
    expect(after?.status).toBe('paused');
    const notes = await tasks.listNotes('p1', ref.num);
    expect(notes.at(-1)?.text).toContain('You stopped step `review`');
    expect(notes.at(-1)?.author).toEqual({ kind: 'user' });
  });

  it('leaves the task alone when the stopped session was on another step', async () => {
    const ref = await reviewTask();
    expect(await pauseTaskStoppedByUser(tasks, { ...ref, stepId: 'report' })).toBe(false);
    expect((await store.readTask('p1', ref.num))?.status).toBe('active');
  });

  it('does not touch a task that is no longer active', async () => {
    const ref = await reviewTask();
    await tasks.setStatus('p1', ref.num, 'canceled');
    expect(await pauseTaskStoppedByUser(tasks, { ...ref, stepId: 'review' })).toBe(false);
    expect((await store.readTask('p1', ref.num))?.status).toBe('canceled');
  });
});

describe('pauseTaskAfterFailedHandoff', () => {
  it('pauses for help when a handoff really failed', async () => {
    const ref = await reviewTask();
    await pauseTaskAfterFailedHandoff(
      tasks,
      { ...ref, stepId: 'review', detail: 'third abort' },
      () => false,
    );
    expect((await store.readTask('p1', ref.num))?.status).toBe('paused');
    const notes = await tasks.listNotes('p1', ref.num);
    expect(notes.at(-1)?.text).toContain('Handoff failed');
  });

  it('never pauses while the service is stopping, so the task rehydrates on the next boot', async () => {
    const ref = await reviewTask();
    await pauseTaskAfterFailedHandoff(
      tasks,
      { ...ref, stepId: 'review', detail: 'service shutting down' },
      () => true,
    );
    expect((await store.readTask('p1', ref.num))?.status).toBe('active');
    expect(await tasks.listNotes('p1', ref.num)).toHaveLength(0);
  });
});
