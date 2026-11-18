import { describe, expect, it } from 'vitest';
import { satisfiesRange } from './catalog-semver.js';

describe('satisfiesRange', () => {
  it('reads caret ranges as npm does, including below 1.0', () => {
    expect(satisfiesRange('10.39.1', '^10.39.1')).toBe(true);
    expect(satisfiesRange('10.40.0', '^10.39.1')).toBe(true);
    expect(satisfiesRange('10.39.0', '^10.39.1')).toBe(false);
    expect(satisfiesRange('11.0.0', '^10.39.1')).toBe(false);
    expect(satisfiesRange('0.3.9', '^0.3.0')).toBe(true);
    expect(satisfiesRange('0.4.0', '^0.3.0')).toBe(false);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
  });

  it('reads tilde, comparisons, conjunctions and alternatives', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('10.39.2', '>=10.39.1 <11.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfiesRange('1.0.0', '1.0.0')).toBe(true);
  });

  it('keeps pre-releases out unless the range names one', () => {
    expect(satisfiesRange('10.40.0-rc.1', '^10.39.1')).toBe(false);
    expect(satisfiesRange('10.40.0-rc.1', '>=10.40.0-rc.0')).toBe(true);
  });

  it('fails closed on shapes it does not read', () => {
    expect(() => satisfiesRange('1.0.0', '1.x')).toThrow(/unsupported/);
    expect(() => satisfiesRange('10.39.2', '>=10.39.1 <11')).toThrow(/unsupported/);
    expect(() => satisfiesRange('1.0.0', '1.0.0 - 2.0.0')).toThrow(/unsupported/);
    expect(() => satisfiesRange('1.0.0', '')).toThrow(/empty/);
  });
});
