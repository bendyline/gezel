import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  screenToWorldX,
  screenToWorldY,
  zoomAround,
} from './camera.js';

describe('file map camera zoom', () => {
  it('supports close inspection up to 12x while retaining the overview floor', () => {
    expect(MAX_SCALE).toBe(12);
    expect(clampScale(20)).toBe(12);
    expect(clampScale(0)).toBe(MIN_SCALE);
  });

  it('keeps the world point beneath the cursor fixed when zooming to the ceiling', () => {
    const cam = { scale: 8, offsetX: 5, offsetY: 7 };
    const sx = 240;
    const sy = 180;
    const before = {
      x: screenToWorldX(cam, sx),
      y: screenToWorldY(cam, sy),
    };

    const zoomed = zoomAround(cam, 2, sx, sy);

    expect(zoomed.scale).toBe(MAX_SCALE);
    expect(screenToWorldX(zoomed, sx)).toBeCloseTo(before.x);
    expect(screenToWorldY(zoomed, sy)).toBeCloseTo(before.y);
  });
});
