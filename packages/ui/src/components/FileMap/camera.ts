import type { Rect } from '@bendyline/gezel';

/** A 2D camera over map-space: pan (offset) + uniform zoom (scale). */
export interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export type LodTier = 'city' | 'district' | 'street';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 12;

export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/** Level-of-detail tier from the current zoom — what the renderer bothers drawing. */
export function lodTier(scale: number): LodTier {
  if (scale < 0.45) return 'city';
  if (scale < 1.3) return 'district';
  return 'street';
}

export function worldToScreenX(cam: Camera, x: number): number {
  return (x - cam.offsetX) * cam.scale;
}
export function worldToScreenY(cam: Camera, y: number): number {
  return (y - cam.offsetY) * cam.scale;
}
export function screenToWorldX(cam: Camera, sx: number): number {
  return sx / cam.scale + cam.offsetX;
}
export function screenToWorldY(cam: Camera, sy: number): number {
  return sy / cam.scale + cam.offsetY;
}

/** Fit a world rect into a viewport (CSS px), centered, with padding. */
export function fitToBounds(bounds: Rect, viewW: number, viewH: number, pad = 32): Camera {
  if (bounds.w <= 0 || bounds.h <= 0 || viewW <= 0 || viewH <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = clampScale(Math.min((viewW - pad * 2) / bounds.w, (viewH - pad * 2) / bounds.h));
  // center: screen = (world - offset) * scale ; we want bounds center at view center
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return {
    scale,
    offsetX: cx - viewW / 2 / scale,
    offsetY: cy - viewH / 2 / scale,
  };
}

/** Zoom by a factor around a screen-space anchor (keeps the point under cursor). */
export function zoomAround(cam: Camera, factor: number, sx: number, sy: number): Camera {
  const scale = clampScale(cam.scale * factor);
  if (scale === cam.scale) return cam;
  // world point under the cursor stays fixed
  const wx = screenToWorldX(cam, sx);
  const wy = screenToWorldY(cam, sy);
  return { scale, offsetX: wx - sx / scale, offsetY: wy - sy / scale };
}

/** True when a world rect intersects the visible viewport (cull test). */
export function rectInView(cam: Camera, r: Rect, viewW: number, viewH: number): boolean {
  const sx = worldToScreenX(cam, r.x);
  const sy = worldToScreenY(cam, r.y);
  const sw = r.w * cam.scale;
  const sh = r.h * cam.scale;
  return sx + sw >= 0 && sy + sh >= 0 && sx <= viewW && sy <= viewH;
}
