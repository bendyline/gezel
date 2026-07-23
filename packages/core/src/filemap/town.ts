import type { Rect } from '../schemas/api.js';
import type { CityAnchor, CityOverride, CompassRegion } from '../schemas/city-file.js';
import { assignRegions, regionCell, regionOf } from './anchors.js';
import { packLeafStrip } from './lots.js';
import { type CollapsedNode, PLATE_H, collapseFiles, plateRectFor } from './plates.js';
import { type StreetSeg, folderPad, mergeStreets, streetTier, streetWidth } from './streets.js';
import type { LayoutFileInput } from './types.js';

/**
 * The v5 "planned town" seed packer, replacing the potpack bin-packer whose
 * 95%-fill height-sorted output read as a defrag visualization. Three ideas:
 *
 * - COLUMN ("ladder") PACKING per folder: sibling boxes stand in height-
 *   balanced columns; the vertical streets between columns run the full
 *   container height and every cross-street terminates on them, so the street
 *   network is connected by construction (the UI's Dijkstra router needs no
 *   changes). Deliberate jittered slack (~0.75 fill vs 0.95) lets districts
 *   breathe and their silhouettes vary.
 *
 * - COMPASS MACRO at the root: top-level display districts land in a sparse
 *   3×3 grid steered by city-file anchors/overrides, with tier-0 boulevards
 *   spanning the whole map between occupied grid rows/columns. Re-seeds keep
 *   `packages/` where the user remembers it.
 *
 * - RESERVED GEOMETRY for labels and open space: every display district's
 *   plate (PLATE_H headroom) and every landmark plaza / leftover green is a
 *   first-class rect the incremental engine treats as occupied.
 */

export interface TownPlate {
  folder: string;
  rect: Rect;
}

export interface TownPlaza {
  id: string;
  folder: string;
  rect: Rect;
  kind: 'plaza' | 'green';
  blockId?: string;
}

export interface TownResult {
  w: number;
  h: number;
  lots: Map<string, { lot: Rect; foot: Rect }>;
  streets: StreetSeg[];
  plates: TownPlate[];
  plazas: TownPlaza[];
}

export interface TownRootResult extends TownResult {
  anchors: CityAnchor[];
}

const MAX_COLUMNS = 6;
/** Leftover column bottoms at least this tall become greens. */
const MIN_GREEN_H = 8;
const MIN_GREEN_W = 10;

interface TownBox {
  /** Stable sort key: the child folder path, or `${path}//files` for strips. */
  key: string;
  w: number;
  h: number;
  child?: CollapsedNode;
  pad?: number;
  inner?: TownResult;
  files?: LayoutFileInput[];
}

function emptyResult(): TownResult {
  return { w: 0, h: 0, lots: new Map(), streets: [], plates: [], plazas: [] };
}

function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

/** Merge `inner` into `into`, offset by (dx, dy). */
function mergeInto(into: TownResult, inner: TownResult, dx: number, dy: number): void {
  for (const [path, cell] of inner.lots) {
    into.lots.set(path, { lot: offsetRect(cell.lot, dx, dy), foot: offsetRect(cell.foot, dx, dy) });
  }
  for (const s of inner.streets) {
    into.streets.push({ rect: offsetRect(s.rect, dx, dy), tier: s.tier, folder: s.folder });
  }
  for (const p of inner.plates)
    into.plates.push({ folder: p.folder, rect: offsetRect(p.rect, dx, dy) });
  for (const p of inner.plazas) into.plazas.push({ ...p, rect: offsetRect(p.rect, dx, dy) });
}

/** Pack a strip box's files at a given width, mutating the box dims. */
function packStripBox(box: TownBox, targetW: number | undefined, folder: string): TownResult {
  const strip = packLeafStrip(box.files!, targetW !== undefined ? { targetW } : {});
  const out = emptyResult();
  out.w = strip.w;
  out.h = strip.h;
  for (const sl of strip.lots) out.lots.set(sl.path, { lot: sl.lot, foot: sl.foot });
  for (const lane of strip.lanes) out.streets.push({ rect: lane, tier: 3, folder });
  for (const pz of strip.plazas) {
    out.plazas.push({
      id: `plaza:${pz.path}`,
      folder,
      rect: pz.rect,
      kind: 'plaza',
      blockId: pz.path,
    });
  }
  box.w = strip.w;
  box.h = strip.h;
  return out;
}

/** Greedy LPT height balancing: tallest first into the shortest column. */
function assignToColumns(boxes: TownBox[], k: number): TownBox[][] {
  const sorted = [...boxes].sort((a, b) => b.h - a.h || (a.key < b.key ? -1 : 1));
  const cols: TownBox[][] = Array.from({ length: k }, () => []);
  const heights = new Array<number>(k).fill(0);
  for (const box of sorted) {
    let best = 0;
    for (let i = 1; i < k; i++) if (heights[i]! < heights[best]!) best = i;
    cols[best]!.push(box);
    heights[best]! += box.h;
  }
  // Path order top-to-bottom within a column (not height order).
  for (const col of cols) col.sort((a, b) => (a.key < b.key ? -1 : 1));
  return cols;
}

/**
 * Column-pack sibling boxes for `nodePath` at `depth`. The container's
 * street tier/gap comes from the depth; strips are re-packed to their
 * column's width so parcel rows fill wall-to-wall.
 */
function packColumns(nodePath: string, boxes: TownBox[], depth: number): TownResult {
  const out = emptyResult();
  if (boxes.length === 0) return out;
  const gap = streetWidth(depth);
  const tier = streetTier(depth);

  // Choose the column count whose balanced result is closest to square.
  let bestCols: TownBox[][] = [boxes];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let k = 1; k <= Math.min(MAX_COLUMNS, boxes.length); k++) {
    const cols = assignToColumns(boxes, k);
    let w = gap * (k - 1);
    let h = 0;
    for (const col of cols) {
      w += Math.max(...col.map((b) => b.w));
      h = Math.max(h, col.reduce((s, b) => s + b.h, 0) + gap * (col.length - 1));
    }
    const score = Math.abs(Math.log(w / Math.max(1e-6, h)));
    if (score < bestScore - 1e-9) {
      bestScore = score;
      bestCols = cols;
    }
  }

  // Column width = content max, NO horizontal slack: boxes sit flush against
  // their flanking trunks, so interior street networks stay within a folder
  // pad (≤5) of a parent street — the router's 20-unit bridge is never
  // stacked across nesting levels. Breathing comes from greens (column
  // height leftovers) and height variance instead.
  const colWidths = bestCols.map((col) => Math.max(...col.map((b) => b.w)));

  // Re-pack strips to their column width (may change box heights), then
  // re-derive the width so a strip forced wider than the column still fits.
  const innerByBox = new Map<TownBox, TownResult>();
  for (let i = 0; i < bestCols.length; i++) {
    for (const box of bestCols[i]!) {
      if (box.files) innerByBox.set(box, packStripBox(box, colWidths[i], nodePath));
    }
    colWidths[i] = Math.max(...bestCols[i]!.map((b) => b.w));
  }

  const colHeights = bestCols.map(
    (col) => col.reduce((s, b) => s + b.h, 0) + gap * (col.length - 1),
  );
  const containerH = Math.max(...colHeights);
  const totalW = colWidths.reduce((s, w) => s + w, 0) + gap * (bestCols.length - 1);

  const streets: StreetSeg[] = [];
  let x = 0;
  for (let i = 0; i < bestCols.length; i++) {
    if (i > 0) {
      // Vertical trunk between columns: full container height.
      streets.push({ rect: { x, y: 0, w: gap, h: containerH }, tier, folder: nodePath });
      x += gap;
    }
    const colW = colWidths[i]!;
    let y = 0;
    const col = bestCols[i]!;
    for (let j = 0; j < col.length; j++) {
      const box = col[j]!;
      if (j > 0) {
        // Cross-street spanning the column PLUS both flanking trunks, so it
        // always terminates on a vertical street (connected by construction).
        const cx = Math.max(0, x - gap);
        const cw = Math.min(totalW, x + colW + gap) - cx;
        streets.push({ rect: { x: cx, y, w: cw, h: gap }, tier, folder: nodePath });
        y += gap;
      }
      if (box.child && box.inner !== undefined && box.pad !== undefined) {
        const pad = box.pad;
        out.plates.push({
          folder: box.child.path,
          rect: plateRectFor(box.child.label, x + pad, y + pad, box.w - pad * 2),
        });
        mergeInto(out, box.inner, x + pad, y + pad + PLATE_H);
      } else if (box.files) {
        mergeInto(out, innerByBox.get(box) ?? emptyResult(), x, y);
      }
      y += box.h;
    }
    // Leftover column bottom becomes a green so slack reads as parkland.
    const leftover = containerH - y;
    if (leftover >= MIN_GREEN_H && colW >= MIN_GREEN_W) {
      out.plazas.push({
        id: `green:${nodePath}:${i}`,
        folder: nodePath,
        rect: {
          x,
          y: y + Math.min(gap, leftover) / 2,
          w: colW,
          h: leftover - Math.min(gap, leftover) / 2,
        },
        kind: 'green',
      });
    }
    x += colW;
  }

  out.w = totalW;
  out.h = containerH;
  out.streets = [...mergeStreets(streets), ...out.streets];
  return out;
}

/** Build the sibling boxes for one collapsed folder node. */
function boxesFor(node: CollapsedNode, depth: number): TownBox[] {
  const boxes: TownBox[] = [];
  for (const child of node.children) {
    const inner = packTownNode(child, depth + 1);
    const pad = folderPad(depth + 1);
    boxes.push({
      key: child.path,
      w: inner.w + pad * 2,
      h: inner.h + pad * 2 + PLATE_H,
      child,
      pad,
      inner,
    });
  }
  if (node.files.length > 0) {
    // Sized here for column selection; re-packed to the column width later.
    const probe = packLeafStrip(node.files);
    boxes.push({ key: `${node.path}//files`, w: probe.w, h: probe.h, files: node.files });
  }
  return boxes;
}

/** Pack one collapsed folder (children + direct files) at `depth`. */
export function packTownNode(node: CollapsedNode, depth: number): TownResult {
  return packColumns(node.path, boxesFor(node, depth), depth);
}

/** Pack a wholly-new subtree (incremental folder arrival) at `folderDepth`. */
export function packTownSubtree(files: LayoutFileInput[], folderDepth: number): TownResult {
  const depth = Math.max(0, folderDepth - 1);
  return packTownNode(collapseFiles(files), depth);
}

export interface TownRootOptions {
  anchors?: CityAnchor[];
  overrides?: CityOverride[];
  nowIso: string;
}

/**
 * Seed the whole city: top-level display districts into the sparse compass
 * grid, boulevards between occupied grid rows/columns, anchors recorded.
 */
export function packTownRoot(files: LayoutFileInput[], options: TownRootOptions): TownRootResult {
  const root = collapseFiles(files);
  const boxes = boxesFor(root, 0);
  const out: TownRootResult = { ...emptyResult(), anchors: [] };
  if (boxes.length === 0) return out;

  const anchors = options.anchors ?? [];
  const overrides = options.overrides ?? [];
  const rectOverride = new Map(
    overrides.filter((o) => o.rect && !o.path.includes('/')).map((o) => [o.path, o.rect!]),
  );

  // Rect-pinned boxes bypass the grid entirely; everything else gets a region.
  const gridBoxes = boxes.filter((b) => !(b.child && rectOverride.has(b.child.path)));
  const pinnedBoxes = boxes.filter((b) => b.child && rectOverride.has(b.child.path));
  const regionByPath = assignRegions(
    gridBoxes.map((b) => ({ path: b.child?.path ?? b.key, area: b.w * b.h })),
    anchors,
    overrides,
  );

  // Sparse 3×3: only rows/columns that actually host content materialize.
  const cellBoxes = new Map<string, TownBox[]>();
  for (const b of gridBoxes) {
    const region = regionByPath.get(b.child?.path ?? b.key) ?? 'C';
    const { row, col } = regionCell(region);
    const key = `${row}:${col}`;
    const arr = cellBoxes.get(key);
    if (arr) arr.push(b);
    else cellBoxes.set(key, [b]);
  }
  const occupiedRows = [
    ...new Set([...cellBoxes.keys()].map((k) => Number(k.split(':')[0]))),
  ].sort();
  const occupiedCols = [
    ...new Set([...cellBoxes.keys()].map((k) => Number(k.split(':')[1]))),
  ].sort();

  // Pack each occupied cell (multi-box cells column-pack at depth 0).
  const cellResults = new Map<string, TownResult>();
  for (const [key, list] of cellBoxes) {
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
    cellResults.set(key, packColumns('', list, 0));
  }

  const B = streetWidth(0);
  const colW = occupiedCols.map((c) =>
    Math.max(...occupiedRows.map((r) => cellResults.get(`${r}:${c}`)?.w ?? 0)),
  );
  const rowH = occupiedRows.map((r) =>
    Math.max(...occupiedCols.map((c) => cellResults.get(`${r}:${c}`)?.h ?? 0)),
  );
  const totalW = colW.reduce((s, w) => s + w, 0) + B * Math.max(0, occupiedCols.length - 1);
  const totalH = rowH.reduce((s, h) => s + h, 0) + B * Math.max(0, occupiedRows.length - 1);

  const streets: StreetSeg[] = [];
  const xOf: number[] = [];
  {
    let x = 0;
    for (let i = 0; i < occupiedCols.length; i++) {
      if (i > 0) {
        streets.push({ rect: { x, y: 0, w: B, h: totalH }, tier: 0, folder: '' });
        x += B;
      }
      xOf.push(x);
      x += colW[i]!;
    }
  }
  const yOf: number[] = [];
  {
    let y = 0;
    for (let i = 0; i < occupiedRows.length; i++) {
      if (i > 0) {
        streets.push({ rect: { x: 0, y, w: totalW, h: B }, tier: 0, folder: '' });
        y += B;
      }
      yOf.push(y);
      y += rowH[i]!;
    }
  }

  // Every cell must TOUCH a boulevard so its street network bridges onto the
  // city's: first-column cells right-align toward the boulevard beside them,
  // first-row cells bottom-align; all others already touch at their top/left.
  for (const [key, cell] of cellResults) {
    const [row, col] = key.split(':').map(Number) as [number, number];
    const ci = occupiedCols.indexOf(col);
    const ri = occupiedRows.indexOf(row);
    const alignX = ci === 0 && occupiedCols.length > 1 ? colW[ci]! - cell.w : 0;
    const alignY = ri === 0 && occupiedRows.length > 1 ? rowH[ri]! - cell.h : 0;
    mergeInto(out, cell, xOf[ci]! + alignX, yOf[ri]! + alignY);
  }

  out.w = totalW;
  out.h = totalH;

  // Rect-pinned boxes: exact placement, extending the bounds as needed. The
  // user owns collision avoidance for hand-pinned coordinates.
  for (const box of pinnedBoxes) {
    const rect = rectOverride.get(box.child!.path)!;
    const pad = box.pad!;
    out.plates.push({
      folder: box.child!.path,
      rect: plateRectFor(box.child!.label, rect.x + pad, rect.y + pad, box.w - pad * 2),
    });
    mergeInto(out, box.inner!, rect.x + pad, rect.y + pad + PLATE_H);
    out.w = Math.max(out.w, rect.x + box.w);
    out.h = Math.max(out.h, rect.y + box.h);
  }

  out.streets = [...mergeStreets(streets), ...out.streets];

  // Record anchors: echo existing ones verbatim; new top-level districts get
  // their region + normalized centroid from the final geometry.
  const anchorByPath = new Map(anchors.map((a) => [a.path, a]));
  const centroidOf = (folder: string): { cx: number; cy: number } | null => {
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    const prefix = `${folder}/`;
    for (const [path, cell] of out.lots) {
      if (!path.startsWith(prefix)) continue;
      sumX += cell.lot.x + cell.lot.w / 2;
      sumY += cell.lot.y + cell.lot.h / 2;
      n += 1;
    }
    if (n === 0) return null;
    return {
      cx: Math.min(1, Math.max(0, sumX / n / Math.max(1e-6, out.w))),
      cy: Math.min(1, Math.max(0, sumY / n / Math.max(1e-6, out.h))),
    };
  };
  for (const child of root.children) {
    const topSegment = child.path.split('/')[0]!;
    const existing = anchorByPath.get(topSegment) ?? anchorByPath.get(child.path);
    if (existing) {
      out.anchors.push(existing);
      continue;
    }
    const c = centroidOf(child.path);
    if (!c) continue;
    const region: CompassRegion = regionByPath.get(child.path) ?? regionOf(c.cx, c.cy);
    out.anchors.push({
      path: child.path,
      region,
      cx: c.cx,
      cy: c.cy,
      recordedAt: options.nowIso,
    });
  }
  out.anchors.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}
