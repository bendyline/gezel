import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { readImageMeta } from '../index-store/image-meta.js';
import { placeDashboardInSafeArea } from './dashboard-render.js';

describe('placeDashboardInSafeArea', () => {
  it('pads a safe-area render back to the full display canvas', async () => {
    const dashboard = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64"><rect width="80" height="64" fill="red"/></svg>',
    )
      .render()
      .asPng();
    const target = {
      width: 120,
      height: 100,
      safeArea: { x: 20, y: 24, width: 80, height: 64 },
    };
    const result = await placeDashboardInSafeArea(dashboard, target, '#1f1a17');
    const lightResult = await placeDashboardInSafeArea(dashboard, target, '#ffffff');

    expect(readImageMeta(Buffer.from(result))).toEqual({
      format: 'png',
      width: 120,
      height: 100,
    });
    expect(Buffer.from(result).equals(Buffer.from(lightResult))).toBe(false);
  }, 15_000);
});
