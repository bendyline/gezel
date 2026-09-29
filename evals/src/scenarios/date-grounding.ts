import { resolvePromptTimeZone } from '@bendyline/gezel';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Date grounding — does the team know what day it is?
 *
 * Until the per-turn clock line (core/prompt-clock.ts) no prompt layer
 * carried the date, so models answered from their training data: a Meester
 * planned "the week of May 20th" in September 2026 and the invented date
 * flowed into a craftbook parameter, filenames, and a customer quote. This
 * probe asks an owner's scheduling question whose answer depends on today
 * and grades the dates in the reply against the host clock, in the zone the
 * daemon renders the clock line in.
 *
 * Pass: the reply names today's date and the first Friday after today.
 * Fail: a finished reply that names anything else. A trial that crosses
 * midnight is graded against both days.
 */

const SALE_MARKER = 'customer-appreciation sale';

export const DATE_GROUNDING_PROMPT = [
  'Quick scheduling question: just answer here in chat, no tasks or files.',
  `I want to hold a ${SALE_MARKER} on the first Friday after today.`,
  "What is today's date, and what is the date of that Friday?",
  'Give both dates as YYYY-MM-DD.',
].join(' ');

const FRIDAY = 5;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const pad = (n: number) => String(n).padStart(2, '0');

function isoFromParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Every calendar date a reply names, as YYYY-MM-DD. The prompt asks for ISO,
 * but this measures grounding, not formatting, so "October 2, 2026" and
 * "2 October 2026" count too.
 */
export function extractDates(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const iso = isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.add(iso);
  }
  const month = MONTHS.join('|');
  const monthFirst = new RegExp(
    `\\b(${month})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const m of text.matchAll(monthFirst)) {
    const iso = isoFromParts(
      Number(m[3]),
      MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1,
      Number(m[2]),
    );
    if (iso) found.add(iso);
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${month}),?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(dayFirst)) {
    const iso = isoFromParts(
      Number(m[3]),
      MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1,
      Number(m[1]),
    );
    if (iso) found.add(iso);
  }
  return found;
}

/** The calendar date of `at` in `timeZone`, as YYYY-MM-DD. */
export function localIsoDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The first `weekday` (0 = Sunday) strictly after the date `iso`. */
export function firstWeekdayAfter(iso: string, weekday: number): string {
  const day = new Date(`${iso}T00:00:00Z`);
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() !== weekday);
  return day.toISOString().slice(0, 10);
}

export interface DateAnswer {
  today: string;
  friday: string;
}

/** One acceptable answer per distinct calendar day the trial touched. */
export function expectedDateAnswers(times: readonly Date[], timeZone: string): DateAnswer[] {
  const days = [...new Set(times.map((t) => localIsoDate(t, timeZone)))];
  return days.map((today) => ({ today, friday: firstWeekdayAfter(today, FRIDAY) }));
}

export function gradeDateAnswer(
  reply: string,
  expected: readonly DateAnswer[],
): { ok: true; matched: DateAnswer } | { ok: false; reason: string } {
  const named = extractDates(reply);
  const matched = expected.find((e) => named.has(e.today) && named.has(e.friday));
  if (matched) return { ok: true, matched };
  const want = expected.map((e) => `today ${e.today} and Friday ${e.friday}`).join(', or ');
  const got = named.size > 0 ? [...named].join(', ') : 'no dates';
  return { ok: false, reason: `reply named ${got}; expected ${want}` };
}

// Keyed by Meester id because parallel trials share this module but never a
// Meester (each trial boots its own home).
const trialStartByMeester = new Map<string, Date>();

async function setup({ meesterId }: EvalContext): Promise<void> {
  trialStartByMeester.set(meesterId, new Date());
}

/**
 * The text of every assistant message that answered the kickoff, or null
 * while the kickoff has not been sent or its turn is still running.
 */
async function kickoffReply({ client, meesterId }: EvalContext): Promise<string | null> {
  const { sessions } = await client.listChatSessions({ gezelId: meesterId });
  for (const summary of sessions) {
    const session = await client.getChatSession(summary.id).catch(() => null);
    if (!session) continue;
    const kickoff = session.messages.findIndex(
      (m) => m.role === 'user' && m.content.includes(SALE_MARKER),
    );
    if (kickoff < 0) continue;
    if (session.turnStartedAt) return null;
    return session.messages
      .slice(kickoff + 1)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n\n');
  }
  return null;
}

export const dateGroundingScenario: EvalScenario = {
  id: 'date-grounding',
  description:
    "Asks the Meester for today's date and the first Friday after it, then grades both " +
    'against the host clock. Catches a team answering dates from training data.',
  prompt: DATE_GROUNDING_PROMPT,
  timeoutMs: 10 * 60_000,
  suggestedTrials: 2,
  setup,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const reply = await kickoffReply(ctx).catch(() => null);
    if (reply === null) {
      ctx.recordSniff?.({ key: 'date-grounding', score: 0, bytes: 0, deliverableMissing: true });
      return { done: false };
    }
    const now = new Date();
    const started = trialStartByMeester.get(ctx.meesterId) ?? now;
    const timeZone = resolvePromptTimeZone();
    const verdict = gradeDateAnswer(reply, expectedDateAnswers([started, now], timeZone));
    ctx.logChanged(
      'date-grounding',
      `[scenario] date-grounding: ${verdict.ok ? `matched ${verdict.matched.today}` : verdict.reason}`,
    );
    if (verdict.ok) {
      return {
        done: true,
        success: true,
        reason: `named today ${verdict.matched.today} and Friday ${verdict.matched.friday} (${timeZone})`,
      };
    }
    return {
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: verdict.reason,
    };
  },
};
