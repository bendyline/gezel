import type { FileMapResponse, MapBlock, MapStreet, Rect } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { routedRoadsFor } from './roads-router.js';

// A little 2×2 grid of blocks with an avenue between the columns, a street
// between the rows, and the perimeter — enough for the router to turn a corner.
//
//   b00   |avenue|   b01
//   ---- street ---------
//   b10   |avenue|   b11
const block = (id: string, r: Rect): MapBlock => ({
  id,
  districtId: 'root',
  rect: r,
  label: id,
  weight: 100,
  state: 'live',
  buildingCount: 0,
});

const street = (rect: Rect, tier: number): MapStreet => ({
  id: `st:${rect.x},${rect.y}`,
  rect,
  tier,
  districtId: null,
});

function model(withStreets: boolean): FileMapResponse {
  return {
    domain: 'code',
    root: '/r',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    builtAt: '2026-07-05T00:00:00Z',
    indexed: true,
    districts: [],
    blocks: [
      block('b00', { x: 0, y: 0, w: 30, h: 30 }),
      block('b01', { x: 60, y: 0, w: 30, h: 30 }),
      block('b10', { x: 0, y: 60, w: 30, h: 30 }),
      block('b11', { x: 60, y: 60, w: 30, h: 30 }),
    ],
    buildings: [],
    roads: [
      { a: 'b00', b: 'b11', affinity: 1, source: 'import', bidirectional: false },
      { a: 'b01', b: 'b10', affinity: 1, source: 'import', bidirectional: true },
    ],
    ...(withStreets
      ? {
          streets: [
            street({ x: 32, y: 0, w: 26, h: 90 }, 0), // vertical avenue between columns
            street({ x: 0, y: 32, w: 90, h: 26 }, 1), // horizontal street between rows
          ],
        }
      : {}),
  };
}

const rectById = (m: FileMapResponse): Map<string, Rect> =>
  new Map(m.blocks.map((b) => [b.id, b.rect]));

describe('routedRoadsFor', () => {
  it('returns null when the map has no street geometry (old payloads)', () => {
    const m = model(false);
    expect(routedRoadsFor(m, 'b00', rectById(m))).toBeNull();
  });

  it('routes the selected block’s incident roads as axis-aligned polylines', () => {
    const m = model(true);
    const routed = routedRoadsFor(m, 'b00', rectById(m));
    expect(routed).not.toBeNull();
    expect(routed!.length).toBe(1); // b00 ↔ b11
    const pts = routed![0]!.points;
    expect(pts.length).toBeGreaterThanOrEqual(3); // a genuine corner, not a straight cut
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const axisAligned = Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
      expect(axisAligned, `segment ${i} is diagonal`).toBe(true);
    }
  });

  it('keeps the routed path off the buildings it passes between', () => {
    const m = model(true);
    const routed = routedRoadsFor(m, 'b01', rectById(m))!;
    const pts = routed[0]!.points;
    // the intermediate waypoints (everything but the two block-edge spurs)
    // should sit in the street channels, not inside b00/b11
    const others: Rect[] = [
      { x: 0, y: 0, w: 30, h: 30 },
      { x: 60, y: 60, w: 30, h: 30 },
    ];
    for (const p of pts.slice(1, -1)) {
      for (const o of others) {
        const inside = p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h;
        expect(inside, `waypoint ${JSON.stringify(p)} is inside a building`).toBe(false);
      }
    }
  });

  it('memoizes per selection (stable object identity across calls)', () => {
    const m = model(true);
    const rb = rectById(m);
    expect(routedRoadsFor(m, 'b00', rb)).toBe(routedRoadsFor(m, 'b00', rb));
  });

  it('bridges the gap between a district lane and its avenue', () => {
    // Two folders each with a horizontal internal lane, a vertical avenue
    // between them, and a padding gap between each lane's end and the avenue —
    // the disconnection the bridge pass stitches back together.
    const m: FileMapResponse = {
      domain: 'code',
      root: '/r',
      bounds: { x: 0, y: 0, w: 90, h: 60 },
      builtAt: '2026-07-05T00:00:00Z',
      indexed: true,
      districts: [],
      blocks: [
        block('left/a.ts', { x: 0, y: 0, w: 20, h: 18 }),
        block('right/d.ts', { x: 60, y: 0, w: 20, h: 18 }),
      ],
      buildings: [],
      roads: [
        { a: 'left/a.ts', b: 'right/d.ts', affinity: 1, source: 'import', bidirectional: false },
      ],
      streets: [
        street({ x: 0, y: 22, w: 30, h: 5 }, 3), // left lane, ends at x=30
        street({ x: 50, y: 22, w: 30, h: 5 }, 3), // right lane, starts at x=50
        street({ x: 38, y: 0, w: 5, h: 60 }, 0), // avenue at x≈40, gap ~10 to each lane
      ],
      overlay: undefined,
    };
    const routed = routedRoadsFor(m, 'left/a.ts', rectById(m));
    expect(routed).not.toBeNull();
    const pts = routed![0]!.points;
    // The path runs along the shared lane/avenue channel (y≈24.5), not a
    // straight diagonal from block to block.
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(pts.some((p) => Math.abs(p.y - 24.5) < 4)).toBe(true);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
    }
  });
});
