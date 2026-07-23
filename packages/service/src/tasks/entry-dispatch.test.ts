import type { Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { type EntryDispatchDeps, dispatchTaskEntry } from './entry-dispatch.js';

function fixtureTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    projectId: 'p1',
    num: 1,
    ref: 'p1/1',
    title: 'Build the thing',
    description: 'desc',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'task-owner' },
    craftbook: {
      id: 'cb',
      name: 'cb',
      steps: [
        { id: 'build', name: 'Build', createdAt: now },
        { id: 'done', name: 'Done', createdAt: now },
      ],
      entryStepId: 'build',
      createdAt: now,
      updatedAt: now,
    },
    activeStepId: 'build',
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
    ...overrides,
  } as Task;
}

function deps(overrides: Partial<EntryDispatchDeps> = {}): EntryDispatchDeps & {
  enqueued: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
} {
  const enqueued: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  return {
    enqueued,
    events,
    store: {
      getProject: vi.fn(async () => ({ id: 'p1', name: 'P1', status: 'active' }) as never),
      getGezel: vi.fn(async (id: string) => ({ id, name: `Name-${id}` }) as never),
    } as unknown as EntryDispatchDeps['store'],
    taskRunner: {
      enqueueHandoff: (h: Record<string, unknown>) => {
        enqueued.push(h);
      },
    },
    history: {
      log: async (e: Record<string, unknown>) => {
        events.push(e);
      },
    } as unknown as EntryDispatchDeps['history'],
    ...overrides,
  };
}

describe('dispatchTaskEntry', () => {
  it('enqueues a kind:entry handoff for the active step and logs the history event', async () => {
    const d = deps();
    const result = await dispatchTaskEntry(d, fixtureTask());
    expect(result).toMatchObject({
      enqueued: true,
      gezelId: 'task-owner',
      assigneeName: 'Name-task-owner',
    });
    expect(d.enqueued).toEqual([
      { gezelId: 'task-owner', projectId: 'p1', taskRef: 'p1/1', stepId: 'build', kind: 'entry' },
    ]);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({
      kind: 'task.entry.dispatched',
      projectId: 'p1',
      gezelId: 'task-owner',
      details: { ref: 'p1/1', stepId: 'build', gezelId: 'task-owner' },
    });
  });

  it('entry-gezel precedence: step.assignee beats suggestedGezelId beats task assignee', async () => {
    const now = new Date().toISOString();
    const d1 = deps();
    await dispatchTaskEntry(
      d1,
      fixtureTask({
        craftbook: {
          id: 'cb',
          name: 'cb',
          steps: [
            {
              id: 'build',
              name: 'Build',
              createdAt: now,
              assignee: { kind: 'gezel', gezelId: 'explicit' },
              suggestedGezelId: 'suggested',
            },
          ],
          entryStepId: 'build',
          createdAt: now,
          updatedAt: now,
        } as Task['craftbook'],
      }),
    );
    expect(d1.enqueued[0]?.gezelId).toBe('explicit');

    const d2 = deps();
    await dispatchTaskEntry(
      d2,
      fixtureTask({
        craftbook: {
          id: 'cb',
          name: 'cb',
          steps: [{ id: 'build', name: 'Build', createdAt: now, suggestedGezelId: 'suggested' }],
          entryStepId: 'build',
          createdAt: now,
          updatedAt: now,
        } as Task['craftbook'],
      }),
    );
    expect(d2.enqueued[0]?.gezelId).toBe('suggested');
  });

  it('skips non-active tasks, spawn hosts, and user-assigned entries with reasons', async () => {
    const d = deps();
    expect(await dispatchTaskEntry(d, fixtureTask({ status: 'draft' as never }))).toMatchObject({
      enqueued: false,
      reason: 'not-active',
    });
    expect(
      await dispatchTaskEntry(d, fixtureTask({ cron: { expression: '0 9 * * *' } as never })),
    ).toMatchObject({ enqueued: false, reason: 'spawn-host' });
    expect(
      await dispatchTaskEntry(d, fixtureTask({ fanout: { count: 2 } as never })),
    ).toMatchObject({ enqueued: false, reason: 'spawn-host' });
    expect(
      await dispatchTaskEntry(d, fixtureTask({ activeStepId: undefined as never })),
    ).toMatchObject({ enqueued: false, reason: 'no-active-step' });
    expect(await dispatchTaskEntry(d, fixtureTask({ assignee: { kind: 'user' } }))).toMatchObject({
      enqueued: false,
      reason: 'no-entry-gezel',
    });
    expect(d.enqueued).toHaveLength(0);
    expect(d.events).toHaveLength(0);
  });

  it('skips when the project does not allow ambient work', async () => {
    const d = deps({
      store: {
        getProject: async () => ({ id: 'p1', name: 'P1', status: 'paused' }) as never,
        getGezel: async (id: string) => ({ id, name: `Name-${id}` }) as never,
      } as unknown as EntryDispatchDeps['store'],
    });
    const result = await dispatchTaskEntry(d, fixtureTask());
    expect(result).toMatchObject({ enqueued: false, reason: 'project-inactive' });
    expect(d.enqueued).toHaveLength(0);
  });
});
