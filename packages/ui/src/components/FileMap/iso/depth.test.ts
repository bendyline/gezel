import type { Rect } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type DepthItem, depthOrder } from './depth.js';

function item(r: Rect): DepthItem {
  return { rect: r, u0: r.x - (r.y + r.h), u1: r.x + r.w - r.y };
}

/** Index of rect `i` in the painted order. */
function position(order: number[], i: number): number {
  return order.indexOf(i);
}

describe('depthOrder', () => {
  it('paints a NW block before the SE block that occludes it', () => {
    const a = item({ x: 0, y: 0, w: 10, h: 10 }); // behind
    const b = item({ x: 12, y: 12, w: 10, h: 10 }); // in front
    const order = depthOrder([b, a]);
    expect(position(order, 1)).toBeLessThan(position(order, 0));
  });

  it('orders the thin-rect configuration that defeats scalar keys', () => {
    // A long thin bar behind a small near square: center-sum would put the
    // bar (huge center) after the square even where the square is in front.
    const bar = item({ x: 0, y: 0, w: 100, h: 4 });
    const sq = item({ x: 2, y: 6, w: 8, h: 8 });
    // bar.y + bar.h (4) <= sq.y (6) → bar behind sq, regardless of key sums.
    const order = depthOrder([sq, bar]);
    expect(position(order, 1)).toBeLessThan(position(order, 0));

    // And mirrored on the x axis.
    const bar2 = item({ x: 0, y: 0, w: 4, h: 100 });
    const sq2 = item({ x: 6, y: 2, w: 8, h: 8 });
    const order2 = depthOrder([sq2, bar2]);
    expect(position(order2, 1)).toBeLessThan(position(order2, 0));
  });

  it('is deterministic across input orderings (same painted sequence of rects)', () => {
    const rects: Rect[] = [];
    let seedState = 42;
    const rand = () => {
      seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
      return seedState / 0x7fffffff;
    };
    for (let i = 0; i < 40; i++) {
      rects.push({
        x: Math.floor(rand() * 200),
        y: Math.floor(rand() * 200),
        w: 4 + Math.floor(rand() * 20),
        h: 4 + Math.floor(rand() * 20),
      });
    }
    const items = rects.map(item);
    const orderA = depthOrder(items).map((i) => JSON.stringify(rects[i]));
    const reversed = [...items].reverse();
    const orderB = depthOrder(reversed).map((i) => JSON.stringify(rects[rects.length - 1 - i]));
    expect(orderB).toEqual(orderA);
  });

  it('respects the behind-relation for every ordered overlapping pair', () => {
    const rects: Rect[] = [];
    for (let gx = 0; gx < 5; gx++) {
      for (let gy = 0; gy < 5; gy++) {
        rects.push({ x: gx * 14, y: gy * 14, w: 10 + (gx % 3), h: 10 + (gy % 2) });
      }
    }
    const items = rects.map(item);
    const order = depthOrder(items);
    const pos = new Map(order.map((idx, at) => [idx, at]));
    for (let i = 0; i < rects.length; i++) {
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const a = rects[i]!;
        const b = rects[j]!;
        const uOverlap = items[i]!.u0 < items[j]!.u1 && items[j]!.u0 < items[i]!.u1;
        if (!uOverlap) continue;
        const aBehindB = a.x + a.w <= b.x + 0.01 || a.y + a.h <= b.y + 0.01;
        const bBehindA = b.x + b.w <= a.x + 0.01 || b.y + b.h <= a.y + 0.01;
        if (aBehindB && !bBehindA) {
          expect(pos.get(i)!).toBeLessThan(pos.get(j)!);
        }
      }
    }
  });

  it('terminates on degenerate identical rects', () => {
    const same = { x: 0, y: 0, w: 10, h: 10 };
    const order = depthOrder([item(same), item(same), item(same)]);
    expect(order.length).toBe(3);
    expect(new Set(order).size).toBe(3);
  });

  it('handles empty and single inputs', () => {
    expect(depthOrder([])).toEqual([]);
    expect(depthOrder([item({ x: 0, y: 0, w: 5, h: 5 })])).toEqual([0]);
  });
});
