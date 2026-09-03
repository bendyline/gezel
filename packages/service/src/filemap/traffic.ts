import type {
  MapDistrict,
  MapRoad,
  MapStreet,
  Rect,
  Settlement,
  StreetGrade,
} from '@bendyline/gezel';
import { settlementFor } from './urbanity.js';

/**
 * Street traffic policy for the Village: how busy each street is, and the
 * road it would therefore have been built into by 1910.
 *
 * Streets are grid-placed gaps the packer leaves between parcels and folders,
 * so no street "is" an import edge. What a street can honestly show is how
 * much traffic passes its frontage, and that is estimated from two sources:
 *
 * - **Frontage.** Every parcel fronting the street contributes its import
 *   degree (roads in + roads out). A lane between two rows of leaf files
 *   carries a trickle; the lane a hub stands on carries everything that
 *   calls on the hub.
 * - **Corridor.** A road travels along the streets of its endpoints' common
 *   ancestor folder, between the two child boxes (or parcels) it connects.
 *   Every street of that folder inside the corridor's bounding box is credited
 *   — the trunks between two sibling subfolders, or the boulevards between
 *   two packages. This is what makes through traffic visible: a boulevard
 *   has almost no frontage of its own.
 * - **Egress.** On its way up to that ancestor, a road leaves every folder
 *   below it. That traffic is credited to the streets *bounding* each folder
 *   it leaves — the parent folder's streets around the box.
 *
 * The sum is bucketed into a `StreetGrade` on a log scale against the map's
 * own busiest streets, nudged by the neighborhood's settlement band (a hamlet
 * lane stays dirt, a city lane is at least cobbled) and capped by the map's
 * register, so a small repository never grows a trolley line. Server-side by
 * the same rule as `urbanity`: the renderer maps grade to carriageway, surface,
 * and furniture 1:1 and never re-derives thresholds.
 */

export interface TrafficBlock {
  id: string;
  /** Folder of the file ('' at the map root). */
  districtId: string;
  /** The frozen parcel; frontage is measured from it, not the footprint. */
  lot: Rect;
  /** Live parcels only — tombstones and PR phantoms generate no traffic. */
  live: boolean;
  urbanity?: number | undefined;
}

export interface TrafficInput {
  blocks: TrafficBlock[];
  districts: Pick<MapDistrict, 'id' | 'rect'>[];
  streets: Pick<MapStreet, 'id' | 'rect' | 'districtId'>[];
  roads: Pick<MapRoad, 'a' | 'b' | 'bidirectional'>[];
  /** The map's overall register — caps the highest grade a street can earn. */
  settlement: Settlement;
}

export interface StreetTraffic {
  traffic: number;
  grade: StreetGrade;
}

/** How close (world units) a parcel or folder edge must be to a street to
 *  front it. Lots sit flush against their lanes and within a folder pad (≤5)
 *  of the parent's trunks; grandparent streets are ≥10 away and must not be
 *  reached, or every folder would credit its traffic two levels up. */
const FRONTAGE_MARGIN = 6;

/** Spatial hash cell for street lookup, world units. */
const CELL = 64;

/** Busiest-street reference: a percentile rather than the max so one
 *  pathological hub cannot flatten the whole map into narrow lanes. */
const REF_PERCENTILE = 0.98;

/** Highest grade a map of each register may build. Hamlets and villages are
 *  never electrified; a town of this era very often was. */
const GRADE_CAP: Record<Settlement, StreetGrade> = {
  hamlet: 3,
  village: 5,
  town: 7,
  city: 7,
};

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Ancestor chain of a folder, itself first, the root ('') last. */
function chainOf(folder: string): string[] {
  const out = [folder];
  let cur = folder;
  while (cur !== '') {
    cur = folderOf(cur);
    out.push(cur);
  }
  return out;
}

/** True when two rects are within `margin` of each other on both axes. */
function within(a: Rect, b: Rect, margin: number): boolean {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return dx <= margin && dy <= margin;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Spatial hash over a subset of the streets (one per folder, plus one over
 *  all of them), so a corridor query for a cross-map road only touches the
 *  handful of streets at its own level. */
class StreetGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly stamp: number[];
  private query = 0;

  constructor(
    private readonly streets: TrafficInput['streets'],
    include: (st: TrafficInput['streets'][number]) => boolean,
  ) {
    this.stamp = new Array<number>(streets.length).fill(0);
    streets.forEach((st, i) => {
      if (!include(st)) return;
      for (const key of this.keysFor(st.rect, 0)) {
        const list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, [i]);
      }
    });
  }

  private keysFor(r: Rect, margin: number): string[] {
    const x0 = Math.floor((r.x - margin) / CELL);
    const y0 = Math.floor((r.y - margin) / CELL);
    const x1 = Math.floor((r.x + r.w + margin) / CELL);
    const y1 = Math.floor((r.y + r.h + margin) / CELL);
    const keys: string[] = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) keys.push(`${cx},${cy}`);
    return keys;
  }

  /** Indices of streets within `margin` of `r`, each at most once. */
  near(r: Rect, margin: number): number[] {
    this.query += 1;
    const out: number[] = [];
    for (const key of this.keysFor(r, margin)) {
      const list = this.cells.get(key);
      if (!list) continue;
      for (const i of list) {
        if (this.stamp[i] === this.query) continue;
        this.stamp[i] = this.query;
        if (within(r, this.streets[i]!.rect, margin)) out.push(i);
      }
    }
    return out;
  }
}

function clampGrade(g: number): StreetGrade {
  return Math.max(0, Math.min(7, Math.round(g))) as StreetGrade;
}

/**
 * Estimate traffic for every street and bucket it into a road grade.
 * Deterministic and O(blocks + roads·depth + streets); runs on every build.
 */
export function computeStreetTraffic(input: TrafficInput): Map<string, StreetTraffic> {
  const out = new Map<string, StreetTraffic>();
  const { streets } = input;
  if (streets.length === 0) return out;

  // ── import degree per parcel; egress per folder; corridors per road ────
  const degree = new Map<string, number>();
  const egress = new Map<string, number>();
  const blockById = new Map<string, TrafficBlock>();
  for (const b of input.blocks) blockById.set(b.id, b);
  const districtRect = new Map<string, Rect>();
  for (const d of input.districts) districtRect.set(d.id, d.rect);

  const traffic = new Array<number>(streets.length).fill(0);
  const grids = new Map<string, StreetGrid>();
  const gridFor = (folder: string): StreetGrid => {
    let grid = grids.get(folder);
    if (!grid) {
      grid = new StreetGrid(streets, (st) => (st.districtId ?? '') === folder);
      grids.set(folder, grid);
    }
    return grid;
  };

  /** The rect a road travels from at its common-ancestor level: the parcel
   *  itself when the file sits directly in that folder, else the child box. */
  const endpointRect = (chain: string[], lca: string, lot: Rect): Rect | undefined => {
    if (chain[0] === lca) return lot;
    const childIndex = chain.indexOf(lca) - 1;
    return districtRect.get(chain[childIndex]!);
  };

  for (const road of input.roads) {
    const w = road.bidirectional ? 2 : 1;
    degree.set(road.a, (degree.get(road.a) ?? 0) + w);
    degree.set(road.b, (degree.get(road.b) ?? 0) + w);
    const a = blockById.get(road.a);
    const b = blockById.get(road.b);
    if (!a?.live || !b?.live) continue;
    const chainA = chainOf(a.districtId);
    const setA = new Set(chainA);
    const chainB = chainOf(b.districtId);
    let lca = '';
    for (const f of chainB) {
      if (setA.has(f)) {
        lca = f;
        break;
      }
    }
    for (const f of chainA) {
      if (f === lca) break;
      egress.set(f, (egress.get(f) ?? 0) + w);
    }
    for (const f of chainB) {
      if (f === lca) break;
      egress.set(f, (egress.get(f) ?? 0) + w);
    }
    const ra = endpointRect(chainA, lca, a.lot);
    const rb = endpointRect(chainB, lca, b.lot);
    if (!ra || !rb) continue;
    for (const i of gridFor(lca).near(union(ra, rb), 0)) traffic[i]! += w;
  }

  // ── credit frontage and egress to the streets parcels and folders touch ──
  const grid = new StreetGrid(streets, () => true);

  for (const b of input.blocks) {
    if (!b.live) continue;
    const d = degree.get(b.id) ?? 0;
    if (d === 0) continue;
    for (const i of grid.near(b.lot, FRONTAGE_MARGIN)) traffic[i]! += d;
  }

  for (const d of input.districts) {
    const e = egress.get(d.id) ?? 0;
    if (e === 0) continue;
    for (const i of gridFor(folderOf(d.id)).near(d.rect, FRONTAGE_MARGIN)) traffic[i]! += e;
  }

  // ── neighborhood register per folder, for the surface nudge ────────────
  const urbSum = new Map<string, { total: number; count: number }>();
  for (const b of input.blocks) {
    if (!b.live || b.urbanity === undefined) continue;
    const acc = urbSum.get(b.districtId) ?? { total: 0, count: 0 };
    acc.total += b.urbanity;
    acc.count += 1;
    urbSum.set(b.districtId, acc);
  }
  const nudgeFor = (districtId: string | null): number => {
    if (districtId === null) return 0;
    const acc = urbSum.get(districtId);
    if (!acc || acc.count === 0) return 0;
    const band = settlementFor(acc.total / acc.count);
    return band === 'hamlet' ? -1 : band === 'city' ? 1 : 0;
  };

  // ── bucket on a log scale against the map's own busy streets ───────────
  const positives = traffic.filter((v) => v > 0).sort((a, b) => a - b);
  const ref =
    positives.length === 0
      ? 0
      : positives[Math.min(positives.length - 1, Math.floor(REF_PERCENTILE * positives.length))]!;
  const logRef = Math.log1p(Math.max(1, ref));
  const cap = GRADE_CAP[input.settlement];

  streets.forEach((st, i) => {
    const v = traffic[i]!;
    const t = v <= 0 ? 0 : Math.min(1, Math.log1p(v) / logRef);
    const raw = Math.round(t * 7) + nudgeFor(st.districtId);
    out.set(st.id, {
      traffic: Math.round(v * 100) / 100,
      grade: Math.min(cap, clampGrade(raw)) as StreetGrade,
    });
  });
  return out;
}
