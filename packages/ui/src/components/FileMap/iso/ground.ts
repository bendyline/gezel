import type { Rect } from '@bendyline/gezel';
import type { Camera } from '../camera.js';
import { isoCorners } from './projection.js';
import { type IsoRenderState, sp } from './state.js';

/**
 * The iso ground plane: grass, district paving diamonds, plazas/greens,
 * then the street network as projected parallelograms (tier 0 → 3), curbs on
 * leaf districts, avenue center dashes. Sharp corners throughout — rounded
 * rects become elliptical arcs in iso, and sharp is the SimCity idiom.
 */

function pathDiamond(ctx: CanvasRenderingContext2D, cam: Camera, r: Rect): void {
  const c = isoCorners(r);
  const n = sp(cam, c.n.u, c.n.v);
  const e = sp(cam, c.e.u, c.e.v);
  const s = sp(cam, c.s.u, c.s.v);
  const w = sp(cam, c.w.u, c.w.v);
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(e.x, e.y);
  ctx.lineTo(s.x, s.y);
  ctx.lineTo(w.x, w.y);
  ctx.closePath();
}

/** Cheap iso-AABB cull for ground rects (no height). */
function groundInView(cam: Camera, r: Rect, viewW: number, viewH: number): boolean {
  const u0 = (r.x - (r.y + r.h) - cam.offsetX) * cam.scale;
  const u1 = (r.x + r.w - r.y - cam.offsetX) * cam.scale;
  const v0 = ((r.x + r.y) / 2 - cam.offsetY) * cam.scale;
  const v1 = ((r.x + r.w + r.y + r.h) / 2 - cam.offsetY) * cam.scale;
  return u1 >= 0 && v1 >= 0 && u0 <= viewW && v0 <= viewH;
}

export function drawIsoGround(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette, viewW, viewH } = s;

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, viewW, viewH);

  const parentIds = new Set<string>();
  for (const d of model.districts) if (d.parentId) parentIds.add(d.parentId);

  // District paving: leaf districts filled, ancestors as faint outlines.
  for (const d of model.districts) {
    if (!groundInView(cam, d.rect, viewW, viewH)) continue;
    if (parentIds.has(d.id)) {
      ctx.strokeStyle = palette.districtStroke;
      ctx.lineWidth = Math.max(0.5, Math.min(2, 3 - d.depth * 0.4));
      pathDiamond(ctx, cam, d.rect);
      ctx.stroke();
      continue;
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = palette.districtFill;
    pathDiamond(ctx, cam, d.rect);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (s.tier !== 'city') {
      ctx.strokeStyle = palette.curb;
      ctx.lineWidth = 1;
      pathDiamond(ctx, cam, d.rect);
      ctx.stroke();
    }
  }

  // Plazas and greens sit on the paving, under the streets' crossings.
  for (const pz of model.plazas ?? []) {
    if (!groundInView(cam, pz.rect, viewW, viewH)) continue;
    if (pz.kind === 'plaza') {
      ctx.fillStyle = palette.sidewalk;
      pathDiamond(ctx, cam, pz.rect);
      ctx.fill();
      if (s.tier === 'street') {
        ctx.strokeStyle = palette.domeAccent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        pathDiamond(ctx, cam, pz.rect);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.fillStyle = palette.dark ? 'hsl(150 12% 15%)' : 'hsl(90 26% 80%)';
      pathDiamond(ctx, cam, pz.rect);
      ctx.fill();
    }
  }

  // Streets, widest tier first so pavement layers read correctly.
  const streets = model.streets ?? [];
  if (streets.length > 0) {
    const pavement = [
      palette.pavementAvenue,
      palette.pavementStreet,
      palette.pavementLane,
      palette.pavementLane,
    ];
    for (let tier = 0; tier < 4; tier++) {
      if (s.tier === 'city' && tier > 1) break;
      ctx.fillStyle = pavement[tier]!;
      for (const st of streets) {
        if (st.tier !== tier) continue;
        if (!groundInView(cam, st.rect, viewW, viewH)) continue;
        pathDiamond(ctx, cam, st.rect);
        ctx.fill();
      }
    }

    // Avenue center dashes along the long axis, projected.
    if (s.tier !== 'city') {
      ctx.strokeStyle = palette.avenueDash;
      ctx.lineWidth = Math.max(1, Math.min(2, 0.8 * cam.scale));
      ctx.setLineDash([6 * cam.scale, 6 * cam.scale]);
      ctx.beginPath();
      for (const st of streets) {
        if (st.tier !== 0) continue;
        if (!groundInView(cam, st.rect, viewW, viewH)) continue;
        const r = st.rect;
        const horizontal = r.w >= r.h;
        const a = horizontal ? { x: r.x + 2, y: r.y + r.h / 2 } : { x: r.x + r.w / 2, y: r.y + 2 };
        const b = horizontal
          ? { x: r.x + r.w - 2, y: r.y + r.h / 2 }
          : { x: r.x + r.w / 2, y: r.y + r.h - 2 };
        const pa = sp(cam, a.x - a.y, (a.x + a.y) / 2);
        const pb = sp(cam, b.x - b.y, (b.x + b.y) / 2);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
