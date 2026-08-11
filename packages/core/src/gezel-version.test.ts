import { describe, expect, it } from 'vitest';

import {
  compareGezelVersions,
  maxMinGezelVersion,
  satisfiesMinGezelVersion,
} from './gezel-version.js';

describe('compareGezelVersions', () => {
  it('compares numerically per component', () => {
    expect(compareGezelVersions('1.26221.5', '1.26221.4')).toBe(1);
    expect(compareGezelVersions('1.26219.99', '1.26221.0')).toBe(-1);
    expect(compareGezelVersions('1.26221.7', '1.26221.7')).toBe(0);
    expect(compareGezelVersions('2.1', '1.99999.99')).toBe(1);
  });

  it('treats missing components as zero', () => {
    expect(compareGezelVersions('1.26221', '1.26221.0')).toBe(0);
    expect(compareGezelVersions('1.26221.1', '1.26221')).toBe(1);
    expect(compareGezelVersions('1', '1.0.0')).toBe(0);
  });

  it('is numeric, not lexicographic', () => {
    expect(compareGezelVersions('1.26221.10', '1.26221.9')).toBe(1);
  });

  it('returns NaN on non-numeric components', () => {
    expect(compareGezelVersions('1.x', '1.0')).toBeNaN();
    expect(compareGezelVersions('1.0', 'abc')).toBeNaN();
  });
});

describe('satisfiesMinGezelVersion', () => {
  it('is satisfied when no floor is set', () => {
    expect(satisfiesMinGezelVersion(undefined, '1.26100.1')).toBe(true);
    expect(satisfiesMinGezelVersion('', '1.26100.1')).toBe(true);
  });

  it('keys off major.minor for two-component floors', () => {
    expect(satisfiesMinGezelVersion('1.26221', '1.26221.1')).toBe(true);
    expect(satisfiesMinGezelVersion('1.26221', '1.26222.0')).toBe(true);
    expect(satisfiesMinGezelVersion('1.26221', '1.26219.99')).toBe(false);
  });

  it('honors a three-component floor', () => {
    expect(satisfiesMinGezelVersion('1.26221.5', '1.26221.5')).toBe(true);
    expect(satisfiesMinGezelVersion('1.26221.5', '1.26221.4')).toBe(false);
  });

  it('always satisfies in an unstamped dev checkout', () => {
    expect(satisfiesMinGezelVersion('1.99999', '0.0.0')).toBe(true);
  });

  it('honors the GEZEL_IGNORE_MIN_GEZEL_VERSION escape hatch', () => {
    const prev = process.env.GEZEL_IGNORE_MIN_GEZEL_VERSION;
    process.env.GEZEL_IGNORE_MIN_GEZEL_VERSION = '1';
    try {
      expect(satisfiesMinGezelVersion('1.99999', '1.26100.1')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEZEL_IGNORE_MIN_GEZEL_VERSION;
      else process.env.GEZEL_IGNORE_MIN_GEZEL_VERSION = prev;
    }
  });

  it('treats a malformed floor as satisfied', () => {
    expect(satisfiesMinGezelVersion('not-a-version', '1.26100.1')).toBe(true);
  });
});

describe('content floors are a calendar-line question, not a release-version one', () => {
  // Regression cover for the seam that made gating on `GEZEL_VERSION` wrong on
  // the npm channel. These are the values a *published semver* would present;
  // none of them may be used as `current`, which is why builds stamp
  // GEZEL_CONTENT_COMPAT separately. Kept here so the arithmetic that makes
  // the mistake dangerous stays visible.
  const floor = '1.26290';

  it('puts every plausible npm semver below a calendar floor', () => {
    // The bootstrap line and the first CI release both look "older" than any
    // floor ever authored, which silently hid floored content.
    for (const npmVersion of ['0.1.0', '0.2.0', '1.0.0', '1.1.0', '1.99.0']) {
      expect(satisfiesMinGezelVersion(floor, npmVersion), npmVersion).toBe(false);
    }
  });

  it('flips a major npm release above every floor', () => {
    // The dangerous direction: `2.0.0 > 1.26290` numerically, so a future npm
    // major would accept content requiring a build it predates — exactly what
    // the floor exists to prevent.
    expect(satisfiesMinGezelVersion(floor, '2.0.0')).toBe(true);
    expect(satisfiesMinGezelVersion('1.99999', '2.0.0')).toBe(true);
  });

  it('answers correctly for values actually on the calendar line', () => {
    expect(satisfiesMinGezelVersion(floor, '1.26289')).toBe(false);
    expect(satisfiesMinGezelVersion(floor, '1.26290')).toBe(true);
    expect(satisfiesMinGezelVersion(floor, '1.26290.4')).toBe(true);
    expect(satisfiesMinGezelVersion(floor, '1.26300')).toBe(true);
  });
});

describe('maxMinGezelVersion', () => {
  it('returns the stricter floor', () => {
    expect(maxMinGezelVersion('1.26221', '1.26300')).toBe('1.26300');
    expect(maxMinGezelVersion('1.26300', '1.26221')).toBe('1.26300');
  });

  it('passes through when one side is unset', () => {
    expect(maxMinGezelVersion(undefined, '1.26221')).toBe('1.26221');
    expect(maxMinGezelVersion('1.26221', undefined)).toBe('1.26221');
    expect(maxMinGezelVersion(undefined, undefined)).toBeUndefined();
  });

  it('prefers a well-formed floor over a malformed one', () => {
    expect(maxMinGezelVersion('garbage', '1.26221')).toBe('1.26221');
    expect(maxMinGezelVersion('1.26221', 'garbage')).toBe('1.26221');
  });
});
