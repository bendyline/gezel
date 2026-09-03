import type { FileMapResponse, MapStreet } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { buildPalette } from './palette.js';
import {
  GRADE_SPEC,
  streetGrade,
  streetPoint,
  streetSurfaceColor,
  trafficLayoutForModel,
  vehicleAlong,
} from './traffic.js';

const street = (id: string, rect: MapStreet['rect'], tier: number, grade?: number): MapStreet => ({
  id,
  rect,
  tier,
  districtId: null,
  ...(grade !== undefined ? { grade } : {}),
});

function model(streets: MapStreet[]): FileMapResponse {
  return {
    domain: 'code',
    root: '/r',
    bounds: { x: 0, y: 0, w: 200, h: 200 },
    builtAt: '2026-07-05T00:00:00Z',
    indexed: true,
    districts: [],
    blocks: [],
    buildings: [],
    roads: [],
    streets,
  };
}

describe('GRADE_SPEC', () => {
  it('walks the progression: narrow → wide → sidewalks → trolley', () => {
    expect(GRADE_SPEC).toHaveLength(8);
    // Narrow grades share one carriageway; the wide grades are wider.
    expect(GRADE_SPEC[0]!.carriageway).toBe(GRADE_SPEC[2]!.carriageway);
    expect(GRADE_SPEC[3]!.carriageway).toBeGreaterThan(GRADE_SPEC[2]!.carriageway);
    // Sidewalks arrive at 5 and stay; the trolley only at 7.
    expect(GRADE_SPEC.map((g) => g.sidewalk > 0)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(GRADE_SPEC.map((g) => g.trolley)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    // Surfaces follow the user's ladder: dirt, cobble, paved, dirt, paved…
    expect(GRADE_SPEC.map((g) => g.surface)).toEqual([
      'dirt',
      'cobble',
      'paved',
      'dirt',
      'paved',
      'paved',
      'paved',
      'paved',
    ]);
    // Only rural grades keep grass verges; a sidewalk street has none.
    for (const g of GRADE_SPEC) expect(g.verge && g.sidewalk > 0).toBe(false);
    // Carriageway plus both sidewalks never exceeds the reservation.
    for (const g of GRADE_SPEC) expect(g.carriageway + 2 * g.sidewalk).toBeLessThanOrEqual(1);
  });
});

describe('streetGrade', () => {
  it('reads the server grade and clamps it', () => {
    expect(streetGrade({ tier: 3, grade: 7 })).toBe(7);
    expect(streetGrade({ tier: 0, grade: 0 })).toBe(0);
  });

  it('falls back by tier on pre-traffic payloads, avenue widest', () => {
    const legacy = [0, 1, 2, 3].map((tier) => streetGrade({ tier }));
    expect(legacy).toEqual([5, 4, 2, 1]);
  });
});

describe('trafficLayoutForModel', () => {
  it('lays a trolley avenue out inside its reservation', () => {
    const m = model([street('ave', { x: 0, y: 10, w: 100, h: 10 }, 0, 7)]);
    const [g] = trafficLayoutForModel(m).streets;
    expect(g!.horizontal).toBe(true);
    expect(g!.length).toBe(100);
    expect(g!.center).toBe(15);
    // 72% carriageway centered, 14% sidewalks either side.
    const near = (r: MapStreet['rect'], want: MapStreet['rect']) => {
      expect(r.x).toBeCloseTo(want.x);
      expect(r.y).toBeCloseTo(want.y);
      expect(r.w).toBeCloseTo(want.w);
      expect(r.h).toBeCloseTo(want.h);
    };
    near(g!.carriageway, { x: 0, y: 15 - 3.6, w: 100, h: 7.2 });
    near(g!.sidewalks![0], { x: 0, y: 15 - 3.6 - 1.4, w: 100, h: 1.4 });
    near(g!.sidewalks![1], { x: 0, y: 15 + 3.6, w: 100, h: 1.4 });
    // Rails straddle the center line.
    expect(g!.rails).not.toBeNull();
    expect(g!.rails![0].a.y + g!.rails![1].a.y).toBeCloseTo(30);
    expect(g!.rails![0].a.x).toBe(0);
    expect(g!.rails![0].b.x).toBe(100);
    // Furniture is spaced along the street, lamps alternating sides.
    expect(g!.lamps.length).toBe(4);
    expect(g!.lamps[0]!.y).toBeLessThan(15);
    expect(g!.lamps[1]!.y).toBeGreaterThan(15);
    expect(g!.poles.length).toBe(2);
    expect(g!.trees.length).toBeGreaterThan(0);
    const kinds = new Set(g!.vehicles.map((v) => v.kind));
    expect(kinds.has('trolley')).toBe(true);
    expect(kinds.has('walker')).toBe(true);
    expect(kinds.has('cart')).toBe(true);
  });

  it('swaps axes for a vertical street and keeps a dirt track bare', () => {
    const m = model([street('lane', { x: 40, y: 0, w: 4, h: 80 }, 3, 0)]);
    const [g] = trafficLayoutForModel(m).streets;
    expect(g!.horizontal).toBe(false);
    expect(g!.center).toBe(42);
    expect(g!.carriageway.x).toBeCloseTo(42 - 1.1);
    expect(g!.carriageway.w).toBeCloseTo(2.2);
    expect(g!.carriageway.y).toBe(0);
    expect(g!.carriageway.h).toBe(80);
    expect(g!.sidewalks).toBeNull();
    expect(g!.rails).toBeNull();
    expect(g!.lamps).toEqual([]);
    expect(g!.poles).toEqual([]);
    expect(g!.trees).toEqual([]);
    expect(g!.vehicles).toEqual([]);
    expect(streetPoint(g!, 10, 1)).toEqual({ x: 43, y: 10 });
  });

  it('is memoized per payload and deterministic across payloads', () => {
    const streets = [street('ave', { x: 0, y: 10, w: 100, h: 10 }, 0, 7)];
    const a = model(streets);
    const b = model(streets);
    expect(trafficLayoutForModel(a)).toBe(trafficLayoutForModel(a));
    expect(trafficLayoutForModel(a).streets[0]!.vehicles).toEqual(
      trafficLayoutForModel(b).streets[0]!.vehicles,
    );
  });

  it('lists only streets with something moving as animated', () => {
    const m = model([
      street('ave', { x: 0, y: 10, w: 100, h: 10 }, 0, 7),
      street('lane', { x: 0, y: 40, w: 100, h: 4 }, 3, 2),
    ]);
    const layout = trafficLayoutForModel(m);
    expect(layout.streets).toHaveLength(2);
    expect(layout.animated.map((g) => g.street.id)).toEqual(['ave']);
  });
});

describe('vehicleAlong', () => {
  it('advances with the clock, wraps, and honors direction', () => {
    const m = model([street('ave', { x: 0, y: 10, w: 100, h: 10 }, 0, 7)]);
    const [g] = trafficLayoutForModel(m).streets;
    const forward = { kind: 'cart' as const, phase: 0, speed: 0.01, dir: 1 as const, cross: 0 };
    const back = { ...forward, dir: -1 as const };
    expect(vehicleAlong(g!, forward, 0)).toBe(0);
    expect(vehicleAlong(g!, forward, 1000)).toBe(10);
    expect(vehicleAlong(g!, forward, 12_000)).toBe(20);
    expect(vehicleAlong(g!, back, 1000)).toBe(90);
    for (const t of [0, 3_333, 99_999]) {
      const at = vehicleAlong(g!, forward, t);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(100);
    }
  });
});

describe('streetSurfaceColor', () => {
  it('climbs the pavement ramp with the grade', () => {
    const p = buildPalette(false);
    const at = (grade: number) =>
      streetSurfaceColor({ grade: grade as 0, spec: GRADE_SPEC[grade]! }, p);
    expect(at(0)).toBe(p.dirtLane);
    expect(at(1)).toBe(p.cobble);
    expect(at(2)).toBe(p.pavementLane);
    expect(at(3)).toBe(p.dirtLane);
    expect(at(4)).toBe(p.pavementStreet);
    expect(at(5)).toBe(p.pavementAvenue);
    expect(at(7)).toBe(p.pavementAvenue);
  });
});
