import type { AIEngagementMode } from '../engagement.js';
import { localDateKey } from '../night-shift.js';
import { type Task, taskEffectiveStatus } from '../schemas/task.js';

/**
 * When a schedule host fires next, worked out from the same facts the
 * scheduler's cron pass reads (`TaskScheduler.runCronTickPass`): the host's
 * lifecycle, Crew activity, the Night Shift window and its once-a-night
 * stamp, and the overlap rule against a run still going. Keep the two in
 * step: a schedule page that promises "tonight at 10:00 PM" while the
 * scheduler skips the fire is the silent failure this exists to end.
 *
 * A night-shift host carries a half-hourly cron, but that is only how often
 * it checks: it fires on the first check inside the window, once a night.
 * Its `cron.nextTickAt` is therefore not its next run, and must never be
 * shown as one.
 */

/** The Night Shift window a status surface names: open now, else next due. */
export interface ScheduleNightWindow {
  start: Date;
  end: Date;
  open: boolean;
}

export type ScheduleNextRun =
  /** Fires at `at`. `soon` while a night window is open and tonight's run is still owed. */
  | { kind: 'at'; at: Date; soon: boolean }
  /** The overlap rule holds the next fire until `runRef` finishes; `at` is when it is next due. */
  | { kind: 'after-run'; runRef: string; at: Date | null }
  /** Crew activity holds every scheduled fire. */
  | { kind: 'held'; mode: 'reactive' | 'off' }
  | { kind: 'paused' }
  | { kind: 'not-started' }
  | { kind: 'stopped'; status: 'complete' | 'canceled' }
  /** A night-shift host while the Night Shift has no schedule: it never fires. */
  | { kind: 'no-night-shift' }
  /** A cron host whose next tick is not known yet. */
  | { kind: 'unknown' };

export interface ScheduleNextRunContext {
  now: Date;
  /** Null when the Night Shift schedule is switched off. */
  nightWindow: ScheduleNightWindow | null;
  engagementMode?: AIEngagementMode;
}

type HostFields = Pick<Task, 'status' | 'effectiveStatus' | 'cron' | 'nightShift'>;
type RunFields = Pick<Task, 'ref' | 'status' | 'effectiveStatus' | 'createdAt'>;

export function scheduleNextRun(
  host: HostFields,
  runs: readonly RunFields[],
  ctx: ScheduleNextRunContext,
): ScheduleNextRun {
  const status = taskEffectiveStatus(host);
  if (status === 'paused') return { kind: 'paused' };
  if (status === 'draft') return { kind: 'not-started' };
  if (status === 'complete' || status === 'canceled') return { kind: 'stopped', status };
  // The cron pass holds every fire while task work is off; the host's tick is
  // not even advanced, so it fires as soon as work is allowed again.
  if (ctx.engagementMode === 'reactive' || ctx.engagementMode === 'off') {
    return { kind: 'held', mode: ctx.engagementMode };
  }

  const due = nextFire(host, ctx);
  if (due.kind !== 'at' && due.kind !== 'unknown') return due;

  if ((host.cron?.overlap ?? 'skip') === 'skip') {
    const running = runs
      .filter((run) => taskEffectiveStatus(run) === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (running) {
      return { kind: 'after-run', runRef: running.ref, at: due.kind === 'at' ? due.at : null };
    }
  }
  return due;
}

function nextFire(
  host: HostFields,
  ctx: ScheduleNextRunContext,
): Extract<ScheduleNextRun, { kind: 'at' | 'unknown' | 'no-night-shift' }> {
  const nextTick = parseDate(host.cron?.nextTickAt);
  if (host.nightShift?.enabled !== true) {
    return nextTick ? { kind: 'at', at: nextTick, soon: false } : { kind: 'unknown' };
  }
  const window = ctx.nightWindow;
  if (!window) return { kind: 'no-night-shift' };
  const onceANight = host.nightShift.onceADay === true;
  const lastRunDay = host.nightShift.lastRunDay;

  // An always-on Night Shift (equal start and end hours) is reported as the
  // rolling last day, so its once-a-night key is the plain local date and the
  // next one begins at midnight. Any other window opens and closes at
  // different hours.
  if (window.start.getHours() === window.end.getHours()) {
    if (onceANight && lastRunDay === localDateKey(ctx.now)) {
      const midnight = new Date(ctx.now);
      midnight.setHours(24, 0, 0, 0);
      return { kind: 'at', at: midnight, soon: false };
    }
    return { kind: 'at', at: checkWithin(nextTick, ctx.now, null), soon: true };
  }

  // A window's once-a-night key is the local date it opened on.
  const ranThisWindow = onceANight && lastRunDay === localDateKey(window.start);
  if (window.open && !ranThisWindow) {
    return { kind: 'at', at: checkWithin(nextTick, ctx.now, window.end), soon: true };
  }
  if (window.open || ranThisWindow) {
    const next = new Date(window.start);
    next.setDate(next.getDate() + 1);
    return { kind: 'at', at: next, soon: false };
  }
  return { kind: 'at', at: window.start, soon: false };
}

/** The next check, kept inside [now, end]: a stale tick means "any moment now". */
function checkWithin(tick: Date | null, now: Date, end: Date | null): Date {
  if (!tick || tick.getTime() < now.getTime()) return now;
  if (end && tick.getTime() > end.getTime()) return now;
  return tick;
}

function parseDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}
