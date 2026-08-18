import {
  AMBIENT_DASHBOARD_MAX_DIMENSION,
  AMBIENT_DASHBOARD_MAX_PIXELS,
  AMBIENT_DASHBOARD_MIN_DIMENSION,
  type AmbientDashboardDisplayTarget,
} from '@bendyline/gezel';

/** Extra space inside the OS-reported work area so content does not kiss chrome. */
export const AMBIENT_DASHBOARD_SAFE_MARGIN_DIP = 12;

export interface DisplayGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

/**
 * Translate Electron's DIP display geometry into the physical-pixel target the
 * daemon persists. The full canvas matches the primary monitor exactly (or a
 * proportionally downscaled equivalent inside squisq's PNG budget); content is
 * constrained to the OS work area plus a small breathing margin.
 */
export function ambientDashboardDisplayTarget(
  display: DisplayGeometry,
): AmbientDashboardDisplayTarget {
  const density =
    Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const rawWidth = Math.max(
    AMBIENT_DASHBOARD_MIN_DIMENSION,
    Math.round(display.bounds.width * density),
  );
  const rawHeight = Math.max(
    AMBIENT_DASHBOARD_MIN_DIMENSION,
    Math.round(display.bounds.height * density),
  );
  const outputScale = Math.min(
    1,
    AMBIENT_DASHBOARD_MAX_DIMENSION / rawWidth,
    AMBIENT_DASHBOARD_MAX_DIMENSION / rawHeight,
    Math.sqrt(AMBIENT_DASHBOARD_MAX_PIXELS / (rawWidth * rawHeight)),
  );
  const width = Math.max(AMBIENT_DASHBOARD_MIN_DIMENSION, Math.floor(rawWidth * outputScale));
  const height = Math.max(AMBIENT_DASHBOARD_MIN_DIMENSION, Math.floor(rawHeight * outputScale));
  const dipToOutputPixel = density * outputScale;
  const boundsRight = display.bounds.x + display.bounds.width;
  const boundsBottom = display.bounds.y + display.bounds.height;
  const workRight = display.workArea.x + display.workArea.width;
  const workBottom = display.workArea.y + display.workArea.height;

  const horizontal = fitInsets(
    Math.round(
      (Math.max(0, display.workArea.x - display.bounds.x) + AMBIENT_DASHBOARD_SAFE_MARGIN_DIP) *
        dipToOutputPixel,
    ),
    Math.round(
      (Math.max(0, boundsRight - workRight) + AMBIENT_DASHBOARD_SAFE_MARGIN_DIP) * dipToOutputPixel,
    ),
    width,
  );
  const vertical = fitInsets(
    Math.round(
      (Math.max(0, display.workArea.y - display.bounds.y) + AMBIENT_DASHBOARD_SAFE_MARGIN_DIP) *
        dipToOutputPixel,
    ),
    Math.round(
      (Math.max(0, boundsBottom - workBottom) + AMBIENT_DASHBOARD_SAFE_MARGIN_DIP) *
        dipToOutputPixel,
    ),
    height,
  );

  return {
    width,
    height,
    safeArea: {
      x: horizontal.start,
      y: vertical.start,
      width: horizontal.size,
      height: vertical.size,
    },
  };
}

function fitInsets(
  requestedStart: number,
  requestedEnd: number,
  extent: number,
): { start: number; size: number } {
  const maxInsets = Math.max(0, extent - AMBIENT_DASHBOARD_MIN_DIMENSION);
  const total = Math.max(0, requestedStart) + Math.max(0, requestedEnd);
  const scale = total > maxInsets && total > 0 ? maxInsets / total : 1;
  const start = Math.max(0, Math.floor(requestedStart * scale));
  const end = Math.max(0, Math.floor(requestedEnd * scale));
  return { start, size: Math.max(AMBIENT_DASHBOARD_MIN_DIMENSION, extent - start - end) };
}
