import type { CityAnchor, CityOverride, CompassRegion } from '../schemas/city-file.js';
import type { PriorNode } from './types.js';

/**
 * Compass-region macro placement. Top-level display districts land in a 3×3
 * grid (NW..SE); the region each district occupies is recorded to the city
 * file at first seed and honored by every later re-seed — so a layout
 * algorithm change or an index rebuild never moves `packages/` away from
 * where the user remembers it.
 */

export const REGION_GRID: readonly (readonly CompassRegion[])[] = [
  ['NW', 'N', 'NE'],
  ['W', 'C', 'E'],
  ['SW', 'S', 'SE'],
] as const;

/** Region containing a normalized centroid. */
export function regionOf(cx: number, cy: number): CompassRegion {
  const cell = (v: number): number => (v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2);
  return REGION_GRID[cell(cy)]![cell(cx)]!;
}

export function regionCell(region: CompassRegion): { row: number; col: number } {
  for (let row = 0; row < 3; row++) {
    const col = REGION_GRID[row]!.indexOf(region);
    if (col >= 0) return { row, col };
  }
  return { row: 1, col: 1 };
}

/** Deterministic NW→SE processing order for capacity balancing. */
const REGION_ORDER: readonly CompassRegion[] = ['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'];

function topSegment(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(0, i);
}

/**
 * Derive anchors from a PRIOR layout's block rects — the v4→v5 migration
 * path: before a version bump discards the old geometry, remember which
 * compass region each top-level folder's centroid occupied so the re-seed
 * preserves the user's mental map.
 */
export function deriveAnchorsFromPrior(
  priorBlocks: readonly PriorNode[],
  nowIso: string,
): CityAnchor[] {
  const blocks = priorBlocks.filter((p) => p.nodeKind === 'block');
  if (blocks.length === 0) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of blocks) {
    minX = Math.min(minX, b.rect.x);
    minY = Math.min(minY, b.rect.y);
    maxX = Math.max(maxX, b.rect.x + b.rect.w);
    maxY = Math.max(maxY, b.rect.y + b.rect.h);
  }
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);

  interface Acc {
    sumX: number;
    sumY: number;
    n: number;
  }
  const groups = new Map<string, Acc>();
  for (const b of blocks) {
    if (!b.nodeId.includes('/')) continue; // root-level file: no top folder
    const top = topSegment(b.nodeId);
    const acc = groups.get(top) ?? { sumX: 0, sumY: 0, n: 0 };
    acc.sumX += b.rect.x + b.rect.w / 2;
    acc.sumY += b.rect.y + b.rect.h / 2;
    acc.n += 1;
    groups.set(top, acc);
  }
  const out: CityAnchor[] = [];
  for (const [path, acc] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const cx = Math.min(1, Math.max(0, (acc.sumX / acc.n - minX) / w));
    const cy = Math.min(1, Math.max(0, (acc.sumY / acc.n - minY) / h));
    out.push({ path, region: regionOf(cx, cy), cx, cy, recordedAt: nowIso });
  }
  return out;
}

/**
 * Assign a compass region to each top-level item. Priority per item:
 * override.region (exact-path match) → anchor.region → deterministic
 * capacity balancing (largest first into the least-loaded region, ties in
 * NW→SE order).
 */
export function assignRegions(
  items: ReadonlyArray<{ path: string; area: number }>,
  anchors: readonly CityAnchor[],
  overrides: readonly CityOverride[],
): Map<string, CompassRegion> {
  const out = new Map<string, CompassRegion>();
  const load = new Map<CompassRegion, number>();
  for (const r of REGION_ORDER) load.set(r, 0);
  const anchorByPath = new Map(anchors.map((a) => [a.path, a.region]));
  const overrideByPath = new Map(
    overrides.filter((o) => o.region && !o.rect).map((o) => [o.path, o.region!]),
  );

  const unassigned: Array<{ path: string; area: number }> = [];
  for (const it of items) {
    const region = overrideByPath.get(it.path) ?? anchorByPath.get(it.path);
    if (region) {
      out.set(it.path, region);
      load.set(region, (load.get(region) ?? 0) + it.area);
    } else {
      unassigned.push(it);
    }
  }
  unassigned.sort((a, b) => b.area - a.area || (a.path < b.path ? -1 : 1));
  for (const it of unassigned) {
    let best: CompassRegion = 'C';
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const r of REGION_ORDER) {
      const l = load.get(r)!;
      if (l < bestLoad) {
        bestLoad = l;
        best = r;
      }
    }
    out.set(it.path, best);
    load.set(best, bestLoad + it.area);
  }
  return out;
}
