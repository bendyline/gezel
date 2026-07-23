import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { townStyleForBlock, townStyleForSymbol } from './town-style.js';

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
