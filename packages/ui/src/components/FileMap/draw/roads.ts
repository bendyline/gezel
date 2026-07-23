import type { Rect } from '@bendyline/gezel';
import { worldToScreenX, worldToScreenY } from '../camera.js';
import { type RoutedRoad, routedRoadsFor } from './roads-router.js';
import type { RenderState } from './state.js';

export type RoadLayer = 'under' | 'selected';

export interface RoadPoint {
  x: number;
  y: number;
}

/**
 * Manhattan L-route between two blocks in world coords: leave `a`'s edge,
 * one right-angle bend, arrive at `b`'s edge. Horizontal-first when the
 * horizontal separation dominates. Degenerates to a straight 2-point segment
 * when the centers are (nearly) axis-aligned.
 */
export function routeRoad(a: Rect, b: Rect): RoadPoint[] {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
    return [
      { x: ax, y: ay },
      { x: bx, y: by },
    ];
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    // leave a's left/right edge, bend above/below b, arrive at b's top/bottom
    const startX = dx > 0 ? a.x + a.w : a.x;
    const endY = dy > 0 ? b.y : b.y + b.h;
    return [
      { x: startX, y: ay },
      { x: bx, y: ay },
      { x: bx, y: endY },
    ];
  }
  const startY = dy > 0 ? a.y + a.h : a.y;
  const endX = dx > 0 ? b.x : b.x + b.w;
  return [
    { x: ax, y: startY },
    { x: ax, y: by },
    { x: endX, y: by },
  ];
}

/**
 * Import-edge ribbons. The `under` layer paints every road beneath the
 * buildings as ambient texture; the `selected` layer repaints the selected
 * block's incident roads on top at full strength — that's where imports
 * actually get read.
 */
export function drawRoads(ctx: CanvasRenderingContext2D, s: RenderState, layer: RoadLayer): void {
  const { cam, model, palette, tier, viewW, viewH } = s;
  if (tier === 'city' || model.roads.length === 0) return;
  if (layer === 'selected' && !s.selectedId) return;

  const rectById = new Map<string, Rect>();
  for (const b of model.blocks) rectById.set(b.id, b.rect);

  // The highlighted roads follow the street grid so they don't cut across
  // buildings. Falls through to straight L-routes only on pre-street payloads.
  if (layer === 'selected' && s.selectedId) {
    const routed = routedRoadsFor(model, s.selectedId, rectById);
    if (routed) {
      drawRoutedRoads(ctx, s, routed);
      return;
    }
  }

  const bend = Math.max(2, Math.min(8, 4 * cam.scale));
  for (const r of model.roads) {
    if (layer === 'selected' && r.a !== s.selectedId && r.b !== s.selectedId) continue;
    const ra = rectById.get(r.a);
    const rb = rectById.get(r.b);
    if (!ra || !rb) continue;
    const pts = routeRoad(ra, rb).map((p) => ({
      x: worldToScreenX(cam, p.x),
      y: worldToScreenY(cam, p.y),
    }));
    // cheap off-screen cull on the polyline bbox
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX < 0 || maxY < 0 || minX > viewW || minY > viewH) continue;

    if (layer === 'selected') {
      ctx.strokeStyle = palette.selected;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = r.bidirectional ? palette.roadMutual : palette.road;
      ctx.globalAlpha = 0.25 + 0.2 * Math.min(1, r.affinity);
      ctx.lineWidth = r.bidirectional ? 1.5 : 1;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1]!.x, pts[1]!.y);
    } else {
      ctx.arcTo(pts[1]!.x, pts[1]!.y, pts[2]!.x, pts[2]!.y, bend);
      ctx.lineTo(pts[2]!.x, pts[2]!.y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Stroke the street-routed selected roads (world-space polylines). */
function drawRoutedRoads(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  routed: RoutedRoad[],
): void {
  const { cam, palette, viewW, viewH } = s;
  const radius = Math.max(2, Math.min(6, 3 * cam.scale));
  ctx.strokeStyle = palette.selected;
  ctx.globalAlpha = 0.9;
  ctx.lineJoin = 'round';
  for (const road of routed) {
    if (road.points.length < 2) continue;
    const pts = road.points.map((p) => ({
      x: worldToScreenX(cam, p.x),
      y: worldToScreenY(cam, p.y),
    }));
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX < 0 || maxY < 0 || minX > viewW || minY > viewH) continue;

    ctx.lineWidth = road.bidirectional ? 2.4 : 2;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.arcTo(pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y, radius);
    }
    ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
