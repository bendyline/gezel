import { describe, expect, it } from 'vitest';
import { clock, dayWord, scheduleRunsSummary, shortDate } from './schedule-runs-summary.js';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const nightHost = { nightShift: { enabled: true, onceADay: true } };
const tonight = { start: at(9, 22), end: at(10, 6) };

describe('scheduleRunsSummary', () => {
  it('names the cadence and tonight, never the half-hourly check', () => {
    const summary = scheduleRunsSummary({
      host: nightHost,
      next: { kind: 'at', at: at(9, 22), soon: false },
      runs: [],
      nightWindow: tonight,
      now: at(9, 15),
    });
    expect(summary.nextWord).toBe('Tonight');
    expect(summary.nextClock).toBe(clock(at(9, 22)));
    expect(summary.line).toBe(
      `Runs once a night during the Night Shift, ${clock(at(9, 22))} to ${clock(at(10, 6))}. The next run starts tonight at ${clock(at(9, 22))}.`,
    );
    expect(summary.line).not.toMatch(/30|cron|window/i);
  });

  it('says which run the next one is waiting on', () => {
    const summary = scheduleRunsSummary({
      host: nightHost,
      next: { kind: 'after-run', runRef: 'squisq/37', at: at(9, 22) },
      runs: [{ ref: 'squisq/37', createdAt: at(9, 5, 53).toISOString() }],
      nightWindow: tonight,
      now: at(9, 15),
    });
    expect(summary.nextWord).toBe('After this run');
    expect(summary.line).toContain(
      `The run from ${shortDate(at(9, 5, 53))} is still going, so the next one starts after it finishes.`,
    );
  });

  it('points at the switch when the Night Shift is off', () => {
    const summary = scheduleRunsSummary({
      host: nightHost,
      next: { kind: 'no-night-shift' },
      runs: [],
      nightWindow: null,
      now: at(9, 15),
    });
    expect(summary.nextWord).toBe('Not scheduled');
    expect(summary.line).toContain('Settings → General');
  });

  it('says how Crew activity is holding it', () => {
    const summary = scheduleRunsSummary({
      host: nightHost,
      next: { kind: 'held', mode: 'reactive' },
      runs: [],
      nightWindow: tonight,
      now: at(9, 15),
    });
    expect(summary.nextWord).toBe('On hold');
    expect(summary.line).toContain('Chat only');
  });
});

describe('dayWord', () => {
  it('reads today, tonight, tomorrow and later days plainly', () => {
    const now = at(9, 15);
    expect(dayWord(at(9, 22), now)).toBe('tonight');
    expect(dayWord(at(9, 16), now)).toBe('today');
    expect(dayWord(at(10, 22), now)).toBe('tomorrow');
    expect(dayWord(at(12, 22), now)).toBe(
      `on ${at(12, 22).toLocaleDateString(undefined, { weekday: 'long' })}`,
    );
  });
});
