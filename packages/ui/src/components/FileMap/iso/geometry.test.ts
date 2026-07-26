import type { FileMapResponse, MapBlock, MapBuilding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Camera } from '../camera.js';
import {
  buildingAnchorScreen,
  buildingsForBlock,
  geometryForModel,
  hitTestIso,
  hitTestIsoBuilding,
  roofHeadroom,
} from './geometry.js';
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

function blockModel(blocks: MapBlock[]): FileMapResponse {
  return { blocks, buildings: [] } as Partial<FileMapResponse> as FileMapResponse;
}

function liveBlock(id: string, x: number, y: number): MapBlock {
  return {
    id,
    districtId: 'src',
    rect: { x, y, w: 20, h: 16 },
    label: id,
    weight: 200,
    lang: 'typescript',
    state: 'live',
    buildingCount: 0,
    levels: 3,
    health: {
      findings: 0,
      maxSeverity: null,
      fanIn: 1,
      fanOut: 1,
      vibe: 'tidy',
      zone: 'residential',
    },
  };
}

describe('geometry cache', () => {
  it('resolves each live block’s architecture once, on the model', () => {
    const m = blockModel([liveBlock('src/a.ts', 0, 0), liveBlock('src/b.ts', 40, 0)]);
    const geom = geometryForModel(m);
    expect(geom.geoms.every((g) => g.style !== undefined)).toBe(true);
    // Memoized per payload, so a pan doesn't re-hash every visible block.
    expect(geometryForModel(m)).toBe(geom);
    expect(geometryForModel(m).geoms[0]!.style).toBe(geom.geoms[0]!.style);
  });

  it('leaves tombstones without a style — rubble has no building', () => {
    const dead: MapBlock = { ...liveBlock('src/gone.ts', 0, 0), state: 'tombstoned' };
    const geom = geometryForModel(blockModel([dead]));
    expect(geom.geoms[0]!.style).toBeUndefined();
    expect(geom.geoms[0]!.hIso).toBe(0);
  });
});

describe('roofHeadroom', () => {
  it('defaults to the ordinary roof budget', () => {
    const geom = geometryForModel(blockModel([liveBlock('src/a.ts', 0, 0)]));
    const g = geom.geoms[0]!;
    expect(g.roofFactor).toBe(1);
    expect(roofHeadroom(g, 1)).toBeCloseTo(townRoofRiseIso(g.block.rect, 1), 6);
  });

  it('scales with roofFactor so tall caps stay cullable and clickable', () => {
    const geom = geometryForModel(blockModel([liveBlock('src/tower.ts', 0, 0)]));
    const g = { ...geom.geoms[0]!, roofFactor: 1.6 };
    expect(roofHeadroom(g, 1)).toBeCloseTo(townRoofRiseIso(g.block.rect, 1) * 1.6, 6);
    // A click inside the extra headroom must still select the block.
    const tall = geometryForModel(blockModel([liveBlock('src/tower.ts', 0, 0)]));
    tall.geoms[0]!.roofFactor = 1.6;
    const b = tall.geoms[0]!.block;
    const iso = toIso(b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2);
    const capV = iso.v - tall.geoms[0]!.hIso - townRoofRiseIso(b.rect, 1) * 1.4;
    expect(hitTestIso(tall, CAM, iso.u, capV)?.id).toBe('src/tower.ts');
  });

  it('gives tombstones and phantoms no headroom', () => {
    const dead: MapBlock = { ...liveBlock('src/gone.ts', 0, 0), state: 'tombstoned' };
    const ghost: MapBlock = { ...liveBlock('src/new.ts', 40, 0), phantom: true };
    const geom = geometryForModel(blockModel([dead, ghost]));
    expect(roofHeadroom(geom.geoms[0]!, 1)).toBe(0);
    expect(roofHeadroom(geom.geoms[1]!, 1)).toBe(0);
  });
});

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
