import type { Rect } from '@bendyline/gezel';
import { rectInView, worldToScreenX, worldToScreenY } from '../camera.js';
import {
  type StreetGeometry,
  streetPoint,
  streetSurfaceColor,
  trafficLayoutForModel,
} from '../traffic.js';
import { districtBands } from '../urbanity.js';
import type { RenderState } from './state.js';
import { roundRect, screenRect } from './util.js';

/**
 * The ground plane, painted in three passes: grass + paved district lots,
 * then the street network by road grade (the same `trafficLayoutForModel`
 * geometry the iso view draws — verges, sidewalks, carriageways, rails),
 * then curb/sidewalk edges so block outlines stay crisp over the pavement. Leaf districts (the ones actually holding files) get the
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
  const layout = trafficLayoutForModel(model);
  if (layout.streets.length === 0) return;
  const visible = layout.streets.filter((g) => rectInView(cam, g.reservation, viewW, viewH));
  const fill = (r: Rect): void => {
    const q = screenRect(cam, r);
    ctx.fillRect(q.x, q.y, q.w, q.h);
  };

  if (s.tier === 'city') {
    // lanes/alleys are sub-pixel noise at city zoom — skip them
    for (const g of visible) {
      if (g.street.tier > 1) continue;
      ctx.fillStyle = streetSurfaceColor(g, palette);
      fill(g.carriageway);
    }
    return;
  }

  const bands = districtBands(model);
  const sidewalksVisible = (g: StreetGeometry): boolean =>
    g.sidewalks !== null && g.sidewalkWidth * cam.scale >= 1.2;

  ctx.fillStyle = palette.street.verge;
  for (const g of visible) {
    const band = g.street.districtId ? bands.get(g.street.districtId) : undefined;
    if (!g.spec.verge || band === 'city') continue;
    fill(g.reservation);
  }
  ctx.fillStyle = palette.sidewalk;
  for (const g of visible) {
    if (!g.sidewalks || !sidewalksVisible(g)) continue;
    fill(g.sidewalks[0]);
    fill(g.sidewalks[1]);
  }
  // Busiest last, so an avenue is never overpainted by the lane crossing it.
  const ordered = [...visible].sort((a, b) => a.grade - b.grade || b.street.tier - a.street.tier);
  for (const g of ordered) {
    ctx.fillStyle = streetSurfaceColor(g, palette);
    fill(g.sidewalks && !sidewalksVisible(g) ? g.reservation : g.carriageway);
  }

  ctx.strokeStyle = palette.street.rail;
  ctx.beginPath();
  for (const g of visible) {
    if (!g.rails) continue;
    const pair = g.gauge * cam.scale >= 2.4;
    ctx.lineWidth = pair ? Math.max(0.7, 0.26 * cam.scale) : 1;
    const lines = pair ? g.rails : [{ a: streetPoint(g, g.a0, 0), b: streetPoint(g, g.a1, 0) }];
    for (const line of lines) {
      ctx.moveTo(worldToScreenX(cam, line.a.x), worldToScreenY(cam, line.a.y));
      ctx.lineTo(worldToScreenX(cam, line.b.x), worldToScreenY(cam, line.b.y));
    }
  }
  ctx.stroke();
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
