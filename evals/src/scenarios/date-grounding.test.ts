import { renderCurrentDateTimeLine } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  DATE_GROUNDING_PROMPT,
  dateGroundingScenario,
  expectedDateAnswers,
  extractDates,
  firstWeekdayAfter,
  gradeDateAnswer,
  localIsoDate,
} from './date-grounding.ts';

const MONDAY = new Date('2026-09-28T17:44:00Z');
const LA = 'America/Los_Angeles';

describe('date-grounding grader', () => {
  it('reads ISO and written dates', () => {
    const dates = extractDates(
      'Today is 2026-09-28. The sale is on Friday, October 2, 2026 (or 9 October 2026).',
    );
    expect([...dates].sort()).toEqual(['2026-09-28', '2026-10-02', '2026-10-09']);
  });

  it('takes the date in the zone the clock line is rendered in', () => {
    const lateEvening = new Date('2026-09-29T05:30:00Z');
    expect(localIsoDate(lateEvening, LA)).toBe('2026-09-28');
    expect(localIsoDate(lateEvening, 'UTC')).toBe('2026-09-29');
  });

  it('never answers today for "the first Friday after today"', () => {
    expect(firstWeekdayAfter('2026-09-28', 5)).toBe('2026-10-02');
    expect(firstWeekdayAfter('2026-10-02', 5)).toBe('2026-10-09');
  });

  it('passes the answer the clock line makes available', () => {
    // The model sees exactly this line; a grounded answer copies its date.
    expect(renderCurrentDateTimeLine(MONDAY, LA)).toContain('Monday, September 28, 2026');
    const verdict = gradeDateAnswer(
      'Today is 2026-09-28, so the first Friday after today is 2026-10-02.',
      expectedDateAnswers([MONDAY], LA),
    );
    expect(verdict.ok).toBe(true);
  });

  it('fails a training-data guess and says what it named', () => {
    const verdict = gradeDateAnswer(
      'Today is 2024-05-20, so the sale would be on 2024-05-24.',
      expectedDateAnswers([MONDAY], LA),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain('2024-05-20');
      expect(verdict.reason).toContain('2026-10-02');
    }
  });

  it('accepts either day when the trial crosses midnight', () => {
    const beforeMidnight = new Date('2026-10-02T06:55:00Z');
    const afterMidnight = new Date('2026-10-02T07:05:00Z');
    const expected = expectedDateAnswers([beforeMidnight, afterMidnight], LA);
    expect(expected).toEqual([
      { today: '2026-10-01', friday: '2026-10-02' },
      { today: '2026-10-02', friday: '2026-10-09' },
    ]);
    expect(gradeDateAnswer('2026-10-02 and 2026-10-09', expected).ok).toBe(true);
  });

  it('asks for exactly what it grades', () => {
    expect(DATE_GROUNDING_PROMPT).toMatch(/today's date/);
    expect(DATE_GROUNDING_PROMPT).toMatch(/first Friday after today/);
  });
});

describe('date-grounding success check', () => {
  function contextWith(session: {
    turnStartedAt?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): EvalContext {
    const client = {
      listChatSessions: async () => ({ sessions: [{ id: 's1' }] }),
      getChatSession: async () => ({ id: 's1', ...session }),
    };
    return {
      client: client as unknown as EvalContext['client'],
      meesterId: 'meester',
      log: () => {},
      logChanged: () => {},
    };
  }

  it('waits while the kickoff turn is still running', async () => {
    const result = await dateGroundingScenario.successCheck(
      contextWith({
        turnStartedAt: new Date().toISOString(),
        messages: [{ role: 'user', content: DATE_GROUNDING_PROMPT }],
      }),
    );
    expect(result.done).toBe(false);
  });

  it('grades the finished reply against the host clock', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = localIsoDate(new Date(), zone);
    const friday = firstWeekdayAfter(today, 5);
    const ctx = contextWith({
      messages: [
        { role: 'user', content: DATE_GROUNDING_PROMPT },
        { role: 'assistant', content: `Today is ${today}. Your sale Friday is ${friday}.` },
      ],
    });
    await dateGroundingScenario.setup?.(ctx);
    const result = await dateGroundingScenario.successCheck(ctx);
    expect(result).toMatchObject({ done: true, success: true });
  });

  it('fails a finished reply with no dates', async () => {
    const result = await dateGroundingScenario.successCheck(
      contextWith({
        messages: [
          { role: 'user', content: DATE_GROUNDING_PROMPT },
          { role: 'assistant', content: 'Happy to help plan the sale!' },
        ],
      }),
    );
    expect(result).toMatchObject({ done: true, success: false });
  });
});
