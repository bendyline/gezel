import type { FileMapResponse, MapBuilding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Camera } from '../camera.js';
import { buildingAnchorScreen, buildingsForBlock, hitTestIsoBuilding } from './geometry.js';
import { PODIUM_HISO, miniHIso, toIso, townRoofRiseIso } from './projection.js';

const CAM: Camera = { scale: 1, offsetX: 0, offsetY: 0 };

function building(id: string, x: number, y: number, height: number): MapBuilding {
  return {
    id,
    blockId: 'src/a.ts',
    rect: { x, y, w: 4, h: 4 },
    height,
    lines: 40,
    label: id,
    kind: 'function',
  };
}

/** Only `buildings` matters to the helpers under test. */
function model(buildings: MapBuilding[]): FileMapResponse {
  return { buildings } as Partial<FileMapResponse> as FileMapResponse;
}

describe('buildingsForBlock', () => {
  it('groups by block and memoizes per payload', () => {
    const m = model([building('a', 10, 10, 0.5), building('b', 16, 10, 0.5)]);
    const first = buildingsForBlock(m, 'src/a.ts');
    expect(first.map((b) => b.id)).toEqual(['a', 'b']);
    expect(buildingsForBlock(m, 'src/a.ts')).toBe(first);
    expect(buildingsForBlock(m, 'src/other.ts')).toHaveLength(0);
  });
});

describe('hitTestIsoBuilding', () => {
  it('hits a mini through its raised prism and misses beside it', () => {
    const b = building('a', 10, 10, 1);
    const m = model([b]);
    // Just below the rooftop anchor is inside the prism's front face.
    const anchor = buildingAnchorScreen(CAM, b);
    expect(hitTestIsoBuilding(m, 'src/a.ts', CAM, anchor.x, anchor.y + 1)?.id).toBe('a');
    // Far south of the footprint (past the ground diamond) misses.
    const south = toIso(18, 18);
    expect(hitTestIsoBuilding(m, 'src/a.ts', CAM, south.u, south.v)).toBeNull();
  });

  it('prefers the front building when projections overlap', () => {
    const back = building('back', 10, 10, 1);
    const front = building('front', 14, 14, 1);
    const m = model([back, front]);
    // A point on the shared u=0 line where both prisms project: front wins.
    const v = 13 - PODIUM_HISO;
    expect(hitTestIsoBuilding(m, 'src/a.ts', CAM, 0, v)?.id).toBe('front');
  });

  it('anchors the tooltip at the rooftop center, podium included', () => {
    const b = building('a', 10, 10, 0.5);
    const iso = toIso(12, 12);
    const anchor = buildingAnchorScreen(CAM, b);
    expect(anchor.x).toBeCloseTo(iso.u, 6);
    expect(anchor.y).toBeCloseTo(
      iso.v - PODIUM_HISO - miniHIso(0.5) - townRoofRiseIso(b.rect, CAM.scale, true),
      6,
    );
  });
});
