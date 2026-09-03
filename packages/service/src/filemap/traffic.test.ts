import type { Rect } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type TrafficInput, computeStreetTraffic } from './traffic.js';

/**
 * A two-folder town:
 *
 *   ┌ pkg/a ─────────────┐  B  ┌ pkg/b ───────────┐
 *   │ hub  leaf1 │lane a │  L  │ leaf2 leaf3      │
 *   │ ---- laneA ------- │  V  │ ---- laneB ----- │
 *   │ leaf4  leaf5       │  D  │ leaf6  leaf7     │
 *   └────────────────────┘     └──────────────────┘
 *
 * The boulevard (root street) bounds both folders; each folder has one lane
 * between its parcel rows. `hub` is imported by every other file.
 */
const lot = (x: number, y: number, w = 20, h = 16): Rect => ({ x, y, w, h });

function town(overrides: Partial<TrafficInput> = {}): TrafficInput {
  const blocks: TrafficInput['blocks'] = [
    { id: 'pkg/a/hub.ts', districtId: 'pkg/a', lot: lot(4, 20), live: true, urbanity: 0.6 },
    { id: 'pkg/a/leaf1.ts', districtId: 'pkg/a', lot: lot(26, 20), live: true, urbanity: 0.6 },
    { id: 'pkg/a/leaf4.ts', districtId: 'pkg/a', lot: lot(4, 40), live: true, urbanity: 0.6 },
    { id: 'pkg/a/leaf5.ts', districtId: 'pkg/a', lot: lot(26, 40), live: true, urbanity: 0.6 },
    { id: 'pkg/b/leaf2.ts', districtId: 'pkg/b', lot: lot(74, 20), live: true, urbanity: 0.6 },
    { id: 'pkg/b/leaf3.ts', districtId: 'pkg/b', lot: lot(96, 20), live: true, urbanity: 0.6 },
    { id: 'pkg/b/leaf6.ts', districtId: 'pkg/b', lot: lot(74, 40), live: true, urbanity: 0.6 },
    { id: 'pkg/b/leaf7.ts', districtId: 'pkg/b', lot: lot(96, 40), live: true, urbanity: 0.6 },
  ];
  const districts: TrafficInput['districts'] = [
    { id: 'pkg', rect: { x: 0, y: 0, w: 122, h: 60 } },
    { id: 'pkg/a', rect: { x: 0, y: 16, w: 50, h: 44 } },
    { id: 'pkg/b', rect: { x: 70, y: 16, w: 50, h: 44 } },
  ];
  const streets: TrafficInput['streets'] = [
    // The trunk between the two folders runs through `pkg`.
    { id: 'blvd', rect: { x: 54, y: 0, w: 12, h: 60 }, districtId: 'pkg' },
    // Row lanes inside each folder.
    { id: 'laneA', rect: { x: 4, y: 36, w: 42, h: 4 }, districtId: 'pkg/a' },
    { id: 'laneB', rect: { x: 74, y: 36, w: 42, h: 4 }, districtId: 'pkg/b' },
    // A lane far from everything: no frontage, no egress.
    { id: 'nowhere', rect: { x: 300, y: 300, w: 40, h: 4 }, districtId: 'pkg/b' },
  ];
  const roads: TrafficInput['roads'] = blocks
    .filter((b) => b.id !== 'pkg/a/hub.ts')
    .map((b) => ({ a: b.id, b: 'pkg/a/hub.ts', bidirectional: false }));
  return { blocks, districts, streets, roads, settlement: 'city', ...overrides };
}

describe('computeStreetTraffic', () => {
  it('credits frontage to the lanes parcels stand on and egress to the trunk between folders', () => {
    const t = computeStreetTraffic(town());
    // hub: 7 in-edges; every leaf: 1. laneA fronts hub+leaf1 (row above) and
    // leaf4+leaf5 (row below) = 7+1+1+1, plus the three in-folder roads whose
    // corridor crosses it = 13. laneB fronts four leaves = 4; the roads that
    // leave pkg/b travel at the `pkg` level, so its corridor never credits a
    // pkg/b lane.
    expect(t.get('laneA')!.traffic).toBe(13);
    expect(t.get('laneB')!.traffic).toBe(4);
    // Four roads leave pkg/b for pkg/a: each folder's egress (4) lands on the
    // trunk bounding both, and the trunk lies in every road's corridor (4).
    expect(t.get('blvd')!.traffic).toBe(12);
    expect(t.get('nowhere')!.traffic).toBe(0);
  });

  it('grades monotonically with traffic, with zero traffic on the lowest grade', () => {
    const t = computeStreetTraffic(town());
    expect(t.get('nowhere')!.grade).toBe(0);
    expect(t.get('laneB')!.grade).toBeGreaterThan(t.get('nowhere')!.grade);
    expect(t.get('laneA')!.grade).toBeGreaterThan(t.get('laneB')!.grade);
    // The busiest street of a city-register map reaches the top of the scale.
    expect(t.get('laneA')!.grade).toBe(7);
  });

  it('caps the grade by the map register so a hamlet never builds a trolley', () => {
    const hamlet = computeStreetTraffic(town({ settlement: 'hamlet' }));
    const village = computeStreetTraffic(town({ settlement: 'village' }));
    const towny = computeStreetTraffic(town({ settlement: 'town' }));
    expect(hamlet.get('laneA')!.grade).toBe(3);
    expect(village.get('laneA')!.grade).toBe(5);
    expect(towny.get('laneA')!.grade).toBe(7);
  });

  it('nudges the surface by the neighborhood band: a city lane is at least cobbled', () => {
    const cityBand = town();
    for (const b of cityBand.blocks) b.urbanity = 0.9;
    const t = computeStreetTraffic(cityBand);
    expect(t.get('nowhere')!.grade).toBe(1);

    const hamletBand = town();
    for (const b of hamletBand.blocks) b.urbanity = 0.1;
    const h = computeStreetTraffic(hamletBand);
    expect(h.get('nowhere')!.grade).toBe(0);
    expect(h.get('laneB')!.grade).toBeLessThan(t.get('laneB')!.grade);
  });

  it('ignores tombstoned and phantom parcels', () => {
    const input = town();
    for (const b of input.blocks) if (b.id !== 'pkg/a/hub.ts') b.live = false;
    const t = computeStreetTraffic(input);
    // Only the hub fronts laneA now; the dead parcels contribute nothing, and
    // a road with a dead endpoint travels nowhere.
    expect(t.get('laneA')!.traffic).toBe(7);
    expect(t.get('laneB')!.traffic).toBe(0);
    expect(t.get('blvd')!.traffic).toBe(0);
  });

  it('never credits a folder’s egress to its grandparent’s streets', () => {
    const input = town();
    // A root boulevard hugging `pkg` from the north: pkg itself has no egress
    // (every road stays inside it), so nothing lands on the root street.
    input.streets.push({ id: 'root', rect: { x: 0, y: -16, w: 122, h: 12 }, districtId: null });
    const t = computeStreetTraffic(input);
    expect(t.get('root')!.traffic).toBe(0);
  });

  it('is deterministic and empty for a map with no streets', () => {
    const a = computeStreetTraffic(town());
    const b = computeStreetTraffic(town());
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(computeStreetTraffic(town({ streets: [] })).size).toBe(0);
  });
});
