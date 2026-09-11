import type { MapBlock } from '@bendyline/gezel';
import { bandOf } from '../urbanity.js';
import { type PrismScreen, drawPrism, pathQuad } from './prism.js';
import type { IsoRenderState, ScreenPt } from './state.js';

/** A low stone edge and worn paving let the buildings own the color field. */
export function drawCourtyard(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  block: MapBlock,
  p: PrismScreen,
): void {
  const village = bandOf(block) === 'village';
  drawPrism(ctx, p, {
    top: village ? s.palette.park.path : s.palette.districtFill,
    wallL: s.palette.curb,
    wallR: s.palette.fence,
  });
  if (s.tier !== 'street' || p.te.x - p.tw.x < 40) return;
  const at = (u: number, v: number): ScreenPt => ({
    x: p.tn.x + (p.te.x - p.tn.x) * u + (p.tw.x - p.tn.x) * v,
    y: p.tn.y + (p.te.y - p.tn.y) * u + (p.tw.y - p.tn.y) * v,
  });
  ctx.save();
  pathQuad(ctx, p.tn, p.te, p.ts, p.tw);
  ctx.clip();
  ctx.strokeStyle = s.palette.curb;
  ctx.globalAlpha = village ? 0.25 : 0.36;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  const rows = Math.min(64, Math.ceil(block.rect.h / 2.8));
  const cols = Math.min(64, Math.ceil(block.rect.w / 4.2));
  for (let row = 1; row < rows; row++) {
    const a = at(0, row / rows);
    const b = at(1, row / rows);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    for (let col = 0; col < cols; col++) {
      const u = (col + (row % 2) * 0.5) / cols;
      const c = at(u, (row - 1) / rows);
      const d = at(u, row / rows);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = s.palette.sidewalk;
  ctx.lineWidth = Math.max(1, s.cam.scale * 0.3);
  pathQuad(ctx, p.tn, p.te, p.ts, p.tw);
  ctx.stroke();
  ctx.restore();
}
