import { rectInView } from '../camera.js';
import type { RenderState } from './state.js';
import { roundRect, screenRect } from './util.js';

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
 * PR overlay ("construction"): dim the base city, ripple the blast radius,
 * then light up the directly-changed blocks.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { cam, model, palette, viewW, viewH } = s;
  if (!model.overlay || model.overlay.changedBlocks.length === 0) return;

  const changeById = new Map(model.overlay.changedBlocks.map((c) => [c.blockId, c]));
  const affected = s.affectedIds;
  const blockById = new Map(model.blocks.map((b) => [b.id, b]));
  // scrim over the whole base map so changed blocks pop
  ctx.fillStyle = palette.ground;
  ctx.globalAlpha = 0.62;
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.globalAlpha = 1;

  // 1) blast radius: files that (transitively) import a changed file. Faint
  //    ripple ring so they read as "downstream impact", not direct changes.
  if (affected && affected.size > 0) {
    for (const id of affected) {
      if (changeById.has(id)) continue; // a directly-changed block wins
      const b = blockById.get(id);
      if (!b || !rectInView(cam, b.rect, viewW, viewH)) continue;
      const sr = screenRect(cam, b.rect);
      const x = sr.x;
      const y = sr.y;
      const w = Math.max(3, sr.w);
      const h = Math.max(3, sr.h);
      const r = Math.min(3, w / 6);
      ctx.fillStyle = PR_RIPPLE;
      ctx.globalAlpha = 0.18;
      roundRect(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = PR_RIPPLE;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, r);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // 2) directly-changed blocks: bright re-fill + glowing ring (dashed for
  //    phantom "new construction" files the PR adds that aren't indexed yet).
  for (const b of model.blocks) {
    const ch = changeById.get(b.id);
    if (!ch || !rectInView(cam, b.rect, viewW, viewH)) continue;
    const color = PR_CHANGE_COLOR[ch.change] ?? '#888888';
    const sr = screenRect(cam, b.rect);
    const x = sr.x;
    const y = sr.y;
    const w = Math.max(3, sr.w);
    const h = Math.max(3, sr.h);
    const r = Math.min(3, w / 6);
    ctx.fillStyle = color;
    ctx.globalAlpha = b.phantom ? 0.45 : 0.85;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (b.phantom) ctx.setLineDash([4, 3]);
    roundRect(ctx, x - 1, y - 1, w + 2, h + 2, r + 1);
    ctx.stroke();
    ctx.restore();
  }
}
