import { describe, expect, it } from 'vitest';
import { buildPalette, prismColors } from '../palette.js';
import { roofShades, sashBounds } from './period-details.js';

describe('period materials and proportions', () => {
  it('keeps brick warm and every roof slope in the language hue in both themes', () => {
    for (const dark of [false, true]) {
      const colors = prismColors('typescript', buildPalette(dark), undefined, {
        wall: 'brick',
        roof: 'slate',
        urbanity: 0,
      });
      const hue = (color: string) => Number(/^hsl\((\d+)/.exec(color)![1]);
      expect(hue(colors.wallL)).toBeLessThan(25);
      const roof = roofShades(colors);
      expect(hue(roof.wallL)).toBe(hue(roof.top));
      expect(hue(roof.wallR)).toBe(hue(roof.top));
      expect(roof.wallL).not.toBe(roof.top);
    }
  });

  it('keeps sash openings taller than they are wide on broad low buildings', () => {
    for (const width of [30, 90, 180]) {
      const opening = sashBounds(width, 24, 2, 3, 0, 1);
      const height = (opening.v1 - opening.v0) * 24;
      expect((opening.u1 - opening.u0) * width).toBeLessThan(height);
      expect(opening.u1).toBeGreaterThan(opening.u0);
    }
  });
});
