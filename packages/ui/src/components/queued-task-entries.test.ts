import type { Task, TaskWaitState } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { selectQueuedTaskEntries } from './queued-task-entries.js';

function task(ref: string, overrides: Partial<Task> = {}): Task {
  const num = Number(ref.split('/')[1]);
  return {
    num,
    ref,
    projectId: ref.split('/')[0]!,
    title: `Task ${num}`,
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'koray' },
    craftbook: { steps: [] },
    createdAt: '2026-08-21T05:00:00.000Z',
    ...overrides,
  } as unknown as Task;
}

function wait(ref: string, overrides: Partial<TaskWaitState> = {}): TaskWaitState {
  return {
    ref,
    reason: 'queued',
    gezelId: 'koray',
    since: '2026-08-21T05:30:00.000Z',
    ...overrides,
  };
}

describe('selectQueuedTaskEntries', () => {
  it('pairs each waiting ref with its task', () => {
    const entries = selectQueuedTaskEntries({
      tasks: [task('gezel/6'), task('gezel/7')],
      waiting: [wait('gezel/6')],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.task.ref).toBe('gezel/6');
    expect(entries[0]?.wait.reason).toBe('queued');
  });

  it('omits an active task the runner is not holding', () => {
    // The whole point of gating on the runner: a task that is active but
    // never enqueued (no entry gezel, failed dispatch) must not get a
    // card promising it is about to start.
    const entries = selectQueuedTaskEntries({ tasks: [task('gezel/6')], waiting: [] });
    expect(entries).toEqual([]);
  });

  it('omits a waiting ref whose task has left the active list', () => {
    const entries = selectQueuedTaskEntries({ tasks: [], waiting: [wait('gezel/6')] });
    expect(entries).toEqual([]);
  });

  it('narrows to one gezel on a per-gezel timeline', () => {
    const entries = selectQueuedTaskEntries({
      tasks: [task('gezel/6'), task('gezel/7')],
      waiting: [wait('gezel/6'), wait('gezel/7', { gezelId: 'mhairi' })],
      gezelId: 'mhairi',
    });
    expect(entries.map((e) => e.task.ref)).toEqual(['gezel/7']);
  });

  it('narrows to one task on a task-scoped timeline', () => {
    const entries = selectQueuedTaskEntries({
      tasks: [task('gezel/6'), task('gezel/7')],
      waiting: [wait('gezel/6'), wait('gezel/7')],
      taskRef: 'gezel/7',
    });
    expect(entries.map((e) => e.task.ref)).toEqual(['gezel/7']);
  });

  it('orders oldest-enqueued first, matching the runner FIFO', () => {
    const entries = selectQueuedTaskEntries({
      tasks: [task('gezel/6'), task('gezel/7'), task('gezel/8')],
      waiting: [
        wait('gezel/7', { since: '2026-08-21T05:40:00.000Z' }),
        wait('gezel/6', { since: '2026-08-21T05:20:00.000Z' }),
        wait('gezel/8', { since: '2026-08-21T05:30:00.000Z' }),
      ],
    });
    expect(entries.map((e) => e.task.ref)).toEqual(['gezel/6', 'gezel/8', 'gezel/7']);
  });
});
