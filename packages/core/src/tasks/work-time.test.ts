import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import { recordSuspensionForTests, resetSuspendClockForTests } from '../suspend-clock.js';
import { accrueTaskWork, awakeMsBetween } from './work-time.js';

const T0 = Date.parse('2026-10-23T09:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const MIN = 60_000;

function task(over: Partial<Task> = {}, steps: Partial<TaskCraftbookStep>[] = []): Task {
  return {
    projectId: 'shop',
    num: 1,
    ref: 'shop/1',
    title: 'Deck',
    status: 'active',
    activeStepId: 'draft',
    createdAt: at(0),
    updatedAt: at(0),
    craftbook: {
      id: 'deck',
      name: 'Deck',
      entryStepId: 'scope',
      steps: [
        { id: 'scope', name: 'scope', createdAt: at(0), lastActivatedAt: at(0) },
        { id: 'draft', name: 'draft', createdAt: at(0), lastActivatedAt: at(5) },
      ].map((step, i) => ({ ...step, ...steps[i] })),
    },
    ...over,
  } as unknown as Task;
}
const step = (t: Task, id: string) => t.craftbook.steps.find((s) => s.id === id)!;

describe('accrueTaskWork', () => {
  const fiveMinutes = () => 5 * MIN;

  it('starts a new task at no work', () => {
    const created = accrueTaskWork(null, task({}, [{ workMs: 9 }]), { now: T0 });
    expect(created.workMs).toBe(0);
    expect(created.workedThrough).toBe(at(0));
    expect(step(created, 'scope').workMs).toBeUndefined();
  });

  it('leaves a task from before work time was kept without it', () => {
    const next = accrueTaskWork(task(), task(), { now: T0, awake: fiveMinutes });
    expect(next.workMs).toBeUndefined();
    expect(next.workedThrough).toBeUndefined();
  });

  it('adds the awake time since the last write to the task and its active step', () => {
    const current = task({ workMs: MIN, workedThrough: at(5) }, [{}, { workMs: 2 * MIN }]);
    const next = accrueTaskWork(current, task({ workMs: 999 }), {
      now: T0 + 10 * MIN,
      awake: (from, now) => {
        expect([from, now]).toEqual([T0 + 5 * MIN, T0 + 10 * MIN]);
        return 5 * MIN;
      },
    });
    // The caller's copy is never trusted over the record on disk.
    expect(next.workMs).toBe(6 * MIN);
    expect(step(next, 'draft').workMs).toBe(7 * MIN);
    expect(step(next, 'scope').workMs).toBeUndefined();
    expect(next.workedThrough).toBe(at(10));
  });

  it('counts nothing while the task was paused', () => {
    const current = task({ status: 'paused', workMs: MIN, workedThrough: at(5) });
    const next = accrueTaskWork(current, task({ status: 'active' }), {
      now: T0 + 3 * 24 * 60 * MIN,
      awake: fiveMinutes,
    });
    expect(next.workMs).toBe(MIN);
    expect(next.workedThrough).toBe(at(3 * 24 * 60));
  });

  it('starts a re-activated step afresh but keeps its time in the run', () => {
    const current = task({ workMs: 4 * MIN, workedThrough: at(5) }, [{}, { workMs: 4 * MIN }]);
    const looped = task({}, [{}, { lastActivatedAt: at(10) }]);
    const next = accrueTaskWork(current, looped, { now: T0 + 10 * MIN, awake: fiveMinutes });
    expect(next.workMs).toBe(9 * MIN);
    expect(step(next, 'draft').workMs).toBeUndefined();
  });
});

describe('awakeMsBetween', () => {
  afterEach(() => resetSuspendClockForTests());

  it('never counts time before this process started', () => {
    const now = Date.now();
    expect(awakeMsBetween(now - 7 * 24 * 60 * MIN, now)).toBeLessThan(10 * MIN);
  });

  it('leaves out time the host slept', () => {
    vi.useFakeTimers();
    try {
      const from = Date.now();
      vi.setSystemTime(from + 120 * MIN);
      recordSuspensionForTests(30 * MIN);
      expect(awakeMsBetween(from, Date.now())).toBe(90 * MIN);
    } finally {
      vi.useRealTimers();
    }
  });
});
