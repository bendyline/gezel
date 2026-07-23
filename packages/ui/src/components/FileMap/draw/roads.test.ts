import { describe, expect, it } from 'vitest';
import { routeRoad } from './roads.js';

describe('routeRoad (Manhattan L-routing)', () => {
  it('routes horizontal-first when horizontal separation dominates', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 50, y: 30, w: 10, h: 10 };
    const pts = routeRoad(a, b);
    expect(pts).toEqual([
      { x: 10, y: 5 }, // leaves a's right edge
      { x: 55, y: 5 }, // bend above b
      { x: 55, y: 30 }, // arrives at b's top edge
    ]);
  });

  it('routes vertical-first when vertical separation dominates', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 10, y: 60, w: 10, h: 10 };
    const pts = routeRoad(a, b);
    expect(pts).toEqual([
      { x: 5, y: 10 }, // leaves a's bottom edge
      { x: 5, y: 65 }, // bend left of b
      { x: 10, y: 65 }, // arrives at b's left edge
    ]);
  });

  it('degenerates to a straight segment when centers are axis-aligned', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 40, y: 0, w: 10, h: 10 };
    expect(routeRoad(a, b)).toEqual([
      { x: 5, y: 5 },
      { x: 45, y: 5 },
    ]);
  });

  it('is symmetric in shape when reversed (same corner column/row)', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 50, y: 30, w: 10, h: 10 };
    const fwd = routeRoad(a, b);
    const rev = routeRoad(b, a);
    expect(fwd).toHaveLength(3);
    expect(rev).toHaveLength(3);
    // both bends happen at a right angle
    expect(fwd[0]!.y).toBe(fwd[1]!.y);
    expect(fwd[1]!.x).toBe(fwd[2]!.x);
    expect(rev[0]!.y).toBe(rev[1]!.y);
    expect(rev[1]!.x).toBe(rev[2]!.x);
  });
});
