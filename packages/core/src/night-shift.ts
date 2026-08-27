/**
 * Pure time helpers for Night Shift mode, shared by the service-side
 * `NightShiftManager` (window/latch decisions) and `TaskManager` (stamping
 * `nightShift.lastRunDay` on a once-a-day task's completion). Keeping the
 * window-key math in one place is what makes the once-per-day guard
 * survive the midnight boundary: a single overnight window (e.g. 22:00 →
 * 06:00) maps to ONE stable key — the local date the window *started* — so
 * a task that ran at 23:00 is still "ran today" at 02:00 the next morning.
 */

export interface NightShiftWindow {
  /** Local hour the window opens (0–23). */
  startHour: number;
  /** Local hour the window closes (0–23). May be ≤ startHour to wrap midnight. */
  endHour: number;
}

/** Classic overnight default when nothing is configured. */
export const DEFAULT_NIGHT_SHIFT_WINDOW: NightShiftWindow = { startHour: 22, endHour: 6 };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local 'YYYY-MM-DD' for a date. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Whether `now` falls inside the (possibly midnight-wrapping) window. */
export function isInNightShiftWindow(now: Date, window: NightShiftWindow): boolean {
  const h = now.getHours();
  const { startHour, endHour } = window;
  // Equal bounds = a 24-hour always-on window.
  if (startHour === endHour) return true;
  if (startHour < endHour) return h >= startHour && h < endHour;
  // Wraps midnight: in window late tonight OR early tomorrow.
  return h >= startHour || h < endHour;
}

/**
 * Stable key for the window instance covering `now`: the local date on
 * which the current window *started*, or null when `now` is outside the
 * window. For a wrapping window, the early-morning tail (before `endHour`)
 * belongs to the previous calendar day's window.
 */
export function nightShiftWindowKey(now: Date, window: NightShiftWindow): string | null {
  if (!isInNightShiftWindow(now, window)) return null;
  const wraps = window.startHour > window.endHour;
  if (wraps && now.getHours() < window.endHour) {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - 1);
    return localDateKey(prev);
  }
  return localDateKey(now);
}

/**
 * Day key used to stamp/compare a once-a-day night-shift run: the
 * window-start date when inside a window, else the plain local date.
 */
export function nightShiftDayKey(now: Date, window: NightShiftWindow): string {
  return nightShiftWindowKey(now, window) ?? localDateKey(now);
}

/**
 * The night window the morning review talks about: the current window
 * when `now` is inside one, else the most recently COMPLETED window.
 * `key` matches `nightShiftWindowKey` for instants inside that window
 * (and therefore `Task.nightShift.lastRunDay` stamps from it). For an
 * always-on window (equal bounds) the "window" is the last 24h and the
 * key is the local date.
 */
export function lastNightShiftWindow(
  now: Date,
  window: NightShiftWindow,
): { key: string; start: Date; end: Date } {
  const { startHour, endHour } = window;
  if (startHour === endHour) {
    const end = new Date(now);
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    return { key: localDateKey(now), start, end };
  }
  // The window's start day: today when we're inside it or past its end;
  // otherwise the window that ended earlier today started yesterday (for
  // wrapping windows) or hasn't happened today yet (non-wrapping, before
  // start → yesterday's window).
  const wraps = startHour > endHour;
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  if (wraps) {
    // Window runs startHour → next-day endHour.
    if (now.getHours() >= startHour) {
      // Inside tonight's window (before midnight).
      start.setTime(start.getTime()); // today startHour
    } else {
      // Early morning (inside the tail) or daytime (after the tail
      // closed): either way the relevant window started yesterday.
      start.setDate(start.getDate() - 1);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(endHour, 0, 0, 0);
    return { key: localDateKey(start), start, end };
  }
  // Non-wrapping same-day window.
  if (now.getHours() < startHour) {
    start.setDate(start.getDate() - 1);
  }
  const end = new Date(start);
  end.setHours(endHour, 0, 0, 0);
  return { key: localDateKey(start), start, end };
}

/**
 * The scheduled window a status surface should name: the one open right
 * now, else the next one due. `open` tells the caller which it got — the
 * difference between "started 22:00, ends 06:00" and "next window 22:00 →
 * 06:00". An always-on window (equal bounds) is permanently open and
 * reported as the rolling last 24h, matching {@link lastNightShiftWindow}.
 */
export function nightShiftWindowBounds(
  now: Date,
  window: NightShiftWindow,
): { start: Date; end: Date; open: boolean } {
  if (isInNightShiftWindow(now, window)) {
    const { start, end } = lastNightShiftWindow(now, window);
    return { start, end, open: true };
  }
  const start = nextNightShiftStart(now, window);
  const end = new Date(start);
  // Wall-clock arithmetic, same as lastNightShiftWindow: a window that
  // wraps midnight ends on the following local date at `endHour`.
  if (window.endHour <= window.startHour) end.setDate(end.getDate() + 1);
  end.setHours(window.endHour, 0, 0, 0);
  return { start, end, open: false };
}

/**
 * The next local datetime the window opens, strictly after `now`. Used to
 * pre-schedule an OS wake (`wakeOnStart`) so a sleeping machine comes up
 * for the upcoming shift — the service can't detect the window if it's
 * asleep, so the wake must be armed in advance.
 */
export function nextNightShiftStart(now: Date, window: NightShiftWindow): Date {
  const candidate = new Date(now);
  candidate.setHours(window.startHour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * How a settled night window is described to the user, in one or two
 * plain sentences. Shared by the morning needs-input card, Home's "Last
 * night" panel, and the question prompt the service synthesizes, so the
 * three surfaces can never disagree about what the shift did — and so
 * nobody has to read `1 task(s) completed`.
 */
export function formatNightShiftSummary(counts: {
  tasks: number;
  reports: number;
  /** Change proposals still awaiting a decision. */
  proposals?: number;
  /** Report-embedded actions still in the `suggested` state. */
  actions?: number;
}): string {
  const leftBehind: string[] = [];
  if (counts.reports > 0) leftBehind.push(countOf(counts.reports, 'report'));
  if ((counts.proposals ?? 0) > 0) {
    leftBehind.push(countOf(counts.proposals ?? 0, 'change proposal'));
  }

  let summary: string;
  if (counts.tasks > 0 && leftBehind.length > 0) {
    summary = `The night shift finished ${countOf(counts.tasks, 'task')} and left ${joinList(leftBehind)} for you.`;
  } else if (counts.tasks > 0) {
    summary = `The night shift finished ${countOf(counts.tasks, 'task')}.`;
  } else if (leftBehind.length > 0) {
    summary = `The night shift left ${joinList(leftBehind)} for you.`;
  } else {
    summary = 'The night shift ran, but nothing came of it.';
  }

  const actions = counts.actions ?? 0;
  if (actions === 0) return summary;
  return `${summary} ${actions === 1 ? 'There is' : 'There are'} ${countOf(actions, 'suggested action')} to review.`;
}
