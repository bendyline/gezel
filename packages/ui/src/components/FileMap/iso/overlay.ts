import { geomInView } from './geometry.js';
import { pathSilhouette, prismScreen } from './prism.js';
import { isoCorners } from './projection.js';
import { type IsoRenderState, sp } from './state.js';

/** Diff-style colors for PR-overlay change types (work in both themes). */
const PR_CHANGE_COLOR: Record<string, string> = {
  added: '#3fb950',
  modified: '#d29922',
  deleted: '#f85149',
  renamed: '#a371f7',
};
/** Blast-radius ripple (downstream importers) — cool blue, distinct from diffs. */
const PR_RIPPLE = '#58a6ff';

/**
 * PR overlay in iso ("construction"): dim the base city with a scrim, ripple
 * the blast radius on top faces, then light up the directly-changed prisms.
 */
export function drawIsoOverlay(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette, viewW, viewH } = s;
  if (!model.overlay || model.overlay.changedBlocks.length === 0) return;

  const changeById = new Map(model.overlay.changedBlocks.map((c) => [c.blockId, c]));
  const geomById = new Map(s.geom.geoms.map((g) => [g.block.id, g]));

  ctx.fillStyle = palette.ground;
  ctx.globalAlpha = 0.62;
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.globalAlpha = 1;

  if (s.affectedIds && s.affectedIds.size > 0) {
    for (const id of s.affectedIds) {
      if (changeById.has(id)) continue;
      const g = geomById.get(id);
      if (!g || !geomInView(cam, g, viewW, viewH)) continue;
      const c = isoCorners(g.block.rect);
      const lift = g.hIso * cam.scale;
      const pts = [c.n, c.e, c.s, c.w].map((p) => {
        const scr = sp(cam, p.u, p.v);
        return { x: scr.x, y: scr.y - lift };
      });
      ctx.fillStyle = PR_RIPPLE;
      ctx.globalAlpha = 0.18;
      diamondPath(ctx, pts);
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = PR_RIPPLE;
      ctx.lineWidth = 1;
      diamondPath(ctx, pts);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  for (const g of s.geom.geoms) {
    const ch = changeById.get(g.block.id);
    if (!ch || !geomInView(cam, g, viewW, viewH)) continue;
    const color = PR_CHANGE_COLOR[ch.change] ?? '#888888';
    const prism = prismScreen(cam, g.block.rect, g.hIso);
    ctx.fillStyle = color;
    ctx.globalAlpha = g.block.phantom ? 0.45 : 0.85;
    pathSilhouette(ctx, prism);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (g.block.phantom) ctx.setLineDash([4, 3]);
    pathSilhouette(ctx, prism);
    ctx.stroke();
    ctx.restore();
  }
}

function diamondPath(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
}
