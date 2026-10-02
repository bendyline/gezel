import { describe, expect, it } from 'vitest';
import { nextCronFire, parseCron } from './cron.js';

describe('parseCron', () => {
  it('rejects wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('* * * * * *')).toThrow();
  });

  it('rejects out-of-range numbers', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 24 * * *')).toThrow();
    expect(() => parseCron('0 9 * * 8')).toThrow();
  });

  it.each([
    ['7', [0]],
    ['0,7', [0]],
    ['1,7', [0, 1]],
    ['5-7', [0, 5, 6]],
    ['1-7/2', [0, 1, 3, 5]],
    ['7/2', [0]],
    ['*/2', [0, 2, 4, 6]],
    ['*', [0, 1, 2, 3, 4, 5, 6]],
  ] as const)('normalizes Sunday in %s', (field, expected) => {
    const schedule = parseCron(`0 9 * * ${field}`);
    expect([...schedule.dayOfWeek.allowed].sort()).toEqual(expected);
    expect(schedule.dayOfWeek.max).toBe(6);
  });
});

describe('nextCronFire', () => {
  it('schedules Sunday=7 identically to Sunday=0 across week boundaries', () => {
    for (const from of ['2026-10-03T10:00:00Z', '2026-10-04T09:00:00Z']) {
      const next = nextCronFire(parseCron('0 9 * * 7'), new Date(from));
      expect(next).toEqual(nextCronFire(parseCron('0 9 * * 0'), new Date(from)));
      expect(next.getUTCDay()).toBe(0);
      expect(next.getUTCHours()).toBe(9);
      expect(next.getTime()).toBeGreaterThan(Date.parse(from));
    }
  });
  it('every minute fires the next minute', () => {
    const s = parseCron('* * * * *');
    const base = new Date('2026-04-14T10:00:30Z');
    const next = nextCronFire(s, base);
    expect(next.getUTCMinutes()).toBe(1);
    expect(next.getUTCHours()).toBe(10);
  });

  it('daily at 09:00 fires tomorrow when past', () => {
    const s = parseCron('0 9 * * *');
    const base = new Date('2026-04-14T10:00:00Z');
    const next = nextCronFire(s, base);
    expect(next.getUTCDate()).toBe(15);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it('step / range work together', () => {
    const s = parseCron('*/15 * * * *');
    const base = new Date('2026-04-14T10:03:00Z');
    const next = nextCronFire(s, base);
    expect(next.getUTCMinutes()).toBe(15);
  });
});
