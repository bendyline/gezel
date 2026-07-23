import { rectInView } from '../camera.js';
import { hash32, seeded } from '../seed.js';
import type { RenderState } from './state.js';
import { screenRect } from './util.js';

/**
 * Symbol buildings (functions/classes inside a file), street zoom only. Big
 * enough ones get the same facade-under-roof treatment as blocks; roof detail
 * hints at the symbol kind — a ridge line for classes, AC units for functions.
 */
export function drawBuildings(ctx: CanvasRenderingContext2D, s: RenderState): void {
  if (s.tier !== 'street') return;
  const p = s.palette;
  for (const bld of s.model.buildings) {
    if (!rectInView(s.cam, bld.rect, s.viewW, s.viewH)) continue;
    const r = screenRect(s.cam, bld.rect);
    if (r.w < 1.5 || r.h < 1.5) continue;

    if (r.w < 4 || r.h < 6) {
      ctx.fillStyle = p.building;
      ctx.globalAlpha = 0.35 + 0.55 * bld.height;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      continue;
    }

    const wallH = Math.min(Math.max(1.5, bld.height * 0.35 * r.h), 6);
    ctx.globalAlpha = 0.5 + 0.45 * bld.height;
    ctx.fillStyle = p.buildingFacade;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = p.building;
    ctx.fillRect(r.x, r.y, r.w, r.h - wallH);

    const roofH = r.h - wallH;
    if (r.w > 10 && roofH > 8) {
      const rng = seeded(hash32(bld.id));
      if (bld.kind === 'class' || bld.kind === 'interface' || bld.kind === 'struct') {
        ctx.strokeStyle = p.buildingFacade;
        ctx.lineWidth = 1;
        const ry = r.y + roofH * (0.35 + 0.3 * rng());
        ctx.beginPath();
        ctx.moveTo(r.x + 1, ry);
        ctx.lineTo(r.x + r.w - 1, ry);
        ctx.stroke();
      } else if (bld.kind === 'function' || bld.kind === 'method') {
        const units = 1 + (rng() < 0.4 ? 1 : 0);
        ctx.fillStyle = p.buildingFacade;
        for (let i = 0; i < units; i++) {
          const size = 2 + rng() * 2;
          const ax = r.x + 2 + rng() * Math.max(1, r.w - size - 4);
          const ay = r.y + 2 + rng() * Math.max(1, roofH - size - 4);
          ctx.fillRect(ax, ay, size, size);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}
