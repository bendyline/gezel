import type { Rect } from '../schemas/api.js';
import type { LayoutFileInput } from './types.js';

/**
 * Parcels ("lots") — the city-block treatment of files. Each file owns a lot:
 * a building footprint plus yard margins, with a hash-jittered aspect so a row
 * of files reads as varied buildings rather than a size-sorted carpet. The lot
 * is the persistence + collision unit and is frozen across builds; the
 * footprint regrows inside it as the file's LoC changes. Yards are the space
 * the renderer decorates (trees, shrubs).
 */

const MIN_BLOCK = 10;
const MAX_BLOCK = 64;

/** Block side length from line count: √-scaled so area tracks LoC, then clamped. */
export function blockSize(loc: number): number {
  const v = Math.max(1, loc);
  return clamp(8 + 1.4 * Math.sqrt(v), MIN_BLOCK, MAX_BLOCK);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(lo: number, hi: number, t: number): number {
  return lo + (hi - lo) * t;
}

/** Deterministic value in [0, 1) from a path + salt (FNV-1a core). */
export function hash01(s: string, salt: number): number {
  let a = (2166136261 ^ Math.imul(salt + 1, 2654435761)) >>> 0;
  for (let i = 0; i < s.length; i++) {
    a ^= s.charCodeAt(i);
    a = Math.imul(a, 16777619);
  }
  return ((a >>> 0) % 100000) / 100000;
}

/** Sidewalk gap between adjacent lots in a row. */
export const SIDEWALK = 2;
/** Lane between parcel rows inside one folder's strip. */
export const LANE_WIDTH = 4;
/** Footprint w/h jitter range — varied buildings, never extreme slivers. */
const ASPECT_MIN = 0.62;
const ASPECT_MAX = 1.6;
/** Yard margins around the footprint (world units). Bottom is the front
 *  setback facing the lane below the row — the renderer's tree space. */
const YARD_SIDE_MIN = 0.5;
const YARD_SIDE_MAX = 2;
const YARD_FRONT_MIN = 1;
const YARD_FRONT_MAX = 2.5;
/** A grown footprint never eats the yard entirely — this much always remains. */
const MIN_YARD = 0.5;
/** Wide-row bias for strip packing (rows of buildings facing lanes). */
const STRIP_ASPECT = 1.25;

export interface LotSpec {
  lotW: number;
  lotH: number;
  /** Footprint rect relative to the lot origin. */
  foot: Rect;
}

/**
 * Deterministic parcel spec for a file: footprint area follows the same
 * area-∝-LoC law as `blockSize`, with per-path aspect + yard jitter.
 * `importance` (import-graph centrality, 0..1) widens the yards — hubs get
 * roomier, greener lots. The bonus room lands ONLY on the right/bottom yards:
 * the footprint's left/top anchor must be re-derivable without knowing the
 * importance at seed time (`footprintWithin` regrows footprints inside frozen
 * lots on every later build), so the anchor yards stay unscaled.
 */
export function lotSpec(path: string, weight: number, importance = 0): LotSpec {
  const side = blockSize(weight);
  const area = side * side;
  const aspect = lerp(ASPECT_MIN, ASPECT_MAX, hash01(path, 1));
  const footW = clamp(Math.sqrt(area * aspect), MIN_BLOCK * 0.8, MAX_BLOCK);
  const footH = clamp(Math.sqrt(area / aspect), MIN_BLOCK * 0.8, MAX_BLOCK);
  const yardL = lerp(YARD_SIDE_MIN, YARD_SIDE_MAX, hash01(path, 2));
  const yardR = lerp(YARD_SIDE_MIN, YARD_SIDE_MAX, hash01(path, 3));
  const yardT = lerp(YARD_SIDE_MIN, YARD_SIDE_MAX, hash01(path, 5));
  const yardB = lerp(YARD_FRONT_MIN, YARD_FRONT_MAX, hash01(path, 4));
  const bonus = 0.9 * clamp(importance, 0, 1);
  return {
    lotW: footW + yardL + yardR + bonus * (yardL + yardR),
    lotH: footH + yardT + yardB + bonus * (yardT + yardB),
    foot: { x: yardL, y: yardT, w: footW, h: footH },
  };
}

/**
 * The footprint for a file inside its (frozen) lot: anchored at its original
 * yard offsets (so x,y never move), growing right/down with the file's LoC and
 * clamped so a minimum yard always survives. A file that outgrows its lot
 * saturates visually; the weight still travels on the wire.
 */
export function footprintWithin(path: string, weight: number, lot: Rect): Rect {
  const spec = lotSpec(path, weight);
  const w = Math.min(spec.foot.w, Math.max(1, lot.w - spec.foot.x - MIN_YARD));
  const h = Math.min(spec.foot.h, Math.max(1, lot.h - spec.foot.y - MIN_YARD));
  return { x: lot.x + spec.foot.x, y: lot.y + spec.foot.y, w, h };
}

function overlapsRect(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  );
}

export interface AppendResult {
  lot: Rect;
  /** A fresh tier-3 lane opened under the strip, when a new row was started. */
  newLane: Rect | null;
}

/**
 * Grow a folder's strip the way a city grows: extend the bottom parcel row
 * rightward, or open a new row below behind a fresh lane. Works purely from
 * the persisted sibling geometry — no reflow, no moved neighbours. Returns
 * null when neither spot is clear (caller falls back to the spiral).
 */
export function appendLotInFolder(
  spec: LotSpec,
  siblingLots: Rect[],
  occupied: Rect[],
): AppendResult | null {
  if (siblingLots.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const r of siblingLots) {
    left = Math.min(left, r.x);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  const collides = (r: Rect): boolean => occupied.some((o) => overlapsRect(r, o, 0.25));

  // rows are bottom-aligned, so the bottom row shares one baseline
  const row = siblingLots.filter((r) => Math.abs(r.y + r.h - bottom) < 0.5);
  const rowRight = Math.max(...row.map((r) => r.x + r.w));
  const sameRow: Rect = {
    x: rowRight + SIDEWALK,
    y: bottom - spec.lotH,
    w: spec.lotW,
    h: spec.lotH,
  };
  if (sameRow.x + sameRow.w <= right + 0.5 && !collides(sameRow)) {
    return { lot: sameRow, newLane: null };
  }

  const newRow: Rect = { x: left, y: bottom + LANE_WIDTH, w: spec.lotW, h: spec.lotH };
  const lane: Rect = { x: left, y: bottom, w: Math.max(right - left, spec.lotW), h: LANE_WIDTH };
  if (!collides(newRow) && !collides(lane)) {
    return { lot: newRow, newLane: lane };
  }
  return null;
}

export interface StripLot {
  path: string;
  lot: Rect;
  foot: Rect;
}

export interface StripPlaza {
  /** The landmark file this plaza fronts. */
  path: string;
  rect: Rect;
}

export interface StripResult {
  w: number;
  h: number;
  lots: StripLot[];
  /** One lane rect below each row except the last (the folder street serves it). */
  lanes: Rect[];
  /** Open squares fronting landmark files (empty without landmarks). */
  plazas: StripPlaza[];
}

export interface StripOptions {
  /** Row-wrap width; defaults to the ~square heuristic. The town packer sets
   *  this to the column width so parcel rows fill wall-to-wall. */
  targetW?: number;
}

/**
 * Pack one folder's direct files as parcel rows: path order (not size order —
 * that's what killed the "sorted carpet" look), left→right with sidewalk gaps,
 * bottom-aligned so buildings face the lane below their row. Landmark files
 * (`LayoutFileInput.landmark`) get an adjacent plaza slot in their row.
 */
export function packLeafStrip(files: LayoutFileInput[], options: StripOptions = {}): StripResult {
  if (files.length === 0) return { w: 0, h: 0, lots: [], lanes: [], plazas: [] };
  const specs = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => ({
      path: f.path,
      landmark: f.landmark === true,
      spec: lotSpec(f.path, f.weight, f.importance ?? 0),
    }));

  let maxLotW = 0;
  let area = 0;
  for (const { spec } of specs) {
    maxLotW = Math.max(maxLotW, spec.lotW);
    area += spec.lotW * spec.lotH;
  }
  const targetW =
    options.targetW !== undefined
      ? Math.max(maxLotW, options.targetW)
      : Math.max(maxLotW, Math.sqrt((area * STRIP_ASPECT) / 0.8));

  const plazaWidthFor = (spec: LotSpec): number => clamp(spec.foot.w * 0.8, 8, 24);

  const lots: StripLot[] = [];
  const lanes: Rect[] = [];
  const plazas: StripPlaza[] = [];
  let row: Array<{ path: string; spec: LotSpec; x: number; plazaW: number }> = [];
  let x = 0;
  let y = 0;
  let stripW = 0;

  const flushRow = (): void => {
    if (row.length === 0) return;
    const rowH = Math.max(...row.map((r) => r.spec.lotH));
    for (const r of row) {
      const lotY = y + (rowH - r.spec.lotH); // bottom-aligned within the row
      lots.push({
        path: r.path,
        lot: { x: r.x, y: lotY, w: r.spec.lotW, h: r.spec.lotH },
        foot: {
          x: r.x + r.spec.foot.x,
          y: lotY + r.spec.foot.y,
          w: r.spec.foot.w,
          h: r.spec.foot.h,
        },
      });
      if (r.plazaW > 0) {
        plazas.push({
          path: r.path,
          rect: { x: r.x + r.spec.lotW + SIDEWALK, y: lotY, w: r.plazaW, h: r.spec.lotH },
        });
      }
      stripW = Math.max(stripW, r.x + r.spec.lotW + (r.plazaW > 0 ? SIDEWALK + r.plazaW : 0));
    }
    y += rowH;
    row = [];
    x = 0;
  };

  for (const it of specs) {
    const plazaW = it.landmark ? plazaWidthFor(it.spec) : 0;
    const slotW = it.spec.lotW + (plazaW > 0 ? SIDEWALK + plazaW : 0);
    if (x > 0 && x + slotW > targetW) {
      flushRow();
      lanes.push({ x: 0, y, w: 0, h: LANE_WIDTH }); // width fixed up below
      y += LANE_WIDTH;
    }
    row.push({ path: it.path, spec: it.spec, x, plazaW });
    x += slotW + SIDEWALK;
  }
  flushRow();

  for (const lane of lanes) lane.w = stripW;
  return { w: stripW, h: y, lots, lanes, plazas };
}
