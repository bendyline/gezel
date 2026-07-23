import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  drawIssueMarker,
  issueMarkerStyle,
  issueMarkerZoomScale,
  representativeIssueBuilding,
} from './issue-marker.js';
import { buildPalette } from './palette.js';

type MaxSeverity = NonNullable<MapBlock['health']>['maxSeverity'];

function block(findings: number, maxSeverity: MaxSeverity): MapBlock {
  return {
    id: 'src/example.ts',
    districtId: 'src',
    rect: { x: 0, y: 0, w: 20, h: 20 },
    label: 'example.ts',
    weight: 100,
    state: 'live',
    buildingCount: 0,
    health: {
      findings,
      maxSeverity,
      fanIn: 0,
      fanOut: 0,
      vibe: 'plain',
      zone: 'residential',
    },
  };
}

describe('issueMarkerStyle', () => {
  it('only marks live files with findings', () => {
    expect(issueMarkerStyle(block(0, null))).toBeNull();
    expect(issueMarkerStyle({ ...block(2, 'medium'), state: 'new' })).toBeNull();
    expect(issueMarkerStyle({ ...block(2, 'medium'), phantom: true })).toBeNull();
  });

  it('increases the plume with finding count and severity', () => {
    const low = issueMarkerStyle(block(1, 'low'))!;
    const critical = issueMarkerStyle(block(12, 'critical'))!;

    expect(low).toMatchObject({ flameCount: 1, smokeCount: 4, severe: false });
    expect(critical).toMatchObject({ flameCount: 3, smokeCount: 6, severe: true });
    expect(critical.scale).toBeGreaterThan(low.scale);
  });

  it('grows at close zoom and caps before it overwhelms the map', () => {
    expect(issueMarkerZoomScale(2)).toBeGreaterThan(issueMarkerZoomScale(1));
    expect(issueMarkerZoomScale(8)).toBeGreaterThan(issueMarkerZoomScale(2));
    expect(issueMarkerZoomScale(12)).toBe(issueMarkerZoomScale(8));
  });
});

interface RecordedCall {
  method: string;
  args: unknown[];
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (!(prop in t)) {
        t[prop] = (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return null;
        };
      }
      return t[prop];
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('drawIssueMarker', () => {
  it('draws clustered billows and changes their paths over time', () => {
    const style = issueMarkerStyle(block(12, 'critical'))!;
    const still = recordingCtx();
    drawIssueMarker(still.ctx, buildPalette(true), style, 50, 50, 'src/example.ts', 1.5, 0);
    const moved = recordingCtx();
    drawIssueMarker(moved.ctx, buildPalette(true), style, 50, 50, 'src/example.ts', 1.5, 500);

    expect(still.calls.filter((call) => call.method === 'arc')).toHaveLength(style.smokeCount * 3);
    expect(
      moved.calls.filter((call) => call.method === 'arc').map((call) => call.args),
    ).not.toEqual(still.calls.filter((call) => call.method === 'arc').map((call) => call.args));
    expect(
      moved.calls.filter((call) => call.method === 'bezierCurveTo').map((call) => call.args),
    ).not.toEqual(
      still.calls.filter((call) => call.method === 'bezierCurveTo').map((call) => call.args),
    );
  });
});

describe('representativeIssueBuilding', () => {
  it('chooses the largest symbol deterministically', () => {
    const buildings: MapBuilding[] = [
      {
        id: 'small',
        blockId: 'src/example.ts',
        rect: { x: 0, y: 0, w: 4, h: 4 },
        height: 0.8,
        lines: 8,
        label: 'small',
        kind: 'function',
      },
      {
        id: 'large',
        blockId: 'src/example.ts',
        rect: { x: 6, y: 0, w: 8, h: 8 },
        height: 0.6,
        lines: 40,
        label: 'large',
        kind: 'class',
      },
    ];

    expect(representativeIssueBuilding(buildings)?.id).toBe('large');
    expect(representativeIssueBuilding([])).toBeNull();
  });
});
