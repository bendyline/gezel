import type { MapStreet, Rect } from '../schemas/api.js';

/**
 * Streets — the gaps the packer leaves between sibling boxes, materialized as
 * first-class rects so the renderer can pave them and incremental placement
 * can avoid building on them. Widths are hierarchical (CodeCity-style): wide
 * avenues between top-level packages, narrowing to alleys deep in the tree.
 */

/** tier 0..3: avenue, street, lane, alley. */
export const STREET_WIDTHS = [16, 10, 6, 4] as const;

export type StreetTier = 0 | 1 | 2 | 3;

export function streetTier(depth: number): StreetTier {
  return Math.max(0, Math.min(3, depth)) as StreetTier;
}

export function streetWidth(depth: number): number {
  return STREET_WIDTHS[streetTier(depth)];
}

/** Interior perimeter padding of a folder box (half the next tier's street). */
export function folderPad(depth: number): number {
  return Math.max(4, Math.ceil(streetWidth(depth + 1) / 2));
}

/** A street segment in some container's local coordinates. */
export interface StreetSeg {
  rect: Rect;
  tier: StreetTier;
  /** Folder whose interior this street runs through ('' = the map root). */
  folder: string;
}

function clipTo(r: Rect, w: number, h: number): Rect | null {
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(w, r.x + r.w);
  const y2 = Math.min(h, r.y + r.h);
  if (x2 - x1 < 0.5 || y2 - y1 < 0.5) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Materialize the right/bottom gap strip of every packed box as street segs,
 * clipped to the container (the packer trims trailing gaps off its bbox).
 */
export function extractStreets(
  boxes: Rect[],
  container: { w: number; h: number },
  gap: number,
  tier: StreetTier,
  folder: string,
): StreetSeg[] {
  const segs: StreetSeg[] = [];
  for (const b of boxes) {
    const right = clipTo({ x: b.x + b.w, y: b.y, w: gap, h: b.h + gap }, container.w, container.h);
    const bottom = clipTo({ x: b.x, y: b.y + b.h, w: b.w + gap, h: gap }, container.w, container.h);
    if (right) segs.push({ rect: right, tier, folder });
    if (bottom) segs.push({ rect: bottom, tier, folder });
  }
  return mergeStreets(segs);
}

/**
 * Merge collinear strips (same row/column, touching or overlapping ranges) so
 * streets read as continuous runs instead of per-box stubs. Best-effort: an
 * unmerged pair just paints the same pavement twice.
 */
export function mergeStreets(segs: StreetSeg[]): StreetSeg[] {
  const out: StreetSeg[] = [];
  const horizontal = segs.filter((s) => s.rect.w >= s.rect.h);
  const vertical = segs.filter((s) => s.rect.w < s.rect.h);

  const mergeAxis = (
    list: StreetSeg[],
    lanePos: (r: Rect) => number,
    laneSize: (r: Rect) => number,
    start: (r: Rect) => number,
    length: (r: Rect) => number,
    make: (lane: number, size: number, from: number, len: number, proto: StreetSeg) => StreetSeg,
  ): void => {
    const groups = new Map<string, StreetSeg[]>();
    for (const s of list) {
      const key = `${s.folder}|${s.tier}|${lanePos(s.rect)}|${laneSize(s.rect)}`;
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => start(a.rect) - start(b.rect));
      let cur = group[0]!;
      let from = start(cur.rect);
      let to = from + length(cur.rect);
      for (let i = 1; i < group.length; i++) {
        const s = group[i]!;
        const s0 = start(s.rect);
        const s1 = s0 + length(s.rect);
        if (s0 <= to + 0.5) {
          to = Math.max(to, s1);
        } else {
          out.push(make(lanePos(cur.rect), laneSize(cur.rect), from, to - from, cur));
          cur = s;
          from = s0;
          to = s1;
        }
      }
      out.push(make(lanePos(cur.rect), laneSize(cur.rect), from, to - from, cur));
    }
  };

  mergeAxis(
    horizontal,
    (r) => r.y,
    (r) => r.h,
    (r) => r.x,
    (r) => r.w,
    (lane, size, from, len, proto) => ({
      rect: { x: from, y: lane, w: len, h: size },
      tier: proto.tier,
      folder: proto.folder,
    }),
  );
  mergeAxis(
    vertical,
    (r) => r.x,
    (r) => r.w,
    (r) => r.y,
    (r) => r.h,
    (lane, size, from, len, proto) => ({
      rect: { x: lane, y: from, w: size, h: len },
      tier: proto.tier,
      folder: proto.folder,
    }),
  );
  return out;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Stable, geometry-derived street id (streets have no natural name). */
export function streetId(seg: StreetSeg): string {
  const { x, y, w, h } = seg.rect;
  return `st:${seg.folder}:${r1(x)},${r1(y)},${r1(w)},${r1(h)}`;
}

export function toMapStreet(seg: StreetSeg): MapStreet {
  return {
    id: streetId(seg),
    rect: seg.rect,
    tier: seg.tier,
    districtId: seg.folder === '' ? null : seg.folder,
  };
}
