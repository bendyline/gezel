import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { type ScheduleNightWindow, scheduleNextRun } from './schedule-next-run.js';

/** Local wall-clock instant, the way the Night Shift window is read. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

/** The 10:00 PM to 6:00 AM window that opens on `day`. */
function nightOf(day: number, open: boolean): ScheduleNightWindow {
  return { start: at(day, 22), end: at(day + 1, 6), open };
}

type Host = Pick<Task, 'status' | 'effectiveStatus' | 'cron' | 'nightShift'>;
type Run = Pick<Task, 'ref' | 'status' | 'effectiveStatus' | 'createdAt'>;

function nightHost(lastRunDay?: string, overrides: Partial<Host> = {}): Host {
  return {
    status: 'active',
    cron: { expression: '*/30 * * * *', overlap: 'skip' },
    nightShift: { enabled: true, onceADay: true, ...(lastRunDay ? { lastRunDay } : {}) },
    ...overrides,
  };
}

const run = (ref: string, status: Task['status'], createdAt: string): Run => ({
  ref,
  status,
  createdAt,
});

describe('scheduleNextRun', () => {
  it("names tonight's window, never the half-hourly check, for a night-shift host", () => {
    const host = nightHost('2026-11-08', {
      cron: { expression: '*/30 * * * *', nextTickAt: at(9, 15, 30).toISOString() },
    });
    const next = scheduleNextRun(host, [], { now: at(9, 15, 10), nightWindow: nightOf(9, false) });
    expect(next).toEqual({ kind: 'at', at: at(9, 22), soon: false });
  });

  it('fires on the next check while the window is open and tonight is still owed', () => {
    const host = nightHost('2026-11-08', {
      cron: { expression: '*/30 * * * *', nextTickAt: at(9, 23, 30).toISOString() },
    });
    const next = scheduleNextRun(host, [], { now: at(9, 23, 10), nightWindow: nightOf(9, true) });
    expect(next).toEqual({ kind: 'at', at: at(9, 23, 30), soon: true });
  });

  it("moves to tomorrow night once tonight's run has started, past midnight too", () => {
    // The window that opened on the 9th keeps the key 2026-11-09 until 6:00 AM.
    const host = nightHost('2026-11-09');
    expect(scheduleNextRun(host, [], { now: at(10, 2), nightWindow: nightOf(9, true) })).toEqual({
      kind: 'at',
      at: at(10, 22),
      soon: false,
    });
  });

  it('waits for a run that is still going under the default overlap rule', () => {
    // squisq/18: last night's run was created minutes before the window
    // closed and is still on its first step.
    const host = nightHost('2026-11-08');
    const runs = [
      run('squisq/22', 'paused', '2026-10-31T06:43:03.000Z'),
      run('squisq/37', 'active', '2026-11-09T13:53:47.000Z'),
    ];
    expect(scheduleNextRun(host, runs, { now: at(9, 15), nightWindow: nightOf(9, false) })).toEqual(
      { kind: 'after-run', runRef: 'squisq/37', at: at(9, 22) },
    );
  });

  it('does not wait on a run when overlapping runs are allowed', () => {
    const host = nightHost(undefined, {
      cron: { expression: '*/30 * * * *', overlap: 'concurrent' },
    });
    const runs = [run('p/2', 'active', '2026-11-09T01:00:00.000Z')];
    expect(scheduleNextRun(host, runs, { now: at(9, 15), nightWindow: nightOf(9, false) })).toEqual(
      { kind: 'at', at: at(9, 22), soon: false },
    );
  });

  it('never fires a night-shift host while the Night Shift has no schedule', () => {
    expect(scheduleNextRun(nightHost(), [], { now: at(9, 15), nightWindow: null })).toEqual({
      kind: 'no-night-shift',
    });
  });

  it('reads an always-on Night Shift as one run a day, starting at midnight', () => {
    const now = at(9, 15);
    const rolling = { start: at(8, 15), end: now, open: true };
    expect(scheduleNextRun(nightHost('2026-11-09'), [], { now, nightWindow: rolling })).toEqual({
      kind: 'at',
      at: at(10, 0),
      soon: false,
    });
  });

  it('uses the next tick of an ordinary schedule', () => {
    const tick = '2026-11-10T17:00:00.000Z';
    const host: Host = { status: 'active', cron: { expression: '0 17 * * *', nextTickAt: tick } };
    expect(scheduleNextRun(host, [], { now: at(9, 15), nightWindow: null })).toEqual({
      kind: 'at',
      at: new Date(tick),
      soon: false,
    });
  });

  it('lets Crew activity, then the host itself, overrule the clock', () => {
    const ctx = { now: at(9, 15), nightWindow: nightOf(9, false) };
    expect(scheduleNextRun(nightHost(), [], { ...ctx, engagementMode: 'reactive' })).toEqual({
      kind: 'held',
      mode: 'reactive',
    });
    expect(
      scheduleNextRun(nightHost(undefined, { status: 'paused' }), [], {
        ...ctx,
        engagementMode: 'off',
      }),
    ).toEqual({ kind: 'paused' });
    expect(scheduleNextRun(nightHost(undefined, { status: 'canceled' }), [], ctx)).toEqual({
      kind: 'stopped',
      status: 'canceled',
    });
  });
});
