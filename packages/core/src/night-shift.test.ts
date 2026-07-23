import { describe, expect, it } from 'vitest';
import {
  type NightShiftWindow,
  isInNightShiftWindow,
  nextNightShiftStart,
  nightShiftDayKey,
  nightShiftWindowKey,
} from './night-shift.js';
import { type Task, isPendingNightShiftTask } from './schemas/task.js';

const OVERNIGHT: NightShiftWindow = { startHour: 22, endHour: 6 };
const DAYTIME: NightShiftWindow = { startHour: 9, endHour: 17 };

// Local-time constructor (the helpers read local hours).
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('night-shift window math', () => {
  it('detects in/out of an overnight (wrapping) window', () => {
    expect(isInNightShiftWindow(at(2026, 6, 20, 23, 0), OVERNIGHT)).toBe(true);
    expect(isInNightShiftWindow(at(2026, 6, 21, 3, 0), OVERNIGHT)).toBe(true);
    expect(isInNightShiftWindow(at(2026, 6, 20, 22, 0), OVERNIGHT)).toBe(true); // boundary open
    expect(isInNightShiftWindow(at(2026, 6, 21, 6, 0), OVERNIGHT)).toBe(false); // boundary close
    expect(isInNightShiftWindow(at(2026, 6, 20, 12, 0), OVERNIGHT)).toBe(false);
  });

  it('detects in/out of a same-day window', () => {
    expect(isInNightShiftWindow(at(2026, 6, 20, 12, 0), DAYTIME)).toBe(true);
    expect(isInNightShiftWindow(at(2026, 6, 20, 8, 0), DAYTIME)).toBe(false);
    expect(isInNightShiftWindow(at(2026, 6, 20, 17, 0), DAYTIME)).toBe(false);
  });

  it('maps an overnight window to one stable key across midnight', () => {
    const evening = nightShiftWindowKey(at(2026, 6, 20, 23, 30), OVERNIGHT);
    const morning = nightShiftWindowKey(at(2026, 6, 21, 2, 0), OVERNIGHT);
    expect(evening).toBe('2026-06-20');
    expect(morning).toBe('2026-06-20'); // tail belongs to the prior day's window
    expect(nightShiftWindowKey(at(2026, 6, 20, 12, 0), OVERNIGHT)).toBeNull();
  });

  it('dayKey falls back to the plain local date outside the window', () => {
    expect(nightShiftDayKey(at(2026, 6, 20, 12, 0), OVERNIGHT)).toBe('2026-06-20');
    expect(nightShiftDayKey(at(2026, 6, 21, 2, 0), OVERNIGHT)).toBe('2026-06-20');
  });

  it('computes the next window start strictly after now', () => {
    // Before tonight's open → today at startHour.
    expect(nextNightShiftStart(at(2026, 6, 20, 12, 0), OVERNIGHT)).toEqual(at(2026, 6, 20, 22, 0));
    // After tonight's open → tomorrow at startHour.
    expect(nextNightShiftStart(at(2026, 6, 20, 23, 0), OVERNIGHT)).toEqual(at(2026, 6, 21, 22, 0));
  });
});

describe('isPendingNightShiftTask', () => {
  const base: Task = {
    projectId: 'p',
    num: 1,
    ref: 'p/1',
    title: 't',
    status: 'active',
    assignee: { kind: 'user' },
    craftbook: {
      id: 'cb',
      name: 'cb',
      steps: [{ id: 's', name: 's', createdAt: 'x' }],
      entryStepId: 's',
      createdAt: 'x',
      updatedAt: 'x',
    },
    createdAt: 'x',
    updatedAt: 'x',
    createdBy: { kind: 'user' },
  };

  it('is pending when enabled, active, and not yet run today', () => {
    const t: Task = { ...base, nightShift: { enabled: true } };
    expect(isPendingNightShiftTask(t, '2026-06-20')).toBe(true);
  });

  it('is not pending when not flagged, paused, or run today', () => {
    expect(isPendingNightShiftTask(base, '2026-06-20')).toBe(false);
    expect(
      isPendingNightShiftTask(
        { ...base, status: 'paused', nightShift: { enabled: true } },
        '2026-06-20',
      ),
    ).toBe(false);
    expect(
      isPendingNightShiftTask(
        { ...base, nightShift: { enabled: true, onceADay: true, lastRunDay: '2026-06-20' } },
        '2026-06-20',
      ),
    ).toBe(false);
    // Different day → pending again.
    expect(
      isPendingNightShiftTask(
        { ...base, nightShift: { enabled: true, onceADay: true, lastRunDay: '2026-06-19' } },
        '2026-06-20',
      ),
    ).toBe(true);
  });

  it('excludes schedule hosts (the children are the work)', () => {
    const host: Task = {
      ...base,
      nightShift: { enabled: true },
      cron: { expression: '0 22 * * *' },
      spawnsCraftbook: {
        id: 'sp',
        name: 'sp',
        steps: [{ id: 'w', name: 'w', createdAt: 'x' }],
        entryStepId: 'w',
        createdAt: 'x',
        updatedAt: 'x',
      },
    };
    expect(isPendingNightShiftTask(host, '2026-06-20')).toBe(false);
  });
});
