import { describe, expect, it } from 'vitest';
import {
  AmbientDashboardDisplayTargetSchema,
  AmbientDashboardStateSchema,
  AmbientDashboardStatusResponseSchema,
  AmbientDashboardThemeSchema,
} from './ambient-dashboard.js';

describe('AmbientDashboardDisplayTargetSchema', () => {
  it('accepts a safe area contained by the full display canvas', () => {
    expect(
      AmbientDashboardDisplayTargetSchema.parse({
        width: 3024,
        height: 1964,
        safeArea: { x: 24, y: 100, width: 2976, height: 1840 },
      }),
    ).toEqual({
      width: 3024,
      height: 1964,
      safeArea: { x: 24, y: 100, width: 2976, height: 1840 },
    });
  });

  it('rejects targets beyond the renderer budget or outside the canvas', () => {
    expect(() =>
      AmbientDashboardDisplayTargetSchema.parse({
        width: 7680,
        height: 7680,
        safeArea: { x: 0, y: 0, width: 7680, height: 7680 },
      }),
    ).toThrow();
    expect(() =>
      AmbientDashboardDisplayTargetSchema.parse({
        width: 1920,
        height: 1080,
        safeArea: { x: 100, y: 50, width: 1900, height: 1050 },
      }),
    ).toThrow();
  });
});

describe('ambient dashboard themes', () => {
  it('accepts the Squisq dark themes and exposes them in status metadata', () => {
    expect(AmbientDashboardThemeSchema.parse('gezellig')).toBe('gezellig');
    expect(AmbientDashboardThemeSchema.parse('standard-dark')).toBe('standard-dark');
    expect(() => AmbientDashboardThemeSchema.parse('unknown-theme')).toThrow();

    const status = AmbientDashboardStatusResponseSchema.parse({
      enabled: true,
      running: false,
      lastGeneratedAt: null,
      lastFailedAt: null,
      lastError: null,
      latestFilename: null,
      resolution: 'fhd',
      themeId: 'gezellig',
      themes: [
        {
          id: 'gezellig',
          name: 'Gezellig',
          description: 'A cozy dark theme.',
        },
      ],
      displayTarget: null,
    });
    expect(status.themeId).toBe('gezellig');

    expect(
      AmbientDashboardStatusResponseSchema.parse({
        enabled: false,
        running: false,
        lastGeneratedAt: null,
        latestFilename: null,
        resolution: 'fhd',
      }),
    ).not.toHaveProperty('themeId');
  });
});

describe('AmbientDashboardStateSchema', () => {
  it('keeps successful output metadata separate from a later failed attempt', () => {
    expect(
      AmbientDashboardStateSchema.parse({
        lastRunAt: '2026-08-17T23:49:00.000Z',
        lastGeneratedAt: '2026-08-17T22:53:00.000Z',
        lastFailedAt: '2026-08-17T23:49:00.000Z',
        lastError: 'one-shot timed out',
        lastFile: 'dashboard-20260817-1552.png',
      }),
    ).toMatchObject({
      lastGeneratedAt: '2026-08-17T22:53:00.000Z',
      lastFailedAt: '2026-08-17T23:49:00.000Z',
      lastError: 'one-shot timed out',
    });
  });
});
