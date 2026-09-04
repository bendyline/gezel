import type { Rect } from '@bendyline/gezel';
import { type Camera, clampScale } from '../camera.js';

/**
 * Classic 2:1 dimetric projection, split into two linear maps so the existing
 * `Camera` (pan + zoom-around-cursor) survives verbatim — it simply operates
 * over iso-plane coordinates (u, v) instead of world coordinates:
 *
 *   world plan → iso plane:  u = x − y        v = (x + y) / 2
 *   iso plane → screen:      the unchanged camera.ts transforms
 *
 * A world square of side s projects to a 2s×s diamond. A point at height z
 * (world units) renders at (u, v − z·HZ). All tuning constants live here.
 */

/** Iso-v units per world height unit. */
export const HZ = 0.6;
/** World height units per storey. */
export const LEVEL_H = 3;

export interface IsoPoint {
  u: number;
  v: number;
}

export function isoU(x: number, y: number): number {
  return x - y;
}

export function isoV(x: number, y: number): number {
  return (x + y) / 2;
}

export function toIso(x: number, y: number): IsoPoint {
  return { u: x - y, v: (x + y) / 2 };
}

/** Ground-plane inverse. */
export function fromIso(u: number, v: number): { x: number; y: number } {
  return { x: v + u / 2, y: v - u / 2 };
}

/** The world height (z) of a block with `levels` storeys. */
export function heightOf(levels: number): number {
  return levels * LEVEL_H;
}

/** Iso height of the paved podium a symbol-carrying file stands on. */
export const PODIUM_HISO = LEVEL_H * HZ * 0.6;

/** Iso height of a symbol mini-building from its wire height (absolute
 *  [0,1] scale) — ~0.2 storeys for a floor-height shed up to 2 for a giant.
 *  Shared by the draw pass and the hover hit test so they never drift. */
export function miniHIso(height: number): number {
  return (0.5 + height * 4.5) * LEVEL_H * HZ * 0.4;
}

/** Exact iso-plane rise used by the period roof renderer. Keeping this in the
 * projection layer lets drawing, picking, and tooltip anchors share the same
 * silhouette even though the roof is capped in screen pixels at close zoom. */
export function townRoofRiseIso(r: Rect, scale: number, compact = false): number {
  const safeScale = Math.max(0.001, scale);
  const topSpanPx = (r.w + r.h) * safeScale;
  // The compact ceiling is for symbol minis. A 13px / 0.13 pitch still read as
  // a modern bungalow roof once an entire symbol campus was fit on screen.
  // Edwardian cottages and workshops need the roof to own the silhouette, so
  // both forms now approach a visually steeper 8:12-ish pitch. The cap keeps a
  // close-zoom roof from swallowing its facade.
  const risePx = Math.max(compact ? 2 : 3, Math.min(compact ? 16 : 20, topSpanPx * 0.17));
  return risePx / safeScale;
}

/** Projected corners of a footprint rect: N(x,y) E(x+w,y) S(x+w,y+h) W(x,y+h). */
export interface IsoCorners {
  n: IsoPoint;
  e: IsoPoint;
  s: IsoPoint;
  w: IsoPoint;
}

export function isoCorners(r: Rect): IsoCorners {
  return {
    n: toIso(r.x, r.y),
    e: toIso(r.x + r.w, r.y),
    s: toIso(r.x + r.w, r.y + r.h),
    w: toIso(r.x, r.y + r.h),
  };
}

/** Cheap iso-AABB cull for a ground rect (no height) against the viewport. */
export function groundRectInView(cam: Camera, r: Rect, viewW: number, viewH: number): boolean {
  const u0 = (r.x - (r.y + r.h) - cam.offsetX) * cam.scale;
  const u1 = (r.x + r.w - r.y - cam.offsetX) * cam.scale;
  const v0 = ((r.x + r.y) / 2 - cam.offsetY) * cam.scale;
  const v1 = ((r.x + r.w + r.y + r.h) / 2 - cam.offsetY) * cam.scale;
  return u1 >= 0 && v1 >= 0 && u0 <= viewW && v0 <= viewH;
}

/** Iso-plane AABB of a rect extruded by iso height `hIso` (≥ 0). */
export interface IsoAabb {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export function isoAabb(r: Rect, hIso: number): IsoAabb {
  return {
    u0: r.x - (r.y + r.h),
    u1: r.x + r.w - r.y,
    v0: (r.x + r.y) / 2 - hIso,
    v1: (r.x + r.w + r.y + r.h) / 2,
  };
}

/**
 * Exact prism hit test in iso coordinates: the cursor's iso point (u, v) hits
 * a prism (footprint `r`, iso height `hIso`) iff some dz ∈ [0, hIso] puts the
 * ground point (u, v + dz) inside `r`. x and y are linear in dz, so this is a
 * three-interval intersection — it matches the prism's screen silhouette
 * exactly (clicking a tall building's upper floors selects it).
 */
export function hitsPrism(u: number, v: number, r: Rect, hIso: number): boolean {
  const lo = Math.max(0, r.x - u / 2 - v, r.y + u / 2 - v);
  const hi = Math.min(hIso, r.x + r.w - u / 2 - v, r.y + r.h + u / 2 - v);
  return lo <= hi;
}

/**
 * Fit the camera to a world bounds rect (plus prism headroom) in iso space —
 * projects the four corners, extends v-min upward by the tallest prism, and
 * centers exactly like the flat `fitToBounds`.
 */
export function fitToBoundsIso(
  bounds: Rect,
  maxHIso: number,
  viewW: number,
  viewH: number,
  pad = 32,
): Camera {
  if (bounds.w <= 0 || bounds.h <= 0 || viewW <= 0 || viewH <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const box = isoAabb(bounds, maxHIso);
  const w = box.u1 - box.u0;
  const h = box.v1 - box.v0;
  const scale = clampScale(Math.min((viewW - pad * 2) / w, (viewH - pad * 2) / h));
  const cu = box.u0 + w / 2;
  const cv = box.v0 + h / 2;
  return {
    scale,
    offsetX: cu - viewW / 2 / scale,
    offsetY: cv - viewH / 2 / scale,
  };
}
