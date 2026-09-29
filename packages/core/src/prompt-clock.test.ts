import { describe, expect, it } from 'vitest';
import {
  CURRENT_DATE_TIME_PREFIX,
  renderCurrentDateTimeLine,
  resolvePromptTimeZone,
  stripCurrentDateTimeLine,
  withCurrentDateTimeLine,
} from './prompt-clock.js';

describe('renderCurrentDateTimeLine', () => {
  it('names the local weekday, date, time, zone, and offset', () => {
    const line = renderCurrentDateTimeLine(new Date('2026-09-28T17:44:00Z'), 'America/Los_Angeles');
    expect(line).toBe(
      '[Current date and time: Monday, September 28, 2026, 10:44 AM (America/Los_Angeles, UTC-07:00)]',
    );
  });

  it('uses the local calendar day, not the UTC one', () => {
    const line = renderCurrentDateTimeLine(new Date('2026-09-28T06:30:00Z'), 'America/Los_Angeles');
    expect(line).toContain('Sunday, September 27, 2026');
  });

  it('follows daylight saving', () => {
    const line = renderCurrentDateTimeLine(new Date('2026-12-01T20:00:00Z'), 'America/Los_Angeles');
    expect(line).toContain('UTC-08:00');
  });

  it('prints half-hour offsets and UTC itself', () => {
    expect(renderCurrentDateTimeLine(new Date('2026-09-28T12:00:00Z'), 'Asia/Kolkata')).toContain(
      '(Asia/Kolkata, UTC+05:30)',
    );
    expect(renderCurrentDateTimeLine(new Date('2026-09-28T12:00:00Z'), 'UTC')).toContain(
      '(UTC, UTC+00:00)',
    );
  });
});

describe('resolvePromptTimeZone', () => {
  it('keeps a valid preferred zone and ignores an invalid one', () => {
    expect(resolvePromptTimeZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(resolvePromptTimeZone('Not/AZone')).toBe(resolvePromptTimeZone());
  });
});

describe('date line framing', () => {
  it('puts the line first and strips it back off', () => {
    const line = renderCurrentDateTimeLine(new Date('2026-09-28T17:44:00Z'), 'UTC');
    const framed = withCurrentDateTimeLine('What is the date this Thursday?', line);
    expect(framed.startsWith(CURRENT_DATE_TIME_PREFIX)).toBe(true);
    expect(framed.endsWith('What is the date this Thursday?')).toBe(true);
    expect(stripCurrentDateTimeLine(framed)).toBe('What is the date this Thursday?');
    expect(stripCurrentDateTimeLine('plain text')).toBe('plain text');
  });
});
