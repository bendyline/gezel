import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  CONSULT_DAILY_CAP,
  XP_WEIGHTS,
  computeSignals,
  countTaskWork,
  ratchetSignals,
  totalXp,
} from './xp.js';

describe('computeSignals', () => {
  it('weights memories by kind — prefs and decisions over facts over status', () => {
    const signals = computeSignals({
      memoryEntries: [{ kind: 'pref' }, { kind: 'decision' }, { kind: 'fact' }, { kind: 'status' }],
      lessonsUpdates: 0,
      completedSteps: 0,
      completedTasks: 0,
      consultationsByDay: new Map(),
    });
    expect(signals.memoryXp).toBe(6 + 6 + 3 + 1);
  });

  it('caps consultations per day', () => {
    const signals = computeSignals({
      memoryEntries: [],
      lessonsUpdates: 0,
      completedSteps: 0,
      completedTasks: 0,
      consultationsByDay: new Map([
        ['2026-06-10', 12], // capped to 5
        ['2026-06-11', 3],
      ]),
    });
    expect(signals.consultXp).toBe((CONSULT_DAILY_CAP + 3) * XP_WEIGHTS.consultationDelivered);
  });

  it('sums lessons and task work', () => {
    const signals = computeSignals({
      memoryEntries: [],
      lessonsUpdates: 2,
      completedSteps: 3,
      completedTasks: 1,
      consultationsByDay: new Map(),
    });
    expect(signals.lessonsXp).toBe(30);
    expect(signals.taskXp).toBe(3 * 10 + 25);
    expect(totalXp(signals)).toBe(30 + 55);
  });
});

describe('ratchetSignals', () => {
  it('a shrunken corpus never lowers XP', () => {
    const prev = { memoryXp: 300, lessonsXp: 30, taskXp: 50, consultXp: 10 };
    const recomputed = { memoryXp: 120, lessonsXp: 45, taskXp: 50, consultXp: 4 };
    expect(ratchetSignals(prev, recomputed)).toEqual({
      memoryXp: 300, // compaction merged entries — keep earned credit
      lessonsXp: 45, // new lessons still count up
      taskXp: 50,
      consultXp: 10,
    });
  });
});

describe('countTaskWork', () => {
  const step = (over: Record<string, unknown>) => ({
    id: 's1',
    name: 'Step',
    createdAt: 'now',
    ...over,
  });
  const task = (over: Record<string, unknown>): Task =>
    ({
      projectId: 'p',
      num: 1,
      ref: 'p/1',
      title: 'T',
      description: 'd'.repeat(40),
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      craftbook: { id: 'cb', name: 'CB', steps: [] },
      createdAt: 'now',
      updatedAt: 'now',
      createdBy: { kind: 'user' },
      ...over,
    }) as unknown as Task;

  it('credits completed steps via explicit assignee or suggestedGezelId fallback', () => {
    const tasks = [
      task({
        craftbook: {
          id: 'cb',
          name: 'CB',
          steps: [
            step({ assignee: { kind: 'gezel', gezelId: 'ada' }, completedAt: 'now' }),
            step({ suggestedGezelId: 'ada', completedAt: 'now' }),
            step({ suggestedGezelId: 'ada' }), // not completed
            step({ assignee: { kind: 'gezel', gezelId: 'leo' }, completedAt: 'now' }),
            // explicit user assignee — suggestedGezelId must NOT credit ada
            step({
              assignee: { kind: 'user' },
              suggestedGezelId: 'ada',
              completedAt: 'now',
            }),
          ],
        },
      }),
    ];
    expect(countTaskWork(tasks, 'ada')).toEqual({ completedSteps: 2, completedTasks: 0 });
  });

  it('credits completed tasks only to their gezel assignee', () => {
    const tasks = [
      task({ status: 'complete' }), // ada
      task({ status: 'complete', assignee: { kind: 'gezel', gezelId: 'leo' } }),
      task({ status: 'complete', assignee: { kind: 'user' } }),
      task({ status: 'canceled' }), // ada but canceled
    ];
    expect(countTaskWork(tasks, 'ada').completedTasks).toBe(1);
  });
});
