/**
 * The current date and time as one line at the start of a model turn.
 *
 * No prompt layer carried the date, so models fell back on their training
 * data: a Meester planned "the week of May 20th" in September 2026, and the
 * invented date flowed into a craftbook parameter, filenames, and a customer
 * quote — and survived the owner's explicit correction. The line rides the
 * per-turn user message, never the system prompt, so it cannot churn the
 * cacheable prefix local engines reuse across turns.
 */

export const CURRENT_DATE_TIME_PREFIX = '[Current date and time: ';

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The first valid IANA zone of `preferred`, the host's zone, then UTC. */
export function resolvePromptTimeZone(preferred?: string): string {
  if (preferred && isValidTimeZone(preferred)) return preferred;
  try {
    const host = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (host && isValidTimeZone(host)) return host;
  } catch {
    // Fall through to UTC.
  }
  return 'UTC';
}

function utcOffsetLabel(now: Date, timeZone: string): string {
  const zoneName =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return zoneName === 'GMT' ? 'UTC+00:00' : zoneName.replace('GMT', 'UTC');
}

/**
 * `[Current date and time: Monday, September 28, 2026, 10:44 AM
 * (America/Los_Angeles, UTC-07:00)]`
 */
export function renderCurrentDateTimeLine(
  now: Date = new Date(),
  timeZone: string = resolvePromptTimeZone(),
): string {
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone, ...options })
      .format(now)
      // ICU separates "10:44" from "AM" with a narrow no-break space.
      .replace(/\u202f/g, ' ');
  const date = format({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = format({ hour: 'numeric', minute: '2-digit' });
  return `${CURRENT_DATE_TIME_PREFIX}${date}, ${time} (${timeZone}, ${utcOffsetLabel(now, timeZone)})]`;
}

/** Prefix `text` with the current date line, keeping the user's words last. */
export function withCurrentDateTimeLine(text: string, line: string): string {
  return `${line}\n\n${text}`;
}

/** Remove a leading date line added by {@link withCurrentDateTimeLine}. */
export function stripCurrentDateTimeLine(text: string): string {
  if (!text.startsWith(CURRENT_DATE_TIME_PREFIX)) return text;
  const end = text.indexOf(']\n\n');
  return end < 0 ? text : text.slice(end + 3);
}
