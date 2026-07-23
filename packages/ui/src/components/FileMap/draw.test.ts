import { describe, expect, it } from 'vitest';
import { ageBucket } from './draw.js';

const NOW = Date.parse('2026-07-05T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('ageBucket (age lens)', () => {
  it('buckets placement age into week / month / quarter / older', () => {
    expect(ageBucket(daysAgo(0), NOW)).toBe(0);
    expect(ageBucket(daysAgo(7), NOW)).toBe(0);
    expect(ageBucket(daysAgo(8), NOW)).toBe(1);
    expect(ageBucket(daysAgo(30), NOW)).toBe(1);
    expect(ageBucket(daysAgo(31), NOW)).toBe(2);
    expect(ageBucket(daysAgo(90), NOW)).toBe(2);
    expect(ageBucket(daysAgo(91), NOW)).toBe(3);
    expect(ageBucket(daysAgo(400), NOW)).toBe(3);
  });

  it('returns null for missing or junk timestamps (pre-timestamp layouts)', () => {
    expect(ageBucket(null, NOW)).toBeNull();
    expect(ageBucket(undefined, NOW)).toBeNull();
    expect(ageBucket('not-a-date', NOW)).toBeNull();
  });
});
