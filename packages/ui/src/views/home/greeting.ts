import type { MeesterStatusReport } from '@bendyline/gezel';
/** Time-of-day greeting. There is no stored user name, so callers append none. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * How long a meester status report stays on the headline before the
 * band decays back to the time-of-day greeting. Long enough to survive
 * a quiet day (runs only happen when projects change), short enough
 * that a days-old "your game is done!" never greets the user.
 */
export const STATUS_FRESH_MS = 36 * 60 * 60_000;

/** Whether a report stamped `at` is still fresh enough to headline. */
export function isFreshStatus(at: string, now: number = Date.now()): boolean {
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age < STATUS_FRESH_MS;
}

/** The report if it's still fresh enough to headline, else null. */
export function freshStatusReport(
  report: MeesterStatusReport | null | undefined,
  now: number = Date.now(),
): MeesterStatusReport | null {
  return report && isFreshStatus(report.generatedAt, now) ? report : null;
}
