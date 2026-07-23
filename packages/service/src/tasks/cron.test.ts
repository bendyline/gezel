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
  });
});

describe('nextCronFire', () => {
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
