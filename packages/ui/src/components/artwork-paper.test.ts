import { describe, expect, it } from 'vitest';
import { paperFromEdgePixels } from './artwork-paper.js';

const SIZE = 32;

function image(pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      data.set(pixel(x, y), (y * SIZE + x) * 4);
    }
  }
  return data;
}

describe('paperFromEdgePixels', () => {
  it('returns the ground a Workshop Mark is drawn on', () => {
    const data = image(() => [233, 217, 194, 255]);
    expect(paperFromEdgePixels(data, SIZE, SIZE)).toBe('rgb(233 217 194)');
  });

  it('ignores a prop that runs off the edge', () => {
    const data = image((x, y) =>
      x > 20 && y > 16 ? [70, 60, 40, 255] : [229 + (x % 3), 212, 187 + (y % 2), 255],
    );
    const [r, g, b] = (paperFromEdgePixels(data, SIZE, SIZE)?.match(/\d+/g) ?? []).map(Number);
    expect(r).toBeGreaterThanOrEqual(229);
    expect(r).toBeLessThanOrEqual(231);
    expect(g).toBe(212);
    expect(b).toBeGreaterThanOrEqual(187);
    expect(b).toBeLessThanOrEqual(188);
  });

  it('declines a dark ground, since the card sets warm ink on its paper', () => {
    const data = image(() => [78, 55, 25, 255]);
    expect(paperFromEdgePixels(data, SIZE, SIZE)).toBeNull();
  });

  it('declines transparent artwork', () => {
    const data = image(() => [240, 230, 210, 0]);
    expect(paperFromEdgePixels(data, SIZE, SIZE)).toBeNull();
  });

  it('declines a border with no single tone', () => {
    const data = image((x, y) => {
      const step = (x + y) % 4;
      return [60 * step + 40, 200 - 50 * step, 30 + 60 * step, 255];
    });
    expect(paperFromEdgePixels(data, SIZE, SIZE)).toBeNull();
  });
});
