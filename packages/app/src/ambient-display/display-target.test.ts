import { describe, expect, it } from 'vitest';
import { ambientDashboardDisplayTarget } from './display-target.js';

describe('ambientDashboardDisplayTarget', () => {
  it('uses physical primary-display pixels and keeps content below macOS chrome', () => {
    expect(
      ambientDashboardDisplayTarget({
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 38, width: 1512, height: 944 },
        scaleFactor: 2,
      }),
    ).toEqual({
      width: 3024,
      height: 1964,
      safeArea: { x: 24, y: 100, width: 2976, height: 1840 },
    });
  });

  it('respects work-area chrome on every edge', () => {
    expect(
      ambientDashboardDisplayTarget({
        bounds: { x: -100, y: 20, width: 1600, height: 1000 },
        workArea: { x: -60, y: 50, width: 1490, height: 920 },
        scaleFactor: 1,
      }).safeArea,
    ).toEqual({ x: 52, y: 42, width: 1466, height: 896 });
  });

  it('proportionally caps unusually large displays to the renderer budget', () => {
    const target = ambientDashboardDisplayTarget({
      bounds: { x: 0, y: 0, width: 10_000, height: 6_000 },
      workArea: { x: 0, y: 80, width: 10_000, height: 5_920 },
      scaleFactor: 1,
    });
    expect(target.width).toBeLessThanOrEqual(7_680);
    expect(target.height).toBeLessThanOrEqual(7_680);
    expect(target.width * target.height).toBeLessThanOrEqual(33_177_600);
    expect(target.width / target.height).toBeCloseTo(10 / 6, 3);
    expect(target.safeArea.y).toBeGreaterThan(0);
  });
});
