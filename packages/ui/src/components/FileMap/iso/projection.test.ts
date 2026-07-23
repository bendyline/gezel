import { describe, expect, it } from 'vitest';
import {
  HZ,
  fitToBoundsIso,
  fromIso,
  heightOf,
  hitsPrism,
  isoAabb,
  toIso,
  townRoofRiseIso,
} from './projection.js';

describe('iso projection', () => {
  it('round-trips world ↔ iso on the ground plane', () => {
    for (const [x, y] of [
      [0, 0],
      [10, 4],
      [-3, 7.5],
      [123.4, 56.7],
    ] as const) {
      const p = toIso(x, y);
      const back = fromIso(p.u, p.v);
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
    }
  });

  it('projects a world square to a 2:1 diamond', () => {
    const box = isoAabb({ x: 0, y: 0, w: 10, h: 10 }, 0);
    expect(box.u1 - box.u0).toBe(20);
    expect(box.v1 - box.v0).toBe(10);
  });

  it('extends the iso AABB upward by the prism height', () => {
    const flat = isoAabb({ x: 0, y: 0, w: 10, h: 10 }, 0);
    const tall = isoAabb({ x: 0, y: 0, w: 10, h: 10 }, 6);
    expect(tall.v0).toBe(flat.v0 - 6);
    expect(tall.v1).toBe(flat.v1);
  });

  it('keeps period roof rise stable in screen space and caps close-zoom detail', () => {
    const rect = { x: 0, y: 0, w: 30, h: 20 };
    expect(townRoofRiseIso(rect, 1)).toBeCloseTo(5.25);
    expect(townRoofRiseIso(rect, 8) * 8).toBe(16);
    expect(townRoofRiseIso(rect, 8, true) * 8).toBe(7);
  });

  describe('hitsPrism', () => {
    const r = { x: 10, y: 10, w: 10, h: 10 };
    const hIso = heightOf(3) * HZ; // 3 storeys

    it('hits the ground footprint of a flat block', () => {
      const c = toIso(15, 15);
      expect(hitsPrism(c.u, c.v, r, 0)).toBe(true);
      const outside = toIso(30, 30);
      expect(hitsPrism(outside.u, outside.v, r, 0)).toBe(false);
    });

    it('hits the lifted top face of a tall prism', () => {
      const center = toIso(15, 15);
      // The top face center sits hIso above the ground projection.
      expect(hitsPrism(center.u, center.v - hIso, r, hIso)).toBe(true);
      // But a flat block is NOT hit up there.
      expect(hitsPrism(center.u, center.v - hIso, r, 0)).toBe(false);
    });

    it('hits the walls between ground and top (upper-floor clicks select)', () => {
      const frontCorner = toIso(20, 20); // S corner
      expect(hitsPrism(frontCorner.u, frontCorner.v - hIso / 2, r, hIso)).toBe(true);
    });

    it('misses beside the silhouette', () => {
      const beside = toIso(25, 15); // right of the footprint on the ground
      expect(hitsPrism(beside.u, beside.v, r, 0)).toBe(false);
    });
  });

  it('fitToBoundsIso contains all projected corners plus height headroom', () => {
    const bounds = { x: 0, y: 0, w: 100, h: 60 };
    const maxHIso = 12;
    const cam = fitToBoundsIso(bounds, maxHIso, 800, 600, 32);
    const box = isoAabb(bounds, maxHIso);
    for (const [u, v] of [
      [box.u0, box.v0],
      [box.u1, box.v1],
      [box.u0, box.v1],
      [box.u1, box.v0],
    ] as const) {
      const sx = (u - cam.offsetX) * cam.scale;
      const sy = (v - cam.offsetY) * cam.scale;
      expect(sx).toBeGreaterThanOrEqual(-0.001);
      expect(sx).toBeLessThanOrEqual(800.001);
      expect(sy).toBeGreaterThanOrEqual(-0.001);
      expect(sy).toBeLessThanOrEqual(600.001);
    }
  });

  it('degenerate bounds fall back to the identity camera', () => {
    expect(fitToBoundsIso({ x: 0, y: 0, w: 0, h: 10 }, 0, 800, 600)).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });
});
