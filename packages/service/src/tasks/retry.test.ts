import type { Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { type TaskRetryDeps, retryPausedTask } from './retry.js';

function fixtureTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    projectId: 'p1',
    num: 7,
    ref: 'p1/7',
    title: 'Security Architecture Review',
    description: 'desc',
    status: 'paused',
    assignee: { kind: 'gezel', gezelId: 'wren' },
    craftbook: {
      id: 'cb',
      name: 'cb',
      steps: [
        { id: 'model-system', name: 'Model the system', createdAt: now, redriveCount: 3 },
        { id: 'report', name: 'Report', createdAt: now },
      ],
      entryStepId: 'model-system',
      createdAt: now,
      updatedAt: now,
    },
    activeStepId: 'model-system',
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
    ...overrides,
  } as Task;
}

function deps(task: Task, overrides: Partial<TaskRetryDeps> = {}) {
  const enqueued: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
  const resets: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const budgetResets: string[] = [];
  const entrances: string[] = [];
  const d: TaskRetryDeps = {
    store: {
      getProject: vi.fn(async () => ({ id: 'p1', name: 'P1', status: 'active' }) as never),
      getGezel: vi.fn(async (id: string) => ({ id, name: `Name-${id}` }) as never),
    } as unknown as TaskRetryDeps['store'],
    tasks: {
      get: async () => task,
      setStatus: async (_p: string, _n: number, status: string) => {
        statuses.push(status);
        return { ...task, status } as Task;
      },
      appendNote: async (_p: string, _n: number, input: Record<string, unknown>) => {
        notes.push(input);
        return {} as never;
      },
      resetStepRecoveryBudget: async (
        _p: string,
        _n: number,
        stepId: string,
        opts: Record<string, unknown>,
      ) => {
        resets.push({ stepId, ...opts });
      },
      ensureActiveStepEntered: async (projectId: string, num: number) => {
        entrances.push(`${projectId}/${num}`);
        return { status: 'ready', task: { ...task, status: 'active' } as Task };
      },
    } as unknown as TaskRetryDeps['tasks'],
    taskRunner: {
      enqueueHandoff: (h: Record<string, unknown>) => {
        enqueued.push(h);
      },
    } as unknown as TaskRetryDeps['taskRunner'],
    chat: {
      resetTaskBudget: (ref: string) => {
        budgetResets.push(ref);
      },
    },
    ...overrides,
  };
  return { deps: d, enqueued, notes, resets, statuses, budgetResets, entrances };
}

describe('retryPausedTask', () => {
  it('clears the counters that tripped the pause, reactivates, and re-drives the assignee', async () => {
    const task = fixtureTask();
    const h = deps(task);
    const result = await retryPausedTask(h.deps, 'p1', 7);

    expect(result).toMatchObject({
      dispatched: true,
      gezelId: 'wren',
      assigneeName: 'Name-wren',
    });
    expect(result?.task.status).toBe('active');
    // Every budget that can re-pause the task on the first turn back.
    expect(h.resets).toEqual([
      { stepId: 'model-system', redriveCount: 0, clearGateAttempts: true },
    ]);
    expect(h.budgetResets).toEqual(['p1/7']);
    expect(h.statuses).toEqual(['active']);
    expect(h.entrances).toEqual(['p1/7']);
    expect(h.notes[0]).toMatchObject({ author: { kind: 'user' }, stepId: 'model-system' });
    expect(String(h.notes[0]?.text)).toContain('# Retry requested');
    // Continues the stalled thread so the model sees its own failed attempts.
    expect(h.enqueued).toEqual([
      {
        gezelId: 'wren',
        projectId: 'p1',
        taskRef: 'p1/7',
        stepId: 'model-system',
        kind: 'retry',
        resumeExisting: true,
      },
    ]);
  });

  it('leaves a task that is not paused completely untouched', async () => {
    const h = deps(fixtureTask({ status: 'active' }));
    const result = await retryPausedTask(h.deps, 'p1', 7);
    expect(result).toMatchObject({ dispatched: false, reason: 'not-paused' });
    expect(h.statuses).toEqual([]);
    expect(h.resets).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(h.entrances).toEqual([]);
  });

  it('un-pauses a spawn host without driving its inert wait step', async () => {
    const h = deps(fixtureTask({ cron: { expression: '0 9 * * *' } as never }));
    const result = await retryPausedTask(h.deps, 'p1', 7);
    expect(result).toMatchObject({ dispatched: false, reason: 'spawn-host' });
    expect(result?.task.status).toBe('active');
    expect(h.enqueued).toEqual([]);
    expect(h.entrances).toEqual([]);
  });

  it('does not dispatch when the step setup fails again', async () => {
    const task = fixtureTask();
    const h = deps(task);
    h.deps.tasks.ensureActiveStepEntered = async () => ({
      status: 'failed',
      task,
    });

    await expect(retryPausedTask(h.deps, 'p1', 7)).rejects.toThrow(
      'setup for its current step failed again',
    );
    expect(h.enqueued).toEqual([]);
  });

  it('reports an unassigned step instead of silently doing nothing', async () => {
    const now = new Date().toISOString();
    const h = deps(
      fixtureTask({
        assignee: { kind: 'user' },
        craftbook: {
          id: 'cb',
          name: 'cb',
          steps: [{ id: 'model-system', name: 'Model the system', createdAt: now }],
          entryStepId: 'model-system',
          createdAt: now,
          updatedAt: now,
        } as Task['craftbook'],
      }),
    );
    const result = await retryPausedTask(h.deps, 'p1', 7);
    expect(result).toMatchObject({ dispatched: false, reason: 'no-assignee' });
    expect(h.enqueued).toEqual([]);
  });

  it('holds the re-drive when the project is not taking background work', async () => {
    const task = fixtureTask();
    const h = deps(task, {
      store: {
        getProject: async () => ({ id: 'p1', name: 'P1', status: 'paused' }) as never,
        getGezel: async (id: string) => ({ id, name: `Name-${id}` }) as never,
      } as unknown as TaskRetryDeps['store'],
    });
    const result = await retryPausedTask(h.deps, 'p1', 7);
    expect(result).toMatchObject({ dispatched: false, reason: 'project-inactive' });
    expect(result?.task.status).toBe('active');
    expect(h.enqueued).toEqual([]);
  });

  it('returns null for a task that does not exist', async () => {
    const h = deps(fixtureTask());
    const missing = {
      ...h.deps,
      tasks: { ...h.deps.tasks, get: async () => null } as unknown as TaskRetryDeps['tasks'],
    };
    expect(await retryPausedTask(missing, 'p1', 99)).toBeNull();
  });
});
