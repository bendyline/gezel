/**
 * Urbanity policy for the Village: how *urban* the ground under each parcel is.
 * Server-side like the health and elevation policies — the renderer maps
 * `urbanity`/`settlement` to ground, materials, and surroundings 1:1 and never
 * re-derives thresholds.
 *
 * The point of the field is that one folder tree contains a settlement
 * *gradient* rather than a uniform register: the core reads city-ish (masonry,
 * parapets, cobbles) while the outskirts read village-ish (cottages, hedgerows,
 * dirt lanes). It is deliberately smooth and blobby — an amorphous field, not a
 * per-file speckle and not four concentric bands.
 *
 * The load-bearing design decision: **urbanity samples the neighborhood, never
 * the block's own importance.** `prominenceScore` in elevation.ts is already
 * `0.55 * importance + …`, so importance owns height. Sampling it again here
 * would make every central file simultaneously tall, civic, and city-registered
 * — three restatements of one number, and the core collapses into an
 * undifferentiated wall. Sampling the neighborhood instead means a dull
 * `constants.ts` next to the router hub is correctly downtown (it *is* on a city
 * street) while the hub itself gets no personal bonus on top of already being
 * five storeys, civic, and a landmark.
 */

import type { Rect, Settlement, VillageDowntown } from '@bendyline/gezel';

export interface UrbanityInput {
  path: string;
  /** The frozen parcel — the stable positional unit. */
  lot: Rect;
  /** Built area. Yards are not built, so density uses this, not the lot. */
  footprint: Rect;
  /** Max-normalized PageRank from centrality.ts; 0 when there is no graph. */
  importance: number;
}

export interface UrbanityOptions {
  /** False when the map has no resolved import edges — see WEIGHTS below. */
  hasEdges: boolean;
  /** Previously persisted field parameters, for sticky adoption. */
  prior?: VillageDowntown | null | undefined;
}

export interface UrbanityField {
  /** The adopted parameters — possibly the prior object verbatim. */
  downtown: VillageDowntown;
  ceiling: number;
  byPath: Map<string, number>;
  peak: number;
  median: number;
  fileCount: number;
}

/** Keeps the centroid meaningful on maps with no import graph at all. */
const CENTROID_FLOOR = 0.25;
/** Floor on the gyration radius — kills NaN/÷0 on one-block maps. */
const MIN_RADIUS = 48;
/** Gaussian falloff scale, in gyration radii. At d = R the field is ≈0.47. */
const RADIAL_K = 1.15;

/** Grid cell, world units — between MIN_BLOCK (10) and MAX_BLOCK (64). */
const CELL = 48;
/** Box-blur radius in cells; the 240-unit window ≈ one folder strip. */
const BLUR_R = 2;
/**
 * Built fraction treated as "fully dense". Derived, not tuned: packColumns
 * targets ~0.75 fill and lots.ts yards leave footprints at ~0.6–0.85 of their
 * lot, so ~0.45–0.64 is as dense as this packer ever gets.
 */
const DENSITY_REF = 0.55;
/** Floor on the importance reference so a near-flat graph can't blow up. */
const IMP_REF_FLOOR = 0.05;

const N_MIN = 24;
const N_MAX = 4000;
const CEIL_MIN = 0.3;
/**
 * Quantum on the size ceiling — the field's hysteresis, achieved without
 * persisting anything per block.
 *
 * The raw ceiling is log-continuous, so every single added file nudges the
 * whole field by ~3e-4. That is tiny, but a threshold is a threshold: any block
 * sitting on one flips its `settlement` on the very next build, and in a
 * regular layout a whole symmetry class flips together. Snapping to 0.02 buys
 * roughly 60 files of headroom at N=400, so the register changes when the
 * project genuinely grows rather than on every indexer tick.
 */
const CEIL_STEP = 0.02;

/**
 * With no import graph the core term is unavailable. Redistributing rather than
 * zeroing keeps a graph-less map from reading systematically rural — the same
 * "degradation must be invisible" rule elevation.ts applies to churn.
 */
const WEIGHTS_WITH_EDGES = { radial: 0.45, density: 0.3, core: 0.25 } as const;
const WEIGHTS_NO_EDGES = { radial: 0.6, density: 0.4, core: 0 } as const;

/** Bucket thresholds. Defined here and nowhere else. */
const SETTLEMENT_THRESHOLDS = { village: 0.3, town: 0.52, city: 0.74 } as const;

/** Sticky-adoption triggers — see `adoptDowntown`. */
const MOVE_FRACTION = 0.04;
const RADIUS_FRACTION = 0.12;
const IMP_REF_FRACTION = 0.2;

export function settlementFor(urbanity: number): Settlement {
  if (urbanity >= SETTLEMENT_THRESHOLDS.city) return 'city';
  if (urbanity >= SETTLEMENT_THRESHOLDS.town) return 'town';
  if (urbanity >= SETTLEMENT_THRESHOLDS.village) return 'village';
  return 'hamlet';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function centerX(r: Rect): number {
  return r.x + r.w / 2;
}
function centerY(r: Rect): number {
  return r.y + r.h / 2;
}

/**
 * Project-size cap, multiplied into every block. Multiplying rather than
 * clamping means a small repo is uniformly rural while keeping its internal
 * contrast shape: 40 files → 0.37 (a village at best), 1200 → 0.84 (a city
 * core, town mid-ring, village rim), 4000+ → 1.0.
 */
export function sizeCeiling(fileCount: number): number {
  const scale = clamp01(Math.log(Math.max(1, fileCount) / N_MIN) / Math.log(N_MAX / N_MIN));
  const raw = CEIL_MIN + (1 - CEIL_MIN) * scale;
  return round(Math.round(raw / CEIL_STEP) * CEIL_STEP, 3);
}

/**
 * Adopt the freshly computed field parameters only when they genuinely moved.
 * The adopted values are what the field is actually computed from, not just
 * what gets persisted — see `computeUrbanity`.
 *
 * `VillageFileStore` skips a write only when the serialized bytes are identical,
 * so without this the sub-ULP centroid drift of an ordinary rebuild would
 * rewrite `.gezel/village.json` on every background indexer tick — a dirty git
 * diff in the user's repo, on a file we explicitly ask them to commit.
 *
 * All-or-nothing by design: mixing a stale center with a fresh radius would
 * produce a field that matches neither build.
 */
export function adoptDowntown(
  prior: VillageDowntown | null | undefined,
  fresh: VillageDowntown,
  mapDiagonal: number,
): VillageDowntown {
  if (!prior) return fresh;
  const moved = Math.hypot(fresh.cx - prior.cx, fresh.cy - prior.cy) > MOVE_FRACTION * mapDiagonal;
  const grew = Math.abs(fresh.r - prior.r) / Math.max(1, prior.r) > RADIUS_FRACTION;
  const shifted =
    Math.abs(fresh.impRef - prior.impRef) / Math.max(IMP_REF_FLOOR, prior.impRef) >
    IMP_REF_FRACTION;
  return moved || grew || shifted ? fresh : prior;
}

/** Separable box blur over a `w × h` grid, zero-padded outside the bounds.
 *  The zero padding is deliberate: it makes the map rim read loose for free,
 *  on every map size, with no special-casing. */
function boxBlur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = x + dx;
        if (sx >= 0 && sx < w) sum += src[y * w + sx]!;
      }
      tmp[y * w + x] = sum;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy >= 0 && sy < h) sum += tmp[sy * w + x]!;
      }
      out[y * w + x] = sum;
    }
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Compute the urbanity field over the live blocks of one map.
 *
 * Inputs are sorted by path before any accumulation so float sums are bitwise
 * identical regardless of caller ordering — the same discipline
 * `computeImportance` uses, and what makes the rebuild-stability test possible.
 */
export function computeUrbanity(
  blocks: readonly UrbanityInput[],
  opts: UrbanityOptions,
): UrbanityField {
  const items = [...blocks].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const n = items.length;
  const ceiling = sizeCeiling(n);

  if (n === 0) {
    const empty: VillageDowntown = { cx: 0, cy: 0, r: MIN_RADIUS, impRef: 0 };
    return {
      downtown: adoptDowntown(opts.prior, empty, MIN_RADIUS),
      ceiling,
      byPath: new Map(),
      peak: 0,
      median: 0,
      fileCount: 0,
    };
  }

  // ── downtown: importance-weighted centroid + radius of gyration ───────────
  let wSum = 0;
  let wx = 0;
  let wy = 0;
  for (const it of items) {
    const w = CENTROID_FLOOR + Math.max(0, it.importance);
    wSum += w;
    wx += w * centerX(it.lot);
    wy += w * centerY(it.lot);
  }
  const cx = wx / wSum;
  const cy = wy / wSum;

  // RMS gyration radius, not the map extent: one far-flung `scripts/` folder in
  // an outer compass cell would otherwise inflate the extent and collapse the
  // apparent downtown to a point.
  let wd2 = 0;
  for (const it of items) {
    const w = CENTROID_FLOOR + Math.max(0, it.importance);
    const dx = centerX(it.lot) - cx;
    const dy = centerY(it.lot) - cy;
    wd2 += w * (dx * dx + dy * dy);
  }
  const radius = Math.max(MIN_RADIUS, Math.sqrt(wd2 / wSum));

  // ── one grid pass: built area, importance, count ──────────────────────────
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    if (it.lot.x < minX) minX = it.lot.x;
    if (it.lot.y < minY) minY = it.lot.y;
    if (it.lot.x + it.lot.w > maxX) maxX = it.lot.x + it.lot.w;
    if (it.lot.y + it.lot.h > maxY) maxY = it.lot.y + it.lot.h;
  }
  const gw = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const gh = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const cellOf = (it: UrbanityInput): number => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor((centerX(it.lot) - minX) / CELL)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor((centerY(it.lot) - minY) / CELL)));
    return gy * gw + gx;
  };

  const areaGrid = new Float64Array(gw * gh);
  const impGrid = new Float64Array(gw * gh);
  const countGrid = new Float64Array(gw * gh);
  for (const it of items) {
    const c = cellOf(it);
    areaGrid[c]! += Math.max(0, it.footprint.w) * Math.max(0, it.footprint.h);
    impGrid[c]! += Math.max(0, it.importance);
    countGrid[c]! += 1;
  }

  const blurArea = boxBlur(areaGrid, gw, gh, BLUR_R);
  const blurImp = boxBlur(impGrid, gw, gh, BLUR_R);
  const blurCount = boxBlur(countGrid, gw, gh, BLUR_R);

  const windowSide = (2 * BLUR_R + 1) * CELL;
  const windowArea = windowSide * windowSide;

  const localImp = new Float64Array(gw * gh);
  const occupied: number[] = [];
  for (let i = 0; i < localImp.length; i++) {
    const c = blurCount[i]!;
    localImp[i] = blurImp[i]! / Math.max(1, c);
    if (c >= 1) occupied.push(localImp[i]!);
  }
  // p90, not max: one outlier hub shouldn't dim the whole rest of the map.
  const impRef = Math.max(IMP_REF_FLOOR, percentile(occupied, 0.9));

  const fresh: VillageDowntown = {
    cx: round(cx, 1),
    cy: round(cy, 1),
    r: round(radius, 1),
    impRef: round(impRef, 3),
  };
  const diagonal = Math.hypot(maxX - minX, maxY - minY) || MIN_RADIUS;

  // Adopt BEFORE blending, and blend from the adopted parameters. Persisting a
  // sticky downtown while computing from a fresh one would be pointless: these
  // four numbers are global normalizers, so a hair of drift in any of them
  // shifts every block at once, and any block sitting on a bucket threshold
  // flips its `settlement` on the next build. `impRef` is the sharpest of the
  // four — it is a p90 over occupied cells, so merely adding a file somewhere
  // else on the map moves it.
  const active = adoptDowntown(opts.prior, fresh, diagonal);

  // ── blend ─────────────────────────────────────────────────────────────────
  const w = opts.hasEdges ? WEIGHTS_WITH_EDGES : WEIGHTS_NO_EDGES;
  const byPath = new Map<string, number>();
  const values: number[] = [];
  for (const it of items) {
    const d = Math.hypot(centerX(it.lot) - active.cx, centerY(it.lot) - active.cy);
    const t = d / (RADIAL_K * active.r);
    const radial = Math.exp(-(t * t));
    const c = cellOf(it);
    const density = clamp01(blurArea[c]! / windowArea / DENSITY_REF);
    const coreImp = clamp01(localImp[c]! / Math.max(IMP_REF_FLOOR, active.impRef));
    const raw = w.radial * radial + w.density * density + w.core * coreImp;
    const u = round(clamp01(ceiling * raw), 3);
    byPath.set(it.path, u);
    values.push(u);
  }

  return {
    downtown: active,
    ceiling,
    byPath,
    peak: values.length ? Math.max(...values) : 0,
    median: percentile(values, 0.5),
    fileCount: n,
  };
}
