import type { Rect } from '@bendyline/gezel';
import { type Camera, worldToScreenX, worldToScreenY } from '../camera.js';

/** A world rect projected to screen space (CSS px). */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function screenRect(cam: Camera, r: Rect): ScreenRect {
  return {
    x: worldToScreenX(cam, r.x),
    y: worldToScreenY(cam, r.y),
    w: r.w * cam.scale,
    h: r.h * cam.scale,
  };
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const patternCache = new Map<string, CanvasPattern | null>();

/**
 * Diagonal-hatch fill pattern (PR "scaffolding" treatment). Returns null when
 * a 2D tile context isn't available (jsdom) — callers fall back to a plain
 * translucent fill.
 */
export function crosshatchPattern(
  ctx: CanvasRenderingContext2D,
  color: string,
): CanvasPattern | null {
  const cached = patternCache.get(color);
  if (cached !== undefined) return cached;
  let pattern: CanvasPattern | null = null;
  try {
    const tile = document.createElement('canvas');
    tile.width = 8;
    tile.height = 8;
    const tctx = tile.getContext('2d');
    if (tctx) {
      tctx.strokeStyle = color;
      tctx.lineWidth = 1.2;
      tctx.beginPath();
      tctx.moveTo(-2, 10);
      tctx.lineTo(10, -2);
      tctx.stroke();
      pattern = ctx.createPattern(tile, 'repeat') ?? null;
    }
  } catch {
    pattern = null;
  }
  patternCache.set(color, pattern);
  return pattern;
}
