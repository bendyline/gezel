import { describe, expect, it } from 'vitest';
import {
  type UrbanityInput,
  adoptDowntown,
  computeUrbanity,
  settlementFor,
  sizeCeiling,
} from './urbanity.js';

const NOW = '2026-07-25T00:00:00.000Z';

function block(path: string, x: number, y: number, importance = 0, side = 24): UrbanityInput {
  return {
    path,
    lot: { x, y, w: side, h: side },
    footprint: { x: x + 2, y: y + 2, w: side - 4, h: side - 4 },
    importance,
  };
}

/** A `cols × rows` grid of parcels on a `step` pitch, centered on the origin. */
function grid(
  cols: number,
  rows: number,
  step = 40,
  importanceAt?: (c: number, r: number) => number,
) {
  const out: UrbanityInput[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(
        block(`f/${r}/${c}.ts`, c * step, r * step, importanceAt ? importanceAt(c, r) : 0, 24),
      );
    }
  }
  return out;
}

describe('settlementFor', () => {
  it('is monotone and puts exact thresholds in the upper band', () => {
    expect(settlementFor(0)).toBe('hamlet');
    expect(settlementFor(0.29)).toBe('hamlet');
    expect(settlementFor(0.3)).toBe('village');
    expect(settlementFor(0.51)).toBe('village');
    expect(settlementFor(0.52)).toBe('town');
    expect(settlementFor(0.73)).toBe('town');
    expect(settlementFor(0.74)).toBe('city');
    expect(settlementFor(1)).toBe('city');
  });
});

describe('sizeCeiling', () => {
  it('caps small projects at a rural register and lets big ones reach city', () => {
    expect(sizeCeiling(40)).toBeLessThan(0.52); // can't leave the village band
    expect(sizeCeiling(1200)).toBeGreaterThan(0.74); // a city core is reachable
    expect(sizeCeiling(4000)).toBeCloseTo(1, 5);
    expect(sizeCeiling(100_000)).toBe(1);
  });

  it('is monotone non-decreasing', () => {
    let prev = 0;
    for (const n of [0, 1, 10, 24, 60, 200, 900, 4000, 9000]) {
      const c = sizeCeiling(n);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe('computeUrbanity', () => {
  it('pulls the downtown toward the high-importance side', () => {
    // Uniform geometry; importance concentrated on the left column only.
    const items = grid(6, 6, 40, (c) => (c === 0 ? 1 : 0));
    const geometricCx = (5 * 40) / 2 + 12;
    const field = computeUrbanity(items, { hasEdges: true, now: NOW });
    expect(field.downtown.cx).toBeLessThan(geometricCx);
  });

  it('falls off with distance from the downtown', () => {
    const items = grid(9, 9, 40);
    const field = computeUrbanity(items, { hasEdges: true, now: NOW });
    const center = field.byPath.get('f/4/4.ts')!;
    const edge = field.byPath.get('f/4/8.ts')!;
    const corner = field.byPath.get('f/8/8.ts')!;
    expect(center).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(corner);
  });

  it('caps a small project below the city band even when maximally dense', () => {
    // 40 tightly packed, maximally important blocks — the best case for a
    // small repo. It must still read rural.
    const items = grid(8, 5, 26, () => 1);
    const field = computeUrbanity(items, { hasEdges: true, now: NOW });
    expect(field.peak).toBeLessThan(0.52);
    for (const u of field.byPath.values()) expect(settlementFor(u)).not.toBe('city');
  });

  it('gives a large project a city core and a village rim', () => {
    const items = grid(64, 64, 30, () => 0.5);
    const field = computeUrbanity(items, { hasEdges: true, now: NOW });
    expect(settlementFor(field.byPath.get('f/32/32.ts')!)).toBe('city');
    const rim = settlementFor(field.byPath.get('f/0/0.ts')!);
    expect(rim === 'village' || rim === 'hamlet').toBe(true);
    expect(field.fileCount).toBe(64 * 64);
  });

  it('is deterministic and independent of input order', () => {
    const items = grid(12, 12, 40, (c, r) => ((c * 7 + r * 3) % 11) / 10);
    const a = computeUrbanity(items, { hasEdges: true, now: NOW });
    const shuffled = [...items].reverse();
    const b = computeUrbanity(shuffled, { hasEdges: true, now: NOW });
    expect([...a.byPath.entries()].sort()).toEqual([...b.byPath.entries()].sort());
    expect(a.downtown).toEqual(b.downtown);
  });

  it('does not systematically dim a project with no import graph', () => {
    const items = grid(24, 24, 40);
    const withEdges = computeUrbanity(
      grid(24, 24, 40, () => 0.5),
      { hasEdges: true, now: NOW },
    );
    const without = computeUrbanity(items, { hasEdges: false, now: NOW });
    // The graph-less map's core must land in the same band, not a step down.
    expect(settlementFor(without.peak)).toBe(settlementFor(withEdges.peak));
  });

  it('survives degenerate maps without producing NaN', () => {
    for (const items of [
      [] as UrbanityInput[],
      [block('only.ts', 0, 0)],
      [block('a.ts', 5, 5), block('b.ts', 5, 5), block('c.ts', 5, 5)],
    ]) {
      const field = computeUrbanity(items, { hasEdges: false, now: NOW });
      expect(Number.isFinite(field.downtown.cx)).toBe(true);
      expect(Number.isFinite(field.downtown.cy)).toBe(true);
      expect(field.downtown.r).toBeGreaterThan(0);
      expect(Number.isFinite(field.peak)).toBe(true);
      for (const u of field.byPath.values()) {
        expect(Number.isFinite(u)).toBe(true);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never leaves a live block without a value', () => {
    const items = grid(10, 10, 40);
    const field = computeUrbanity(items, { hasEdges: true, now: NOW });
    for (const it of items) expect(field.byPath.has(it.path)).toBe(true);
    expect(field.byPath.size).toBe(items.length);
  });
});

describe('adoptDowntown', () => {
  const prior = { cx: 100, cy: 100, r: 200, impRef: 0.4, recordedAt: '2026-01-01T00:00:00.000Z' };

  it('keeps the prior verbatim when nothing meaningful moved', () => {
    const fresh = { cx: 100.4, cy: 99.7, r: 203, impRef: 0.41, recordedAt: NOW };
    expect(adoptDowntown(prior, fresh, 1600)).toBe(prior);
  });

  it('adopts when the center moves far', () => {
    const fresh = { cx: 600, cy: 100, r: 200, impRef: 0.4, recordedAt: NOW };
    expect(adoptDowntown(prior, fresh, 1600)).toBe(fresh);
  });

  it('adopts when the radius grows past the tolerance', () => {
    const fresh = { cx: 100, cy: 100, r: 260, impRef: 0.4, recordedAt: NOW };
    expect(adoptDowntown(prior, fresh, 1600)).toBe(fresh);
  });

  it('adopts when the importance reference shifts', () => {
    const fresh = { cx: 100, cy: 100, r: 200, impRef: 0.9, recordedAt: NOW };
    expect(adoptDowntown(prior, fresh, 1600)).toBe(fresh);
  });

  it('adopts as a unit — never a stale center with a fresh radius', () => {
    const fresh = { cx: 600, cy: 100, r: 260, impRef: 0.9, recordedAt: NOW };
    const got = adoptDowntown(prior, fresh, 1600);
    expect(got).toEqual(fresh);
    const kept = adoptDowntown(prior, { ...prior, recordedAt: NOW }, 1600);
    expect(kept).toEqual(prior);
  });

  it('takes the fresh value when there is no prior', () => {
    const fresh = { cx: 1, cy: 2, r: 3, impRef: 0.1, recordedAt: NOW };
    expect(adoptDowntown(null, fresh, 1600)).toBe(fresh);
    expect(adoptDowntown(undefined, fresh, 1600)).toBe(fresh);
  });

  it('adding one block to a settled map does not re-adopt', () => {
    const items = grid(20, 20, 40, (c, r) => ((c + r) % 5) / 4);
    const first = computeUrbanity(items, { hasEdges: true, now: NOW });
    const grown = computeUrbanity([...items, block('f/20/0.ts', 0, 20 * 40, 0.2)], {
      hasEdges: true,
      prior: first.downtown,
      now: '2026-07-26T00:00:00.000Z',
    });
    expect(grown.downtown).toBe(first.downtown);
  });

  it('growth does not flip an existing block out of its settlement band', () => {
    const items = grid(20, 20, 40, (c, r) => ((c + r) % 5) / 4);
    const first = computeUrbanity(items, { hasEdges: true, now: NOW });
    const grown = computeUrbanity([...items, block('f/20/0.ts', 0, 20 * 40, 0.2)], {
      hasEdges: true,
      prior: first.downtown,
      now: NOW,
    });
    for (const [path, before] of first.byPath) {
      expect(settlementFor(grown.byPath.get(path)!)).toBe(settlementFor(before));
    }
  });
});
