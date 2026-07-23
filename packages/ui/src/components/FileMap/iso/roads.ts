import type { Rect } from '@bendyline/gezel';
import { routedRoadsFor } from '../draw/roads-router.js';
import { toIso } from './projection.js';
import { type IsoRenderState, sp } from './state.js';

/**
 * Import roads in iso. The v2 ambient every-edge layer is GONE — a thousand
 * translucent ribbons crossing districts was pure noise. Roads render only:
 * - selected block: street-following Dijkstra routes (world polylines from
 *   the shared roads-router, vertices projected to iso);
 * - hovered block: its direct incident edges, faint, capped.
 */

const HOVER_EDGE_CAP = 40;

export function drawIsoRoads(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette } = s;
  if (s.tier === 'city' || model.roads.length === 0) return;

  const rectById = new Map<string, Rect>();
  for (const b of model.blocks) rectById.set(b.id, b.rect);

  if (s.selectedId) {
    const routed = routedRoadsFor(model, s.selectedId, rectById);
    ctx.strokeStyle = palette.selected;
    ctx.globalAlpha = 0.9;
    ctx.lineJoin = 'round';
    if (routed) {
      for (const road of routed) {
        if (road.points.length < 2) continue;
        ctx.lineWidth = road.bidirectional ? 2.4 : 2;
        ctx.beginPath();
        for (let i = 0; i < road.points.length; i++) {
          const pt = road.points[i]!;
          const iso = toIso(pt.x, pt.y);
          const scr = sp(cam, iso.u, iso.v);
          if (i === 0) ctx.moveTo(scr.x, scr.y);
          else ctx.lineTo(scr.x, scr.y);
        }
        ctx.stroke();
      }
    } else {
      drawDirectEdges(ctx, s, s.selectedId, rectById, 2, 0.9);
    }
    ctx.globalAlpha = 1;
  }

  if (s.hoverId && s.hoverId !== s.selectedId) {
    drawDirectEdges(ctx, s, s.hoverId, rectById, 1.5, 0.35);
  }
}

function drawDirectEdges(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  id: string,
  rectById: Map<string, Rect>,
  width: number,
  alpha: number,
): void {
  const { cam, model, palette } = s;
  ctx.strokeStyle = palette.selected;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  let drawn = 0;
  ctx.beginPath();
  for (const r of model.roads) {
    if (r.a !== id && r.b !== id) continue;
    if (drawn >= HOVER_EDGE_CAP) break;
    const ra = rectById.get(r.a);
    const rb = rectById.get(r.b);
    if (!ra || !rb) continue;
    const a = toIso(ra.x + ra.w / 2, ra.y + ra.h / 2);
    const b = toIso(rb.x + rb.w / 2, rb.y + rb.h / 2);
    const pa = sp(cam, a.u, a.v);
    const pb = sp(cam, b.u, b.v);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    drawn += 1;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}
