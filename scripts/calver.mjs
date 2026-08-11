/**
 * The date-based line gezel builds are compared on.
 *
 * Content in gilde declares `minGezelVersion` floors authored as `1.YYDDD`
 * ("any build of that day or later"), so whatever a build compares against has
 * to be on the same axis. The Electron scheme already is — `stamp-version.mjs`
 * produces `1.YYDDD.RUN`. The npm scheme is not: it is semver, and semver
 * carries no recency, which is why both stamping scripts derive the compat
 * value from here instead of reusing the published version.
 *
 * Shared rather than duplicated because the day-of-year base is easy to get
 * subtly wrong (`Date.UTC(y, 0, 0)` makes Jan 1 day 1, not day 0), and the two
 * channels disagreeing about what day it is would be a silent content bug.
 */

/**
 * `1.YYDDD` for `now` — the two-component prefix floors are authored against.
 * Callers that have a build/run counter append it themselves.
 */
export function calVerPrefix(now = new Date()) {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start) / 86400000);
  const ddd = String(dayOfYear).padStart(3, '0');
  return `1.${yy}${ddd}`;
}
