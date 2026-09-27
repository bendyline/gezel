import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../fs/store.js';
import { TaskManager } from '../../tasks/manager.js';
import type { ServiceContext } from '../context.js';
import { sessionRoutes } from './sessions.js';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-stop-task-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'p1' });
  tasks = new TaskManager(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function context(record: { taskRef?: string; stepId?: string }) {
  const cancelInflight = vi.fn(async () => ({ cancelled: true }));
  const ctx = {
    chat: {
      getSessionRecord: async () => ({ id: 'session-1', ...record }),
      cancelInflight,
    },
    tasks,
  } as unknown as ServiceContext;
  return { ctx, cancelInflight };
}

function cancel(ctx: ServiceContext, body?: unknown) {
  return sessionRoutes(ctx).request('http://localhost/session-1/cancel', {
    method: 'POST',
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
}

async function reviewTask() {
  return tasks.create('p1', {
    title: 'Review the patch',
    assignee: { kind: 'gezel', gezelId: 'worker' },
    steps: [{ id: 'review', name: 'Review', prompt: 'Review the patch.' }],
    createdBy: { kind: 'user' },
  });
}

describe('POST /:id/cancel', () => {
  it("pauses the task when the person's Stop ends a task step's turn", async () => {
    // Ending the turn alone let the stuck-step sweep, and the next boot's
    // rehydration, pick the step straight back up.
    const task = await reviewTask();
    const { ctx, cancelInflight } = context({ taskRef: task.ref, stepId: 'review' });

    const response = await cancel(ctx, { stopTask: true });

    expect(await response.json()).toEqual({ cancelled: true, taskPaused: true });
    expect(cancelInflight).toHaveBeenCalledWith('session-1', 'user-stop');
    expect((await store.readTask('p1', task.num))?.status).toBe('paused');
  });

  it('leaves the task running for a cancel that means to carry on', async () => {
    // Re-engage and clearing a wedged turn cancel first, then keep working.
    const task = await reviewTask();
    const { ctx } = context({ taskRef: task.ref, stepId: 'review' });

    const response = await cancel(ctx);

    expect(await response.json()).toEqual({ cancelled: true });
    expect((await store.readTask('p1', task.num))?.status).toBe('active');
  });

  it('pauses nothing for a Stop in a chat that is not working a task', async () => {
    const task = await reviewTask();
    const { ctx } = context({});

    const response = await cancel(ctx, { stopTask: true });

    expect(await response.json()).toEqual({ cancelled: true });
    expect((await store.readTask('p1', task.num))?.status).toBe('active');
  });
});
