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
