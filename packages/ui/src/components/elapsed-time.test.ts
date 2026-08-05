import { describe, expect, it } from 'vitest';
import { formatElapsedClock } from './elapsed-time.js';

describe('formatElapsedClock', () => {
  it.each([
    [0, ':00'],
    [4, ':04'],
    [59, ':59'],
    [60, '1:00'],
    [64, '1:04'],
    [125, '2:05'],
  ])('formats %i elapsed seconds as %s', (seconds, expected) => {
    expect(formatElapsedClock(seconds)).toBe(expected);
  });
});
