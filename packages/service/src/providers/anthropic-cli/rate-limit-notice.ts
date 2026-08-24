/**
 * Turn the CLI's `rate_limit_event` into something a person can act on.
 *
 * The raw event is machine vocabulary — `allowed_warning`, `seven_day`, a
 * unix timestamp — and shipping it verbatim into the chat transcript
 * produced lines like "Claude subscription rate limit (seven-day):
 * allowed_warning. Resets 5:00:00 PM.": three pieces of jargon and a bare
 * clock time for a boundary that is usually days away.
 *
 * Two things this module owns beyond wording:
 *
 *  - **Reset times are stated relative to now.** A seven-day window resets
 *    on some future weekday; "5:00:00 PM" reads as "in a few hours" and is
 *    wrong by days.
 *  - **A stable posture identity** ({@link RateLimitNotice.key}). The event
 *    repeats on every turn for as long as the posture holds, and a banner
 *    on every reply is a banner the user stops reading.
 */

export interface RateLimitNoticeInput {
  /** CLI status verb — `allowed`, `allowed_warning`, `rejected`, … */
  status: string;
  /** Window identifier — `five_hour`, `seven_day`, … */
  rateLimitType: string | undefined;
  /** Window boundary, unix **seconds**. */
  resetsAt: number | undefined;
  isUsingOverage: boolean;
}

export interface RateLimitNotice {
  text: string;
  /**
   * Identity of the posture being reported. Unchanged across the repeat
   * events that arrive each turn while the same window is in the same
   * state, so a caller can suppress everything but the first.
   */
  key: string;
}

/**
 * Compose the user-facing notice, or `null` when there is nothing worth
 * saying — the happy path, which arrives on every single turn.
 */
export function formatRateLimitNotice(
  input: RateLimitNoticeInput,
  now: number = Date.now(),
  /** Test seam — defaults to the host locale, which is what a user reads. */
  locale?: string,
): RateLimitNotice | null {
  const status = input.status.trim().toLowerCase();
  if (!status || status === 'allowed') return null;

  const window = windowLabel(input.rateLimitType);
  const sentences: string[] = [];

  if (isExhausted(status)) {
    sentences.push(`You've used up your ${window} Claude usage limit.`);
    const reset = resetPhrase(input.resetsAt, now, locale);
    sentences.push(
      reset
        ? `Claude can't answer again until it resets ${reset}.`
        : `Claude can't answer again until it resets.`,
    );
    sentences.push('Switch this gezel to another model to keep working in the meantime.');
  } else if (isNearLimit(status)) {
    sentences.push(`You're close to your ${window} Claude usage limit.`);
    const reset = resetPhrase(input.resetsAt, now, locale);
    if (reset) sentences.push(`It resets ${reset}.`);
  } else {
    // An unrecognized verb still reaches the user, raw and labelled as
    // such — inventing a reassuring paraphrase for a status we don't
    // model is worse than a slightly technical sentence.
    sentences.push(`Claude reported an unfamiliar ${window} usage-limit status: ${input.status}.`);
    const reset = resetPhrase(input.resetsAt, now, locale);
    if (reset) sentences.push(`The window resets ${reset}.`);
  }

  if (input.isUsingOverage) {
    sentences.push('Usage past the limit is billing to your account as overage.');
  }

  return {
    text: sentences.join(' '),
    key: [status, input.rateLimitType ?? '', input.resetsAt ?? '', input.isUsingOverage].join('|'),
  };
}

function isExhausted(status: string): boolean {
  return (
    status.includes('reject') ||
    status.includes('exceed') ||
    status.includes('exhaust') ||
    status.includes('block')
  );
}

function isNearLimit(status: string): boolean {
  return status.includes('warn') || status.includes('approach');
}

/**
 * `seven_day` is the identifier; "weekly" is what it means. Unknown
 * windows degrade to a readable form of whatever the CLI sent rather
 * than being dropped — a new window class should still be nameable.
 */
function windowLabel(rateLimitType: string | undefined): string {
  if (!rateLimitType) return 'Claude subscription';
  const raw = rateLimitType.trim().toLowerCase();
  if (!raw) return 'Claude subscription';
  if (raw === 'seven_day' || raw === 'seven-day') return 'weekly';
  if (raw === 'five_hour' || raw === 'five-hour') return '5-hour';
  const hours = /^(\d+)[_-]hours?$/.exec(raw);
  if (hours) return `${hours[1]}-hour`;
  const days = /^(\d+)[_-]days?$/.exec(raw);
  if (days) return days[1] === '7' ? 'weekly' : `${days[1]}-day`;
  return raw.replace(/[_-]+/g, ' ');
}

/**
 * "today at 5:00 PM" / "tomorrow at 9:00 AM" / "Thursday at 5:00 PM" /
 * "on Sep 3 at 5:00 PM". Returns undefined for a missing, unusable, or
 * already-past boundary — a stale reset time is worse than none.
 */
function resetPhrase(
  resetsAt: number | undefined,
  now: number,
  locale: string | undefined,
): string | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const at = new Date(resetsAt * 1000);
  const ms = at.getTime();
  if (Number.isNaN(ms) || ms <= now) return undefined;

  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const days = calendarDaysAhead(new Date(now), at);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: 'long' })} at ${time}`;
  return `on ${at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} at ${time}`;
}

/**
 * Whole calendar days between two local dates. Compared at midnight so a
 * boundary 90 minutes away that lands after midnight still says
 * "tomorrow" rather than "today".
 */
function calendarDaysAhead(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}
