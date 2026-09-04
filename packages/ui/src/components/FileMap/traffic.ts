import type { FileMapResponse, MapStreet, Rect, StreetGrade } from '@bendyline/gezel';
import type { CityPalette } from './palette.js';
import { hash32, seeded } from './seed.js';
import type { SpriteKey } from './sprites.js';

/**
 * The client view of street traffic: what a road of each grade is BUILT as.
 *
 * The service grades every street 0..7 from the traffic it estimates
 * ([service/filemap/traffic.ts]); this module owns the 1:1 mapping from that
 * grade to geometry — how much of the right-of-way is carriageway, whether
 * there are sidewalks, what the surface is, whether a trolley runs — and lays
 * the furniture and vehicles out along each street in world space, once per
 * payload. The two renderers read the same struct so the plan view and the
 * iso view never disagree about what a street is.
 *
 * The right-of-way width comes from the layout's street tier and is fixed. A
 * grade only ever varies what is built INSIDE it: a narrow dirt track down a
 * 16-unit boulevard reservation reads as a country road with wide verges,
 * which is exactly what a boulevard between two sleepy packages is.
 */

export type StreetSurface = 'dirt' | 'cobble' | 'paved';

export interface GradeSpec {
  /** Carriageway width as a fraction of the right-of-way. */
  carriageway: number;
  /** Sidewalk width on EACH side, as a fraction of the right-of-way. */
  sidewalk: number;
  surface: StreetSurface;
  /** Grass verges fill the rest of the reservation (rural grades). */
  verge: boolean;
  lamps: boolean;
  trees: boolean;
  trolley: boolean;
  /** Carts per 80 world units of street (0 = none). */
  carts: number;
  walkers: boolean;
}

/** Index-aligned with `StreetGrade`: narrow dirt → trolley avenue. */
export const GRADE_SPEC: readonly GradeSpec[] = [
  {
    carriageway: 0.55,
    sidewalk: 0,
    surface: 'dirt',
    verge: true,
    lamps: false,
    trees: false,
    trolley: false,
    carts: 0,
    walkers: false,
  },
  {
    carriageway: 0.55,
    sidewalk: 0,
    surface: 'cobble',
    verge: true,
    lamps: false,
    trees: false,
    trolley: false,
    carts: 0,
    walkers: false,
  },
  {
    carriageway: 0.55,
    sidewalk: 0,
    surface: 'paved',
    verge: true,
    lamps: false,
    trees: false,
    trolley: false,
    carts: 0,
    walkers: false,
  },
  {
    carriageway: 0.8,
    sidewalk: 0,
    surface: 'dirt',
    verge: true,
    lamps: false,
    trees: false,
    trolley: false,
    carts: 1,
    walkers: false,
  },
  {
    carriageway: 0.8,
    sidewalk: 0,
    surface: 'paved',
    verge: false,
    lamps: false,
    trees: false,
    trolley: false,
    carts: 1,
    walkers: false,
  },
  {
    carriageway: 0.64,
    sidewalk: 0.16,
    surface: 'paved',
    verge: false,
    lamps: true,
    trees: false,
    trolley: false,
    carts: 1.5,
    walkers: true,
  },
  {
    carriageway: 0.72,
    sidewalk: 0.14,
    surface: 'paved',
    verge: false,
    lamps: true,
    trees: true,
    trolley: false,
    carts: 2,
    walkers: true,
  },
  {
    carriageway: 0.72,
    sidewalk: 0.14,
    surface: 'paved',
    verge: false,
    lamps: true,
    trees: true,
    trolley: true,
    carts: 2,
    walkers: true,
  },
];

/** What a pre-traffic payload renders as, by tier: avenue → wide paved with
 *  sidewalks, street → wide paved, lane → narrow paved, alley → narrow cobble.
 *  Roughly the pre-grade look, so old maps keep reading the same. */
const LEGACY_GRADE_BY_TIER: readonly StreetGrade[] = [5, 4, 2, 1];

export function streetGrade(st: Pick<MapStreet, 'tier' | 'grade'>): StreetGrade {
  if (st.grade !== undefined) return Math.max(0, Math.min(7, st.grade)) as StreetGrade;
  return LEGACY_GRADE_BY_TIER[Math.max(0, Math.min(3, st.tier))]!;
}

export interface WorldPt {
  x: number;
  y: number;
}

export interface WorldLine {
  a: WorldPt;
  b: WorldPt;
}

export type VehicleKind = 'cart' | 'trolley' | 'walker';

export interface Vehicle {
  kind: VehicleKind;
  /** Seeded start position along the street, as a fraction of its length. */
  phase: number;
  /** World units per millisecond. */
  speed: number;
  /** +1 travels toward the far end, −1 toward the near end. */
  dir: 1 | -1;
  /** Offset from the street's center line across the right-of-way. */
  cross: number;
}

export interface StreetGeometry {
  street: MapStreet;
  grade: StreetGrade;
  spec: GradeSpec;
  /** True when the street runs along world x. */
  horizontal: boolean;
  /** Along-axis extent of the CARRIAGEWAY, after junctions are joined — a
   *  street reaches across a folder pad to meet the road it turns onto. */
  a0: number;
  a1: number;
  length: number;
  /** Center of the right-of-way across the street. */
  center: number;
  /** Full right-of-way width across the street. */
  width: number;
  carriagewayWidth: number;
  sidewalkWidth: number;
  /** The full right-of-way, extended to the reservation it joins. The verge
   *  fills it, and it is the cull rect — a superset of `street.rect`. */
  reservation: Rect;
  carriageway: Rect;
  /** Near-side and far-side sidewalks (absent below grade 5). */
  sidewalks: [Rect, Rect] | null;
  /** The pair of rails of a trolley street. */
  rails: [WorldLine, WorldLine] | null;
  /** Gauge between the rails, world units. */
  gauge: number;
  lamps: WorldPt[];
  /** Overhead-line poles, in order along the street (wire runs between). */
  poles: WorldPt[];
  trees: Array<{ x: number; y: number; size: number; sprite: SpriteKey }>;
  vehicles: Vehicle[];
}

export interface TrafficLayout {
  streets: StreetGeometry[];
  /** Streets with something that moves — the animation gate reads this. */
  animated: StreetGeometry[];
}

const LAMP_SPACING = 22;
const POLE_SPACING = 34;
const TREE_SPACING = 18;
const WALKER_SPACING = 26;
const MAX_ITEMS = 48;
const TREE_SPRITES: SpriteKey[] = ['tree1', 'tree2'];

/** World units per millisecond. A cart at walking pace, a trolley at a clip. */
const CART_SPEED = 0.0055;
const TROLLEY_SPEED = 0.012;
const WALKER_SPEED = 0.0022;

function spread(a0: number, a1: number, spacing: number): number[] {
  const length = a1 - a0;
  const n = Math.min(MAX_ITEMS, Math.floor(length / spacing));
  if (n <= 0) return [];
  const step = length / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a0 + step * (i + 0.5));
  return out;
}

/** A street's axis and extents before junctions are resolved. */
interface Measured {
  street: MapStreet;
  grade: StreetGrade;
  spec: GradeSpec;
  horizontal: boolean;
  a0: number;
  a1: number;
  center: number;
  width: number;
  carriagewayWidth: number;
  sidewalkWidth: number;
  /** Carriageway extent after joining — starts equal to a0/a1. */
  c0: number;
  c1: number;
  /** Reservation extent after joining (verges, sidewalks, furniture). */
  r0: number;
  r1: number;
}

function measure(st: MapStreet): Measured {
  const r = st.rect;
  const horizontal = r.w >= r.h;
  const a0 = horizontal ? r.x : r.y;
  const a1 = horizontal ? r.x + r.w : r.y + r.h;
  const width = horizontal ? r.h : r.w;
  const center = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;
  const grade = streetGrade(st);
  const spec = GRADE_SPEC[grade]!;
  return {
    street: st,
    grade,
    spec,
    horizontal,
    a0,
    a1,
    center,
    width,
    carriagewayWidth: width * spec.carriageway,
    sidewalkWidth: width * spec.sidewalk,
    c0: a0,
    c1: a1,
    r0: a0,
    r1: a1,
  };
}

/** Largest gap a street end reaches across to meet a perpendicular street.
 *  Covers a folder's padding plus its label gutter — the same reach the road
 *  router bridges when it turns a lane onto an avenue. */
const JUNCTION_REACH = 20;
/** Overlap into the met carriageway so no hairline of ground shows at a T. */
const JOIN_OVERLAP = 0.3;

/**
 * Join street ends to the perpendicular streets they stop short of.
 *
 * The packer leaves every folder's inner lanes ending at the folder box, a
 * pad short of the parent's trunk, and cross-streets ending at the column
 * edge; with narrow carriageways the gap grows by the trunk's own verge. A
 * road that visibly stops a few units short of the road it turns onto is the
 * single most artificial thing on the map, so each end reaches across to the
 * nearest perpendicular street within `JUNCTION_REACH`:
 *
 * - at a **T**, the carriageway runs to the met carriageway's near edge (plus
 *   a hair of overlap), and the reservation — verge, sidewalks, lamps — to
 *   the met reservation's edge, so a sidewalk never runs out into a road;
 * - at an **L-corner**, where the met street also ends here, both run through
 *   to the far edge, so the corner square is paved by whichever paints last.
 */
function joinStreets(streets: Measured[]): void {
  const horizontal = streets.filter((g) => g.horizontal);
  const vertical = streets.filter((g) => !g.horizontal);
  for (const g of streets) {
    const perps = g.horizontal ? vertical : horizontal;
    for (const side of [-1, 1] as const) {
      let best: { p: Measured; gap: number } | null = null;
      const end = side === 1 ? g.a1 : g.a0;
      // The met street may itself stop short of this one's center line by
      // the same reach plus half this street's width (an L-corner).
      const tolerance = JUNCTION_REACH + g.width / 2;
      for (const p of perps) {
        if (g.center < p.a0 - tolerance || g.center > p.a1 + tolerance) continue;
        const near = p.center - side * (p.width / 2);
        const gap = side === 1 ? near - end : end - near;
        // Already crossing it (or beyond) — nothing to join.
        if (gap < -p.width || gap > JUNCTION_REACH) continue;
        if (!best || gap < best.gap) best = { p, gap };
      }
      if (!best) continue;
      const { p } = best;
      // A corner: the met street does not continue past this one on both sides.
      const corner = g.center < p.a0 + g.width || g.center > p.a1 - g.width;
      const cw = p.carriagewayWidth / 2;
      const carriageTarget = corner
        ? p.center + side * cw
        : p.center - side * cw + side * JOIN_OVERLAP;
      const reserveTarget = corner
        ? p.center + side * (p.width / 2)
        : p.center - side * (p.width / 2);
      if (side === 1) {
        g.c1 = Math.max(g.c1, carriageTarget);
        g.r1 = Math.max(g.r1, reserveTarget);
      } else {
        g.c0 = Math.min(g.c0, carriageTarget);
        g.r0 = Math.min(g.r0, reserveTarget);
      }
    }
  }
}

function finish(m: Measured): StreetGeometry {
  const { street: st, grade, spec, horizontal, center, width, carriagewayWidth, sidewalkWidth } = m;
  const a0 = m.c0;
  const a1 = m.c1;

  const pt = (along: number, cross: number): WorldPt =>
    horizontal ? { x: along, y: center + cross } : { x: center + cross, y: along };
  const band = (from: number, to: number, c0: number, c1: number): Rect =>
    horizontal
      ? { x: from, y: center + c0, w: to - from, h: c1 - c0 }
      : { x: center + c0, y: from, w: c1 - c0, h: to - from };

  const half = carriagewayWidth / 2;
  const carriageway = band(a0, a1, -half, half);
  const reservation = band(m.r0, m.r1, -width / 2, width / 2);
  const sidewalks: [Rect, Rect] | null =
    sidewalkWidth > 0
      ? [
          band(m.r0, m.r1, -half - sidewalkWidth, -half),
          band(m.r0, m.r1, half, half + sidewalkWidth),
        ]
      : null;

  const gauge = Math.min(1.6, carriagewayWidth * 0.45);
  const rails: [WorldLine, WorldLine] | null = spec.trolley
    ? [
        { a: pt(a0, -gauge / 2), b: pt(a1, -gauge / 2) },
        { a: pt(a0, gauge / 2), b: pt(a1, gauge / 2) },
      ]
    : null;

  const random = seeded(hash32(`street-life:${st.id}`));
  const outer = half + sidewalkWidth;
  const lamps: WorldPt[] = spec.lamps
    ? spread(m.r0, m.r1, LAMP_SPACING).map((along, i) =>
        pt(along, (i % 2 === 0 ? -1 : 1) * outer * 0.9),
      )
    : [];
  const poles: WorldPt[] = spec.trolley
    ? spread(m.r0, m.r1, POLE_SPACING).map((along) => pt(along, outer * 0.85))
    : [];
  const trees = spec.trees
    ? spread(m.r0, m.r1, TREE_SPACING).map((along, i) => {
        const p = pt(along + (random() - 0.5) * 3, (i % 2 === 0 ? 1 : -1) * outer * 0.6);
        return {
          ...p,
          size: 2 + random() * 0.8,
          sprite: TREE_SPRITES[Math.floor(random() * TREE_SPRITES.length)]!,
        };
      })
    : [];

  const vehicles: Vehicle[] = [];
  const length = a1 - a0;
  if (spec.trolley && length >= 40) {
    const cars = 1 + Math.floor(length / 260);
    for (let i = 0; i < cars; i++) {
      vehicles.push({
        kind: 'trolley',
        phase: random(),
        speed: TROLLEY_SPEED * (0.9 + random() * 0.2),
        dir: i % 2 === 0 ? 1 : -1,
        cross: 0,
      });
    }
  }
  if (spec.carts > 0 && length >= 24) {
    const carts = Math.min(5, Math.round((length / 80) * spec.carts));
    for (let i = 0; i < carts; i++) {
      const dir: 1 | -1 = random() < 0.5 ? 1 : -1;
      vehicles.push({
        kind: 'cart',
        phase: random(),
        speed: CART_SPEED * (0.8 + random() * 0.4),
        dir,
        // Keep right: the offset flips with the direction of travel.
        cross: dir * half * 0.45,
      });
    }
  }
  if (spec.walkers && sidewalks && length >= WALKER_SPACING) {
    const walkers = Math.min(8, Math.floor(length / WALKER_SPACING));
    for (let i = 0; i < walkers; i++) {
      const side = random() < 0.5 ? -1 : 1;
      vehicles.push({
        kind: 'walker',
        phase: random(),
        speed: WALKER_SPEED * (0.7 + random() * 0.6),
        dir: random() < 0.5 ? 1 : -1,
        cross: side * (half + sidewalkWidth / 2),
      });
    }
  }

  return {
    street: st,
    grade,
    spec,
    horizontal,
    a0,
    a1,
    length,
    center,
    width,
    carriagewayWidth,
    sidewalkWidth,
    reservation,
    carriageway,
    sidewalks,
    rails,
    gauge,
    lamps,
    poles,
    trees,
    vehicles,
  };
}

const cache = new WeakMap<FileMapResponse, TrafficLayout>();

/** Per-payload street geometry, built once (same pattern as `decorForModel`). */
export function trafficLayoutForModel(model: FileMapResponse): TrafficLayout {
  const hit = cache.get(model);
  if (hit) return hit;
  const measured = (model.streets ?? []).map(measure);
  joinStreets(measured);
  const streets = measured.map(finish);
  const built: TrafficLayout = {
    streets,
    animated: streets.filter((g) => g.vehicles.length > 0),
  };
  cache.set(model, built);
  return built;
}

/**
 * Carriageway fill for a street. Paved grades climb the pavement ramp as they
 * get busier — a country lane is the quiet lane tone, a trolley avenue the
 * avenue tone — so the grade reads at district zoom from the fill alone.
 */
export function streetSurfaceColor(
  g: Pick<StreetGeometry, 'grade' | 'spec'>,
  p: CityPalette,
): string {
  switch (g.spec.surface) {
    case 'dirt':
      return p.dirtLane;
    case 'cobble':
      return p.cobble;
    default:
      return g.grade >= 5 ? p.pavementAvenue : g.grade >= 3 ? p.pavementStreet : p.pavementLane;
  }
}

/** Where a vehicle is at time `t` (ms): its along-axis position, wrapped. */
export function vehicleAlong(g: StreetGeometry, v: Vehicle, t: number): number {
  const travelled = (t * v.speed + v.phase * g.length) % g.length;
  const pos = ((travelled % g.length) + g.length) % g.length;
  return v.dir === 1 ? g.a0 + pos : g.a1 - pos;
}

/** World point of a position along the street at a cross offset. */
export function streetPoint(g: StreetGeometry, along: number, cross: number): WorldPt {
  return g.horizontal ? { x: along, y: g.center + cross } : { x: g.center + cross, y: along };
}
