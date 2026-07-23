import type { MapBlock, MapBlockHealth } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { deriveBlockDecor } from './decor.js';

const health = (vibe: MapBlockHealth['vibe']): MapBlockHealth => ({
  findings: vibe === 'scruffy' || vibe === 'blighted' ? 2 : 0,
  maxSeverity: vibe === 'blighted' ? 'critical' : null,
  fanIn: 1,
  fanOut: 1,
  vibe,
  zone: 'residential',
});

const block = (overrides: Partial<MapBlock> = {}): MapBlock => ({
  id: 'src/a.ts',
  districtId: 'src',
  rect: { x: 12, y: 12, w: 20, h: 20 },
  lot: { x: 10, y: 10, w: 25, h: 26 },
  label: 'a.ts',
  weight: 100,
  state: 'live',
  buildingCount: 2,
  health: health('lush'),
  ...overrides,
});

describe('deriveBlockDecor', () => {
  it('is deterministic for the same block', () => {
    expect(deriveBlockDecor(block())).toEqual(deriveBlockDecor(block()));
  });

  it('maps vibe to the expected decoration mix', () => {
    const lush = deriveBlockDecor(block());
    expect(lush.length).toBeGreaterThanOrEqual(4); // 3–5 trees + 1–2 shrubs
    expect(lush.every((d) => d.sprite.startsWith('tree') || d.sprite === 'shrub')).toBe(true);

    const tidy = deriveBlockDecor(block({ health: health('tidy') }));
    expect(tidy.length).toBeGreaterThanOrEqual(1);
    expect(tidy.length).toBeLessThanOrEqual(2);

    expect(deriveBlockDecor(block({ health: health('plain') }))).toEqual([]);

    const scruffy = deriveBlockDecor(block({ health: health('scruffy') }));
    expect(scruffy.some((d) => d.sprite === 'dryPatch')).toBe(true);
    expect(scruffy.some((d) => d.sprite === 'weed')).toBe(true);

    const blighted = deriveBlockDecor(block({ health: health('blighted') }));
    expect(blighted.some((d) => d.sprite === 'deadTree')).toBe(true);
    expect(blighted.some((d) => d.sprite === 'dryPatch')).toBe(true);
  });

  it('keeps every instance centered inside the lot', () => {
    for (const vibe of ['lush', 'tidy', 'scruffy', 'blighted'] as const) {
      for (const d of deriveBlockDecor(block({ health: health(vibe) }))) {
        expect(d.x).toBeGreaterThanOrEqual(10);
        expect(d.x).toBeLessThanOrEqual(35);
        expect(d.y).toBeGreaterThanOrEqual(10);
        expect(d.y).toBeLessThanOrEqual(36);
        expect(d.size).toBeGreaterThan(0);
      }
    }
  });

  it('decorates nothing without a lot, health, or a live building', () => {
    const { lot: _lot, ...noLot } = block();
    expect(deriveBlockDecor(noLot as MapBlock)).toEqual([]);
    const { health: _health, ...noHealth } = block();
    expect(deriveBlockDecor(noHealth as MapBlock)).toEqual([]);
    expect(deriveBlockDecor(block({ state: 'tombstoned' }))).toEqual([]);
    expect(deriveBlockDecor(block({ phantom: true }))).toEqual([]);
  });
});
