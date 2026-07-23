import { rectInView } from '../camera.js';
import type { RenderState } from './state.js';
import { roundRect, screenRect } from './util.js';

/**
 * The ground plane, painted in three passes: grass + paved district lots,
 * then the street network (avenues → alleys by tier — lanes cut through the
 * district paving), then curb/sidewalk edges so block outlines stay crisp
 * over the pavement. Leaf districts (the ones actually holding files) get the
 * paved-lot + curb treatment; ancestors stay a faint outline so the folder
 * hierarchy reads without stacking fills.
 */
export function drawGround(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { model, palette, viewW, viewH } = s;

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, viewW, viewH);

  // model.districts is depth-sorted, so parents paint under children
  const parentIds = new Set<string>();
  for (const d of model.districts) if (d.parentId) parentIds.add(d.parentId);

  drawDistrictFills(ctx, s, parentIds);
  drawStreets(ctx, s);
  drawDistrictEdges(ctx, s, parentIds);
}

function drawDistrictFills(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  parentIds: Set<string>,
): void {
  const { cam, model, palette, viewW, viewH } = s;
  ctx.fillStyle = palette.districtFill;
  for (const d of model.districts) {
    if (parentIds.has(d.id)) continue;
    if (!rectInView(cam, d.rect, viewW, viewH)) continue;
    const { x, y, w, h } = screenRect(cam, d.rect);
    if (w < 6 || h < 6) continue;
    ctx.globalAlpha = 0.9;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawStreets(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { cam, model, palette, viewW, viewH } = s;
  const streets = model.streets;
  if (!streets || streets.length === 0) return;

  const pavement = [
    palette.pavementAvenue,
    palette.pavementStreet,
    palette.pavementLane,
    palette.pavementLane,
  ];
  for (let tier = 0; tier < 4; tier++) {
    // lanes/alleys are sub-pixel noise at city zoom — skip them
    if (s.tier === 'city' && tier > 1) break;
    ctx.fillStyle = pavement[tier]!;
    for (const st of streets) {
      if (st.tier !== tier) continue;
      if (!rectInView(cam, st.rect, viewW, viewH)) continue;
      const r = screenRect(cam, st.rect);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  // avenue center dashes, along the long axis
  if (s.tier !== 'city') {
    ctx.strokeStyle = palette.avenueDash;
    ctx.lineWidth = Math.max(1, Math.min(2, 0.8 * cam.scale));
    ctx.setLineDash([6 * cam.scale, 6 * cam.scale]);
    ctx.beginPath();
    for (const st of streets) {
      if (st.tier !== 0) continue;
      if (!rectInView(cam, st.rect, viewW, viewH)) continue;
      const r = screenRect(cam, st.rect);
      if (r.w >= r.h) {
        const cy = r.y + r.h / 2;
        ctx.moveTo(r.x + 2, cy);
        ctx.lineTo(r.x + r.w - 2, cy);
      } else {
        const cx = r.x + r.w / 2;
        ctx.moveTo(cx, r.y + 2);
        ctx.lineTo(cx, r.y + r.h - 2);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawDistrictEdges(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  parentIds: Set<string>,
): void {
  const { cam, model, palette, tier, viewW, viewH } = s;
  for (const d of model.districts) {
    if (!rectInView(cam, d.rect, viewW, viewH)) continue;
    const { x, y, w, h } = screenRect(cam, d.rect);
    if (w < 6 || h < 6) continue;
    if (!parentIds.has(d.id)) {
      if (tier !== 'city' && w > 18 && h > 18) {
        // sidewalk band just inside the curb, then the curb on the block edge
        ctx.strokeStyle = palette.sidewalk;
        ctx.lineWidth = 3;
        roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 5);
        ctx.stroke();
      }
      ctx.strokeStyle = palette.curb;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, 6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = palette.districtStroke;
      ctx.lineWidth = Math.max(0.5, Math.min(2, 3 - d.depth * 0.4));
      roundRect(ctx, x, y, w, h, 6);
      ctx.stroke();
    }
  }
}
