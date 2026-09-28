import { describe, expect, it } from 'vitest';
import { VideoModelLoadSchema, compareSemver, isSemver } from './catalog.js';

describe('catalog semver helpers', () => {
  it('isSemver accepts standard major.minor.patch', () => {
    expect(isSemver('0.0.0')).toBe(true);
    expect(isSemver('1.2.3')).toBe(true);
    expect(isSemver('10.20.30')).toBe(true);
  });

  it('isSemver accepts pre-release and build metadata', () => {
    expect(isSemver('1.0.0-rc.1')).toBe(true);
    expect(isSemver('1.0.0-alpha.5')).toBe(true);
    expect(isSemver('1.0.0+build.7')).toBe(true);
    expect(isSemver('1.0.0-rc.1+build.7')).toBe(true);
  });

  it('isSemver rejects non-semver shapes', () => {
    expect(isSemver('latest')).toBe(false);
    expect(isSemver('v1.0.0')).toBe(false);
    expect(isSemver('1.0')).toBe(false);
    expect(isSemver('1')).toBe(false);
    expect(isSemver('')).toBe(false);
    // Path-traversal probes — must never satisfy semver.
    expect(isSemver('..')).toBe(false);
    expect(isSemver('1.0.0/etc')).toBe(false);
  });

  it('compareSemver orders patch / minor / major', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('compareSemver ranks pre-releases below their associated normal version', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
  });

  it('compareSemver ignores build metadata for ordering', () => {
    expect(compareSemver('1.0.0+build.1', '1.0.0+build.99')).toBe(0);
  });

  it('compareSemver orders numeric pre-release identifiers numerically', () => {
    // 1.0.0-2 vs 1.0.0-10 — purely numeric, 2 < 10.
    expect(compareSemver('1.0.0-2', '1.0.0-10')).toBeLessThan(0);
  });

  it('compareSemver throws on non-semver input', () => {
    expect(() => compareSemver('latest', '1.0.0')).toThrow(/not semver/);
  });
});

describe('VideoModelLoadSchema.sigmas', () => {
  it('accepts a fixed distilled schedule and leaves it absent by default', () => {
    const schedule = [1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875];
    expect(VideoModelLoadSchema.parse({ sigmas: schedule }).sigmas).toEqual(schedule);
    expect(VideoModelLoadSchema.parse({}).sigmas).toBeUndefined();
  });

  it('rejects sigmas outside (0, 1] and an empty schedule', () => {
    expect(VideoModelLoadSchema.safeParse({ sigmas: [1.2, 0.5] }).success).toBe(false);
    expect(VideoModelLoadSchema.safeParse({ sigmas: [0.5, 0] }).success).toBe(false);
    expect(VideoModelLoadSchema.safeParse({ sigmas: [] }).success).toBe(false);
  });
});
