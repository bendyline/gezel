import { describe, expect, it } from 'vitest';
import {
  FIRST_USE_INDEXING_GRACE_MS,
  QUIET_NIGHT_GRACE_MS,
  firstUseAgeMs,
  firstUseGraceRemainingMs,
  isWithinFirstUse,
} from './first-use.js';

const started = '2026-10-11T09:00:00.000Z';
const at = (minutes: number) => Date.parse(started) + minutes * 60_000;

describe('first use', () => {
  it('treats an install without the stamp as established', () => {
    expect(firstUseAgeMs(undefined, at(1))).toBeNull();
    expect(isWithinFirstUse(undefined, at(1), FIRST_USE_INDEXING_GRACE_MS)).toBe(false);
    expect(firstUseGraceRemainingMs(undefined, at(1), FIRST_USE_INDEXING_GRACE_MS)).toBe(0);
  });

  it('treats an unreadable stamp as established', () => {
    expect(firstUseAgeMs('not a date', at(1))).toBeNull();
    expect(isWithinFirstUse('not a date', at(1), QUIET_NIGHT_GRACE_MS)).toBe(false);
  });

  it('holds indexing for the first half hour', () => {
    expect(isWithinFirstUse(started, at(29), FIRST_USE_INDEXING_GRACE_MS)).toBe(true);
    expect(isWithinFirstUse(started, at(30), FIRST_USE_INDEXING_GRACE_MS)).toBe(false);
    expect(firstUseGraceRemainingMs(started, at(10), FIRST_USE_INDEXING_GRACE_MS)).toBe(
      20 * 60_000,
    );
  });

  it('keeps quiet nights unreported for the first three days', () => {
    expect(isWithinFirstUse(started, at(60 * 24 * 3 - 1), QUIET_NIGHT_GRACE_MS)).toBe(true);
    expect(isWithinFirstUse(started, at(60 * 24 * 3), QUIET_NIGHT_GRACE_MS)).toBe(false);
  });

  it('clamps a clock running behind the stamp to the start of first use', () => {
    expect(firstUseAgeMs(started, at(-5))).toBe(0);
    expect(isWithinFirstUse(started, at(-5), FIRST_USE_INDEXING_GRACE_MS)).toBe(true);
  });
});
