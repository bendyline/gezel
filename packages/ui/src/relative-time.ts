/**
 * The one relative-time formatter.
 *
 * Before this module every surface grew its own `formatRelative` — eleven of
 * them — and they disagreed on both the wording and the point at which they
 * gave up. The git status bar rolled over to a bare calendar date after 24h
 * ("synced 7/24/2026") while the panel beside it was still counting days
 * ("17d ago"), so one screen showed two calendars. Relative labels now stay
 * relative at every distance; the exact timestamp lives in the `title` from
 * {@link formatAbsoluteTime}, which every display site should set.
 *
 * Two styles, same thresholds, so a compact chip and a prose line never
 * disagree about which bucket a moment falls in:
 *   short — "just now" · "18m ago" · "3h ago" · "yesterday" · "4d ago" · "2w ago"
 *   long  — "just now" · "18 minutes ago" · "3 hours ago" · "yesterday" · …
 */

export type RelativeTimeStyle = 'short' | 'long';

export interface RelativeTimeOptions {
  style?: RelativeTimeStyle;
  /**
   * Count seconds under the first minute instead of saying "just now".
   * For rows where a write lands while the user is watching (file mtimes,
   * worker pools) the ticking seconds are the signal.
   */
  seconds?: boolean;
  /** Injected in tests; defaults to `Date.now()`. */
  now?: number;
  /** Shown when the input is missing or unparseable. */
  fallback?: string;
}

/** An instant, in any of the shapes the API layer hands us. */
export type TimeInput = string | number | Date | null | undefined;

function toEpochMs(at: TimeInput): number | null {
  if (at === null || at === undefined || at === '') return null;
  if (at instanceof Date) {
    const ms = at.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function formatRelativeTime(at: TimeInput, opts: RelativeTimeOptions = {}): string {
  const { style = 'short', seconds = false, now = Date.now(), fallback = '' } = opts;
  const then = toEpochMs(at);
  if (then === null) return fallback;

  // A clock skew between the daemon and the renderer must not print
  // "-3m ago"; anything in the future reads as this moment.
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
  const long = style === 'long';

  if (deltaSec < 60) {
    if (!seconds || deltaSec < 1) return 'just now';
    return long ? `${plural(deltaSec, 'second')} ago` : `${deltaSec}s ago`;
  }
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return long ? `${plural(min, 'minute')} ago` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return long ? `${plural(hr, 'hour')} ago` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return long ? `${plural(day, 'day')} ago` : `${day}d ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return long ? `${plural(week, 'week')} ago` : `${week}w ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return long ? `${plural(month, 'month')} ago` : `${month}mo ago`;
  const year = Math.floor(day / 365);
  return long ? `${plural(year, 'year')} ago` : `${year}y ago`;
}

/**
 * The exact instant, for the `title` beside a relative label. Locale-aware
 * so a European install doesn't read an American month/day ordering.
 */
export function formatAbsoluteTime(at: TimeInput, fallback = ''): string {
  const then = toEpochMs(at);
  if (then === null) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(then));
}
