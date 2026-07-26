import { describe, expect, it } from 'vitest';
import { MATERIAL_KEYS, mixHue } from './material.js';
import { buildPalette, prismColors, roofColors, roofHue } from './palette.js';

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

describe('material treatment', () => {
  it('emits integer HSL components in the exact shape the renderer parses', () => {
    // palette.test's own `lightness()` regex rejects decimals, and the
    // DiamondBatcher buckets on the raw string — a stray `50.0000001%` would
    // both throw here and silently double a color bucket.
    for (const dark of [true, false]) {
      const p = buildPalette(dark);
      for (const wall of MATERIAL_KEYS) {
        for (const roof of MATERIAL_KEYS) {
          for (const u of [0, 0.37, 1]) {
            const c = prismColors('typescript', p, undefined, { wall, roof, urbanity: u });
            for (const v of [c.top, c.wallL, c.wallR, c.edge]) {
              expect(v, `${wall}/${roof}@${u}`).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
            }
          }
        }
      }
    }
  });

  it('preserves the roof/facade lightness delta for every material pair', () => {
    // The delta is the entire 3D reading. It survives by construction because a
    // material is a shift, never a compression: the same litDelta lands on roof
    // and facade. This test is what keeps that property true.
    for (const dark of [true, false]) {
      const p = buildPalette(dark);
      for (const wall of MATERIAL_KEYS) {
        for (const roof of MATERIAL_KEYS) {
          for (const lang of ['typescript', 'python', 'rust', 'zig']) {
            const c = prismColors(lang, p, undefined, { wall, roof, urbanity: 0.5 });
            expect(
              lightness(c.top) - lightness(c.wallL),
              `${lang} ${wall}/${roof} in ${dark ? 'dark' : 'light'}`,
            ).toBeGreaterThanOrEqual(8);
            // And the two walls stay separated, or the prism reads flat.
            expect(lightness(c.wallL) - lightness(c.wallR)).toBeGreaterThanOrEqual(4);
          }
        }
      }
    }
  });

  it('keeps the language hue on the roof at every urbanity', () => {
    // Moving hue off the roof would kill the language field exactly where the
    // map is densest, since the top diamond is most of what a building shows.
    const p = buildPalette(false);
    const hueOf = (s: string) => Number(/^hsl\((\d+)/.exec(s)![1]);
    for (const u of [0, 0.5, 1]) {
      const ts = prismColors('typescript', p, undefined, {
        wall: 'brick',
        roof: 'slate',
        urbanity: u,
      });
      const py = prismColors('python', p, undefined, { wall: 'brick', roof: 'slate', urbanity: u });
      expect(Math.abs(hueOf(ts.top) - hueOf(py.top))).toBeGreaterThan(20);
    }
  });

  it('pulls walls further off the language hue as the ground gets urban', () => {
    const p = buildPalette(false);
    const hueOf = (s: string) => Number(/^hsl\((\d+)/.exec(s)![1]);
    const langHue = roofHue('typescript');
    const rural = prismColors('typescript', p, undefined, {
      wall: 'stone',
      roof: 'tile',
      urbanity: 0,
    });
    const urban = prismColors('typescript', p, undefined, {
      wall: 'stone',
      roof: 'tile',
      urbanity: 1,
    });
    expect(Math.abs(hueOf(urban.wallL) - langHue)).toBeGreaterThan(
      Math.abs(hueOf(rural.wallL) - langHue),
    );
  });

  it('the age lens overrides material entirely', () => {
    // One clean surface per file under the lens, or its recency signal competes
    // with nine material treatments.
    const p = buildPalette(true);
    for (const age of [0, 1, 2, 3] as const) {
      const plain = prismColors('typescript', p, age);
      const withMaterial = prismColors('typescript', p, age, {
        wall: 'iron',
        roof: 'glass',
        urbanity: 1,
      });
      expect(withMaterial).toEqual(plain);
    }
  });

  it('omitting the material reproduces the pre-material colors exactly', () => {
    // Legacy payloads and the city-tier batcher both take this path.
    for (const dark of [true, false]) {
      const p = buildPalette(dark);
      for (const lang of ['typescript', 'go', null]) {
        expect(prismColors(lang, p, undefined, undefined)).toEqual(prismColors(lang, p));
      }
    }
  });
});

describe('palette theme parity', () => {
  it('light and dark define exactly the same keys', () => {
    const light = Object.keys(buildPalette(false)).sort();
    const dark = Object.keys(buildPalette(true)).sort();
    expect(light).toEqual(dark);
  });

  it('every key has a value', () => {
    for (const dark of [true, false]) {
      for (const [k, v] of Object.entries(buildPalette(dark))) {
        expect(v, `${k} in ${dark ? 'dark' : 'light'}`).toBeDefined();
      }
    }
  });
});

describe('mixHue', () => {
  it('takes the shortest arc across the 0/360 seam', () => {
    expect(mixHue(350, 10, 0.5)).toBe(0);
    expect(mixHue(10, 350, 0.5)).toBe(0);
    expect(mixHue(0, 180, 0.5)).toBeGreaterThanOrEqual(0);
  });

  it('always lands in [0, 360)', () => {
    for (const from of [0, 45, 180, 300, 359]) {
      for (const to of [0, 90, 200, 359]) {
        for (const t of [0, 0.3, 1]) {
          const h = mixHue(from, to, t);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThan(360);
        }
      }
    }
  });
});
