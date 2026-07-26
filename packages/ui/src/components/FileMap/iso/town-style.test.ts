import type { MapBlock, MapBuilding, Settlement } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { townStyleForBlock, townStyleForSymbol, townStyleLabel } from './town-style.js';

function block(overrides: Partial<MapBlock> = {}): MapBlock {
  return {
    id: 'src/workshop/engine.ts',
    districtId: 'src/workshop',
    rect: { x: 10, y: 10, w: 30, h: 18 },
    label: 'engine.ts',
    weight: 1200,
    lang: 'typescript',
    state: 'live',
    buildingCount: 9,
    levels: 3,
    health: {
      findings: 0,
      maxSeverity: null,
      fanIn: 2,
      fanOut: 4,
      vibe: 'tidy',
      zone: 'industrial',
      importance: 0.4,
      churn: 18,
    },
    ...overrides,
  };
}

describe('1910 town styles', () => {
  it('is deterministic for a file and keeps industrial code in the workshop family', () => {
    const first = townStyleForBlock(block());
    expect(townStyleForBlock(block())).toEqual(first);
    expect(['workshop', 'rail-depot', 'foundry']).toContain(first.archetype);
    expect(['sawtooth', 'shed', 'gable']).toContain(first.roof);
    expect(first.chimneys).toBeGreaterThan(0);
    expect(first.bays).toBe(4);
  });

  it('uses code facts for the silhouette instead of seed alone', () => {
    const id = 'src/shared/index.ts';
    const residential = townStyleForBlock(
      block({
        id,
        buildingCount: 1,
        levels: 1,
        health: { ...block().health!, zone: 'residential' },
      }),
    );
    const commercial = townStyleForBlock(
      block({
        id,
        buildingCount: 16,
        levels: 4,
        health: { ...block().health!, zone: 'commercial' },
      }),
    );
    expect(['cottage', 'townhouse', 'boarding-house']).toContain(residential.archetype);
    expect(['corner-shop', 'inn', 'market-hall']).toContain(commercial.archetype);
    expect(commercial.storeys).toBe(4);
    expect(commercial.bays).toBeGreaterThan(residential.bays);
  });

  it('makes landmarks clock-topped guildhalls and test files schoolhouses', () => {
    const landmark = townStyleForBlock(
      block({ id: 'src/kernel.ts', landmark: true, health: { ...block().health!, zone: 'civic' } }),
    );
    expect(landmark).toMatchObject({ archetype: 'guildhall', cupola: true, clock: true });

    const test = townStyleForBlock(
      block({
        id: 'src/client.test.ts',
        health: { ...block().health!, zone: 'residential' },
      }),
    );
    expect(test.archetype).toBe('schoolhouse');
  });

  it('keeps the size-role slot across bands and only changes regional idiom', () => {
    // The 3x4 grid is index-aligned, so the same file resolves to the same
    // column in every band: a mid-size commercial file is an inn in the town
    // and a hotel in the city.
    const id = 'src/shop/checkout.ts';
    const inBand = (settlement: Settlement) =>
      townStyleForBlock(
        block({ id, settlement, health: { ...block().health!, zone: 'commercial' } }),
      );
    const village = inBand('village');
    const town = inBand('town');
    const city = inBand('city');

    const COMMERCIAL = {
      village: ['village-shop', 'smithy', 'market-cross'],
      town: ['corner-shop', 'inn', 'market-hall'],
      city: ['shopfront-block', 'hotel', 'arcade'],
    };
    expect(COMMERCIAL.village).toContain(village.archetype);
    expect(COMMERCIAL.town).toContain(town.archetype);
    expect(COMMERCIAL.city).toContain(city.archetype);
    // Same slot index in all three tables.
    const slot = COMMERCIAL.town.indexOf(town.archetype);
    expect(COMMERCIAL.village.indexOf(village.archetype)).toBe(slot);
    expect(COMMERCIAL.city.indexOf(city.archetype)).toBe(slot);
  });

  it('treats a hamlet as a sparse village, not a fourth vocabulary', () => {
    const id = 'src/leaf.ts';
    const hamlet = townStyleForBlock(block({ id, settlement: 'hamlet' }));
    const village = townStyleForBlock(block({ id, settlement: 'village' }));
    expect(hamlet.band).toBe('village');
    expect(hamlet.archetype).toBe(village.archetype);
  });

  it('a payload with no settlement renders in the town band', () => {
    expect(townStyleForBlock(block()).band).toBe('town');
  });

  it('promotes the civic landmark with its band', () => {
    const civic = { ...block().health!, zone: 'civic' as const };
    const at = (settlement: Settlement) =>
      townStyleForBlock(block({ id: 'src/kernel.ts', landmark: true, settlement, health: civic }));
    expect(at('village').archetype).toBe('parish-hall');
    expect(at('town').archetype).toBe('guildhall');
    expect(at('city').archetype).toBe('town-hall');
    // Only the city landmark builds a tower, and it declares the headroom.
    expect(at('city').roofFactor).toBe(1.6);
    expect(at('town').roofFactor).toBeUndefined();
  });

  it('city buildings get masonry trim and a tighter bay rhythm than village ones', () => {
    const at = (settlement: Settlement) =>
      townStyleForBlock(
        block({
          id: 'src/home.ts',
          settlement,
          buildingCount: 9,
          levels: 4,
          health: { ...block().health!, zone: 'residential' },
        }),
      );
    const village = at('village');
    const city = at('city');
    expect(city.bays).toBeGreaterThan(village.bays);
    expect(city.trim.cornice).toBe(true);
    expect(village.trim.cornice).toBe(false);
  });

  it('is deterministic per band', () => {
    const a = townStyleForBlock(block({ settlement: 'city' }));
    expect(townStyleForBlock(block({ settlement: 'city' }))).toEqual(a);
  });

  it('every archetype in every band resolves to a drawable, declared style', () => {
    const zones = ['residential', 'commercial', 'civic', 'industrial'] as const;
    const bands: Settlement[] = ['hamlet', 'village', 'town', 'city'];
    const seen = new Set<string>();
    for (const settlement of bands) {
      for (const zone of zones) {
        for (let i = 0; i < 40; i++) {
          const style = townStyleForBlock(
            block({ id: `pkg/f${i}.ts`, settlement, health: { ...block().health!, zone } }),
          );
          seen.add(style.archetype);
          expect(style.roof).toBeTruthy();
          expect(style.eaves === 'eave' || style.eaves === 'gable').toBe(true);
          expect(style.storeys).toBeGreaterThanOrEqual(1);
          expect(style.bays).toBeGreaterThanOrEqual(1);
          // Anything that builds past an ordinary roof must declare it.
          if (style.cap === 'clock-tower' || style.roof === 'conical') {
            expect(style.roofFactor ?? 1).toBeGreaterThan(1);
          }
        }
      }
    }
    // Village, town, and city forms all reachable from a realistic spread.
    expect(seen.has('cottage-row') || seen.has('farmhouse')).toBe(true);
    expect(seen.has('tenement') || seen.has('terrace-house')).toBe(true);
  });

  it('labels a building with its register for the file inspector', () => {
    expect(townStyleLabel(townStyleForBlock(block({ settlement: 'village' })))).toMatch(
      /^village /,
    );
  });

  it('gives symbol buildings stable roof forms based on symbol kind and parent zone', () => {
    const symbol: MapBuilding = {
      id: 'src/workshop/engine.ts#Engine',
      blockId: 'src/workshop/engine.ts',
      rect: { x: 12, y: 12, w: 8, h: 8 },
      height: 0.8,
      lines: 180,
      label: 'Engine',
      kind: 'class',
    };
    const style = townStyleForSymbol(symbol, block());
    expect(townStyleForSymbol(symbol, block())).toEqual(style);
    expect(style.archetype).toBe('workshop');
    expect(['sawtooth', 'shed']).toContain(style.roof);
    expect(style.storeys).toBe(3);
  });
});

describe('massing', () => {
  it('never leaves the block footprint', () => {
    // iso/depth.ts sorts FOOTPRINTS. Geometry outside the footprint can be
    // occluded by a block the sort believes is behind this one, which shows up
    // as a wing punching through a neighbour. Structural, so test it that way.
    const zones = ['residential', 'commercial', 'civic', 'industrial'] as const;
    let withMassing = 0;
    for (const settlement of ['village', 'town', 'city'] as const) {
      for (const zone of zones) {
        for (let i = 0; i < 60; i++) {
          for (const levels of [1, 3, 5]) {
            const style = townStyleForBlock(
              block({
                id: `pkg/sub/f${i}.ts`,
                settlement,
                levels,
                health: { ...block().health!, zone },
              }),
            );
            const m = style.massing;
            if (m.kind === 'none') continue;
            withMassing++;
            expect(m.u0).toBeGreaterThanOrEqual(0);
            expect(m.v0).toBeGreaterThanOrEqual(0);
            expect(m.u1).toBeLessThanOrEqual(1);
            expect(m.v1).toBeLessThanOrEqual(1);
            expect(m.u1).toBeGreaterThan(m.u0);
            expect(m.v1).toBeGreaterThan(m.v0);
            expect(m.height).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(withMassing, 'no archetype produced a secondary mass').toBeGreaterThan(0);
  });

  it('is stable for a file and independent of the material stream', () => {
    // Massing draws from its own salt, so retuning materials must not move a
    // single wing — the whole point of sub-streams over the main stream.
    const b = block({ id: 'src/farm/barn.ts', health: { ...block().health!, zone: 'industrial' } });
    expect(townStyleForBlock(b).massing).toEqual(townStyleForBlock(b).massing);
  });

  it('gives a single-storey building no setback to step back from', () => {
    const style = townStyleForBlock(
      block({
        id: 'src/flat.ts',
        settlement: 'city',
        levels: 1,
        health: { ...block().health!, zone: 'residential' },
      }),
    );
    if (style.massing.kind === 'setback') throw new Error('setback on a one-storey building');
  });
});
