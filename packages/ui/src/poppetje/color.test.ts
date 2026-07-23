import { HAT_FELTS, PALETTE } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { feltForSkin, mixHex, rgbDistance } from './color.js';

describe('mixHex', () => {
  it('mixes colors and clamps the requested amount', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#123456', '#ffffff', -1)).toBe('#123456');
    expect(mixHex('#123456', '#ffffff', 2)).toBe('#ffffff');
  });

  it('preserves custom non-hex paints', () => {
    expect(mixHex('var(--custom-paint)', '#ffffff', 0.25)).toBe('var(--custom-paint)');
  });
});

describe('rgbDistance', () => {
  it('measures hex colors', () => {
    expect(rgbDistance('#000000', '#000000')).toBe(0);
    expect(rgbDistance('#000000', '#ffffff')).toBeCloseTo(Math.hypot(255, 255, 255));
  });

  it('returns Infinity for non-hex input', () => {
    expect(rgbDistance('tomato', '#000000')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('feltForSkin', () => {
  it('keeps every pick clear of every catalog skin pair', () => {
    // A hat felt too close to the wearer's skin makes the figure read as
    // bald — the wearer-aware walk must hold the 50-distance floor for any
    // start index and any skin in the catalog.
    for (const { skin, skin2 } of PALETTE.skins) {
      for (let start = 0; start < HAT_FELTS.length * 2; start++) {
        const felt = feltForSkin(start, skin, skin2);
        const d = Math.min(rgbDistance(felt.felt, skin), rgbDistance(felt.felt, skin2));
        expect(
          d,
          `felt ${felt.felt} vs skin ${skin}/${skin2} (start ${start})`,
        ).toBeGreaterThanOrEqual(50);
      }
    }
  });

  it('is deterministic and varies with the start index', () => {
    const [s] = PALETTE.skins;
    const picks = new Set<string>();
    for (let start = 0; start < HAT_FELTS.length; start++) {
      const a = feltForSkin(start, s!.skin, s!.skin2);
      expect(feltForSkin(start, s!.skin, s!.skin2)).toBe(a);
      picks.add(a.felt);
    }
    // Pale skin accepts most felts, so different starts spread across the palette.
    expect(picks.size).toBeGreaterThan(3);
  });

  it('accepts the first felt for unparseable custom skins', () => {
    expect(feltForSkin(2, 'tomato', 'salmon')).toBe(HAT_FELTS[2]);
  });
});
