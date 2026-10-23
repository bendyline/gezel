import { describe, expect, it } from 'vitest';
import { type RgbaPixels, imageStats, sanityFlags } from './sanity.ts';

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): RgbaPixels {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/** A smooth two-tone gradient with a soft disc: an ordinary, unremarkable render. */
const ordinary = image(64, 64, (x, y) => {
  const d = Math.hypot(x - 32, y - 32);
  const v = d < 16 ? 180 : 60 + x;
  return [v, Math.round(v * 0.8), Math.round(v * 0.6)];
});

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe('sanityFlags', () => {
  it('passes an ordinary image', () => {
    expect(sanityFlags(imageStats(ordinary), { width: 64, height: 64 })).toEqual([]);
  });

  it('flags a black frame and a flat one', () => {
    expect(sanityFlags(imageStats(image(32, 32, () => [0, 0, 0])))).toEqual(['black']);
    expect(sanityFlags(imageStats(image(32, 32, () => [128, 128, 128])))).toEqual(['blank']);
  });

  it('flags leftover sampling noise', () => {
    const noise = image(64, 64, () => {
      const v = Math.round(rand() * 255);
      return [v, v, v];
    });
    expect(sanityFlags(imageStats(noise))).toContain('noisy');
  });

  it('flags a burned frame but not a saturated subject on a neutral ground', () => {
    const burned = image(64, 64, (x) => (x % 2 ? [255, 0, 40] : [0, 255, 255]));
    expect(sanityFlags(imageStats(burned))).toContain('burned');
    const apple = image(64, 64, (x, y) =>
      Math.hypot(x - 32, y - 32) < 14 ? [255, 10, 20] : [120, 110, 100],
    );
    expect(sanityFlags(imageStats(apple))).not.toContain('burned');
  });

  it('reports the size it was asked for and not another', () => {
    expect(sanityFlags(imageStats(ordinary), { width: 64, height: 32 })).toEqual(['wrong-size']);
  });

  it('measures a full-height column seam without flagging it', () => {
    const seam = image(64, 64, (x, y) => {
      const v = 100 + ((x * 3 + y * 2) % 8) + (x === 31 ? 40 : 0);
      return [v, v, v];
    });
    const stats = imageStats(seam);
    expect(stats.seamColumns).toBeGreaterThan(0);
    expect(stats.seamRows).toBe(0);
    expect(sanityFlags(stats)).toEqual([]);
  });
});
