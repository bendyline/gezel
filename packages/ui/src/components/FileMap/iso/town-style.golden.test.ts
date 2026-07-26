import type { MapBlock } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { townStyleForBlock } from './town-style.js';

/**
 * The no-reshuffle tripwire.
 *
 * A file's building is its identity on the map — users navigate by "the
 * sawtooth foundry next to the plaza." `townStyleForBlock` derives it from one
 * seeded PRNG stream, which makes the stream's shape load-bearing in a way the
 * code doesn't advertise: `pick()` is `items[floor(random() * len)]`, so
 * appending one member to a family array remaps every file in that family, and
 * inserting one `random()` draw ahead of an existing one reshuffles the whole
 * settlement.
 *
 * These twenty fixtures span all four zone families and pin the styles as they
 * stood before the Village 3.0 vocabulary work. New architecture is meant to
 * arrive through the urbanity band and through separately-salted sub-streams,
 * both of which leave this golden untouched. **If it fails, the change moved
 * buildings that already exist on users' maps — that is the finding, not the
 * golden being stale.** Re-record only on a deliberate, called-out reshuffle.
 */
const GOLDEN: Array<[string, Record<string, unknown>]> = [
  [
    'src/index.ts',
    {
      archetype: 'boarding-house',
      roof: 'hip',
      ridge: 'x',
      storeys: 1,
      bays: 1,
      chimneys: 2,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'src/app/router.ts',
    {
      archetype: 'inn',
      roof: 'mansard',
      ridge: 'y',
      storeys: 2,
      bays: 3,
      chimneys: 2,
      dormers: 1,
      awning: true,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'src/app/view.tsx',
    {
      archetype: 'library',
      roof: 'hip',
      ridge: 'x',
      storeys: 3,
      bays: 2,
      chimneys: 0,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'packages/core/src/schemas/api.ts',
    {
      archetype: 'rail-depot',
      roof: 'gable',
      ridge: 'x',
      storeys: 4,
      bays: 2,
      chimneys: 2,
      dormers: 1,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'lib/util/strings.ts',
    {
      archetype: 'boarding-house',
      roof: 'hip',
      ridge: 'x',
      storeys: 5,
      bays: 4,
      chimneys: 2,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'lib/util/dates.ts',
    {
      archetype: 'market-hall',
      roof: 'hip',
      ridge: 'y',
      storeys: 1,
      bays: 3,
      chimneys: 0,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'server/db/pool.ts',
    {
      archetype: 'guildhall',
      roof: 'mansard',
      ridge: 'x',
      storeys: 2,
      bays: 3,
      chimneys: 0,
      dormers: 1,
      awning: false,
      cupola: true,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'server/http/server.ts',
    {
      archetype: 'foundry',
      roof: 'sawtooth',
      ridge: 'x',
      storeys: 3,
      bays: 3,
      chimneys: 3,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 3,
    },
  ],
  [
    'ui/components/Button.tsx',
    {
      archetype: 'townhouse',
      roof: 'gable',
      ridge: 'x',
      storeys: 4,
      bays: 4,
      chimneys: 0,
      dormers: 2,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'ui/components/Table.tsx',
    {
      archetype: 'inn',
      roof: 'mansard',
      ridge: 'x',
      storeys: 5,
      bays: 1,
      chimneys: 1,
      dormers: 1,
      awning: true,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'scripts/build.mjs',
    {
      archetype: 'schoolhouse',
      roof: 'gable',
      ridge: 'y',
      storeys: 1,
      bays: 2,
      chimneys: 0,
      dormers: 0,
      awning: false,
      cupola: true,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'docs/readme.md',
    {
      archetype: 'foundry',
      roof: 'sawtooth',
      ridge: 'x',
      storeys: 2,
      bays: 2,
      chimneys: 3,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 2,
    },
  ],
  [
    'src/engine/render.rs',
    {
      archetype: 'townhouse',
      roof: 'mansard',
      ridge: 'x',
      storeys: 3,
      bays: 3,
      chimneys: 0,
      dormers: 1,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'src/engine/parse.rs',
    {
      archetype: 'market-hall',
      roof: 'gable',
      ridge: 'x',
      storeys: 4,
      bays: 4,
      chimneys: 0,
      dormers: 2,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'tools/cli/main.go',
    {
      archetype: 'schoolhouse',
      roof: 'gable',
      ridge: 'x',
      storeys: 5,
      bays: 3,
      chimneys: 0,
      dormers: 1,
      awning: false,
      cupola: true,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'tools/cli/flags.go',
    {
      archetype: 'foundry',
      roof: 'sawtooth',
      ridge: 'x',
      storeys: 1,
      bays: 4,
      chimneys: 3,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 4,
    },
  ],
  [
    'app/models/user.py',
    {
      archetype: 'townhouse',
      roof: 'gable',
      ridge: 'x',
      storeys: 2,
      bays: 4,
      chimneys: 0,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'app/models/order.py',
    {
      archetype: 'corner-shop',
      roof: 'gable',
      ridge: 'y',
      storeys: 3,
      bays: 4,
      chimneys: 0,
      dormers: 2,
      awning: true,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'native/bridge.c',
    {
      archetype: 'guildhall',
      roof: 'mansard',
      ridge: 'x',
      storeys: 4,
      bays: 1,
      chimneys: 0,
      dormers: 1,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 0,
    },
  ],
  [
    'evals/run.ts',
    {
      archetype: 'foundry',
      roof: 'sawtooth',
      ridge: 'x',
      storeys: 5,
      bays: 3,
      chimneys: 3,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      sawteeth: 3,
    },
  ],
];

const ZONES = ['residential', 'commercial', 'civic', 'industrial'] as const;

/** The exact fixture shape the golden was recorded from. Changing any field
 *  here invalidates every row, so treat it as frozen too. */
function goldenBlock(id: string, i: number): MapBlock {
  return {
    id,
    districtId: id.slice(0, id.lastIndexOf('/')),
    rect: { x: 0, y: 0, w: 20 + (i % 5) * 6, h: 16 + (i % 3) * 7 },
    label: id.slice(id.lastIndexOf('/') + 1),
    weight: 100 + i * 37,
    lang: 'typescript',
    state: 'live',
    buildingCount: 1 + (i % 9),
    levels: 1 + (i % 5),
    health: {
      findings: 0,
      maxSeverity: null,
      fanIn: i % 7,
      fanOut: i % 5,
      vibe: 'tidy',
      zone: ZONES[i % 4]!,
      importance: (i % 10) / 10,
      churn: i * 2,
    },
  };
}

describe('town style golden', () => {
  it('every recorded file keeps the building it already had', () => {
    const got = GOLDEN.map(([id], i) => {
      const s = townStyleForBlock(goldenBlock(id, i));
      return [
        id,
        {
          archetype: s.archetype,
          roof: s.roof,
          ridge: s.ridge,
          storeys: s.storeys,
          bays: s.bays,
          chimneys: s.chimneys,
          dormers: s.dormers,
          awning: s.awning,
          cupola: s.cupola,
          clock: s.clock,
          sawteeth: s.sawteeth,
        },
      ];
    });
    expect(got).toEqual(GOLDEN);
  });

  it('covers all four zone families, so a family-array edit cannot slip through', () => {
    const families = new Set(GOLDEN.map((_, i) => ZONES[i % 4]));
    expect(families.size).toBe(4);
  });
});
