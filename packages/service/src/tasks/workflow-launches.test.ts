import type { Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowLaunches } from './workflow-launches.js';

function fixture() {
  const tasks: Task[] = [];
  const store = {
    iterateProjectTasks: vi.fn(async function* (projectId: string) {
      for (const task of tasks) if (task.projectId === projectId) yield task;
    }),
    readTask: vi.fn(
      async (projectId: string, num: number) =>
        tasks.find((t) => t.projectId === projectId && t.num === num) ?? null,
    ),
  };
  const create = vi.fn(async (origin: NonNullable<Task['origin']>) => {
    const task = {
      projectId: 'p',
      num: tasks.length + 1,
      ref: `p/${tasks.length + 1}`,
      status: 'active',
      origin,
    } as Task;
    tasks.push(task);
    return { task, reused: false };
  });
  return { tasks, store, create, launches: new WorkflowLaunches(store) };
}
const key = `workflow-v1:${'a'.repeat(64)}`;

describe('durable workflow task requests', () => {
  it('coalesces concurrent requests and retains completed identities after restart', async () => {
    const { tasks, store, create, launches } = fixture();
    const [a, b] = await Promise.all([
      launches.launch('p', key, { title: 'Review', params: { input: 'one' } }, create),
      launches.launch('p', key, { params: { input: 'one' }, title: 'Review' }, create),
    ]);
    expect(a.task.ref).toBe(b.task.ref);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.iterateProjectTasks).toHaveBeenCalledTimes(1);
    tasks[0]!.status = 'complete';
    const restarted = new WorkflowLaunches(store);
    const replay = await restarted.launch(
      'p',
      key,
      { title: 'Review', params: { input: 'one' } },
      create,
    );
    expect(replay).toMatchObject({ reused: true, task: { status: 'complete', ref: a.task.ref } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('recovers a task persisted before a later launch failure and refuses changed inputs', async () => {
    const { tasks, store, create, launches } = fixture();
    const failure = new Error('lost response after persistence');
    await expect(
      launches.launch('p', key, { input: 'one' }, async (origin) => {
        await create(origin);
        throw failure;
      }),
    ).rejects.toBe(failure);
    tasks[0]!.status = 'canceled';
    const replay = await launches.launch('p', key, { input: 'one' }, create);
    expect(replay).toMatchObject({ reused: true, task: { status: 'canceled' } });
    await expect(launches.launch('p', key, { input: 'two' }, create)).rejects.toThrow(
      /different inputs/,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.iterateProjectTasks).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing cached identity and ambiguous persisted keys', async () => {
    const { tasks, store, create, launches } = fixture();
    await launches.launch('p', key, {}, create);
    const saved = tasks.pop()!;
    await expect(launches.launch('p', key, {}, create)).rejects.toThrow(/identity changed/);
    tasks.push(saved, { ...saved, num: 2, ref: 'p/2' });
    await expect(new WorkflowLaunches(store).launch('p', key, {}, create)).rejects.toThrow(
      /Duplicate/,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
