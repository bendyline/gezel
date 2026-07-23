import { describe, expect, it } from 'vitest';
import { buildPalette, roofColors, roofHue } from './palette.js';

function lightness(hsl: string): number {
  const m = /hsl\(\d+ \d+% (\d+)%\)/.exec(hsl);
  if (!m) throw new Error(`not an hsl() string: ${hsl}`);
  return Number(m[1]);
}

describe('roofHue', () => {
  it('pins the dominant languages to curated hues', () => {
    expect(roofHue('typescript')).toBe(210);
    expect(roofHue('TypeScript')).toBe(210);
    expect(roofHue('javascript')).toBe(48);
    expect(roofHue('python')).toBe(160);
    expect(roofHue('rust')).toBe(20);
  });

  it('quantizes long-tail languages to 12 slots', () => {
    for (const lang of ['zig', 'haskell', 'kotlin', 'perl', 'lua']) {
      const h = roofHue(lang);
      expect(h % 30).toBe(0);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe('roofColors', () => {
  // The 3D reading depends on the facade being clearly darker than the roof.
  it('keeps roof/facade lightness delta >= 12 in both themes', () => {
    for (const dark of [true, false]) {
      const p = buildPalette(dark);
      for (const lang of ['typescript', 'javascript', 'python', 'rust', 'zig', null]) {
        const c = roofColors(lang, p);
        expect(lightness(c.roof) - lightness(c.facade)).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('keeps the delta under the age lens too', () => {
    for (const dark of [true, false]) {
      const p = buildPalette(dark);
      for (const age of [0, 1, 2, 3] as const) {
        const c = roofColors('typescript', p, age);
        expect(c.roof).toContain('hsl(28');
        expect(lightness(c.roof) - lightness(c.facade)).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it('is stable for the same language', () => {
    const p = buildPalette(true);
    expect(roofColors('go', p)).toEqual(roofColors('go', p));
  });
});
