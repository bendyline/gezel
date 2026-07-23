import { rectInView } from '../camera.js';
import type { RenderState } from './state.js';
import { screenRect } from './util.js';

/** District labels (all tiers, size-gated) + block labels at street zoom. */
export function drawLabels(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { cam, model, palette, viewW, viewH } = s;

  // v5 payloads mark display districts (pass-through chains collapsed to one
  // label) and carry a reserved plate rect; older payloads label everything
  // at the district corner as before.
  const v5 = model.districts.some((d) => d.displayLabel !== undefined);
  for (const d of model.districts) {
    if (v5 && d.displayLabel === undefined) continue;
    if (!rectInView(cam, d.rect, viewW, viewH)) continue;
    const { x, y, w, h } = screenRect(cam, d.rect);
    if (w <= 60 || h <= 24) continue;
    const text = d.displayLabel ?? d.label;
    ctx.fillStyle = palette.districtLabel;
    ctx.font = `${d.depth <= 1 ? 13 : 11}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    if (d.labelPlate) {
      const p = screenRect(cam, d.labelPlate);
      ctx.fillText(text, p.x + 2, p.y + 1, Math.max(20, p.w));
    } else {
      ctx.fillText(text, x + 6, y + 5, w - 12);
    }
  }

  if (s.tier === 'street') {
    ctx.fillStyle = palette.label;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const b of model.blocks) {
      if (b.state === 'tombstoned') continue;
      const w = b.rect.w * cam.scale;
      if (w < 44) continue;
      if (!rectInView(cam, b.rect, viewW, viewH)) continue;
      const { x, y } = screenRect(cam, b.rect);
      ctx.fillText(b.label, x + 2, y - 2, w);
    }
  }
}
