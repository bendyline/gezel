import { describe, expect, it } from 'vitest';
import { GEZEL_CHAT_FONTS, resolveGezelFontFamily, resolveGezelFontScale } from './fonts.js';

describe('resolveGezelFontFamily', () => {
  it('maps a known id to its CSS family', () => {
    expect(resolveGezelFontFamily('jetbrains-mono')).toBe(`'JetBrains Mono'`);
  });
  it('returns undefined for unset / unknown ids', () => {
    expect(resolveGezelFontFamily(undefined)).toBeUndefined();
    expect(resolveGezelFontFamily(null)).toBeUndefined();
    expect(resolveGezelFontFamily('not-a-font')).toBeUndefined();
  });
});

describe('resolveGezelFontScale', () => {
  it('returns the declared scale for a font that sets one', () => {
    // JetBrains Mono renders large, so it ships a 0.9 down-scale.
    expect(resolveGezelFontScale('jetbrains-mono')).toBe(0.9);
  });

  it('defaults to 1 for fonts without a scale, and for unset / unknown ids', () => {
    expect(resolveGezelFontScale('pt-serif')).toBe(1);
    expect(resolveGezelFontScale('inter')).toBe(1);
    expect(resolveGezelFontScale(undefined)).toBe(1);
    expect(resolveGezelFontScale(null)).toBe(1);
    expect(resolveGezelFontScale('not-a-font')).toBe(1);
  });

  it('every declared scale is a positive factor near 1 (sanity bound)', () => {
    for (const f of GEZEL_CHAT_FONTS) {
      const scale = 'scale' in f ? f.scale : 1;
      expect(scale).toBeGreaterThan(0.5);
      expect(scale).toBeLessThanOrEqual(1.5);
    }
  });
});
