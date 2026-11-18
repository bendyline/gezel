import { describe, it } from 'vitest';
import { type RunProfile, checkEngineModel } from './testing/model/property.js';

/**
 * The sync engine and writer against generated sources. Each profile is one
 * kind of adapter the contract allows; each run is a seeded sequence of
 * changes, faults and passes, after which the corpus must match the source.
 * A fixed seed keeps a red build tied to the change that made it red;
 * GEZEL_MODEL_SEED and GEZEL_MODEL_RUNS widen the search locally.
 */
const SEED = Number(process.env.GEZEL_MODEL_SEED ?? 0x5eed);
const RUNS = Number(process.env.GEZEL_MODEL_RUNS ?? 25);
const OPS = 24;

const profiles: RunProfile[] = [
  {
    name: 'mirror with tombstones',
    tombstones: true,
    moves: false,
    honoursLimit: true,
    expire: false,
  },
  {
    name: 'records that move between folders',
    tombstones: true,
    moves: true,
    honoursLimit: true,
    expire: false,
  },
  {
    name: 'window without tombstones',
    tombstones: false,
    moves: false,
    honoursLimit: true,
    expire: true,
  },
  {
    name: 'a source that returns everything at once',
    tombstones: false,
    moves: false,
    honoursLimit: false,
    expire: false,
  },
];

describe('the sync engine against generated sources', () => {
  for (const profile of profiles) {
    it(`converges: ${profile.name}`, async () => {
      await checkEngineModel(profile, { seed: SEED, runs: RUNS, ops: OPS });
    }, 120_000);
  }

  // After a cursor expires, a mirror larger than one batch re-lists over
  // several batches; what was deleted meanwhile must still leave the corpus
  // (`ChangeBatch.fullListing`). Found by this model: six steps.
  it('converges: a mirror whose cursor expires', async () => {
    await checkEngineModel(
      { name: 'expiring mirror', tombstones: true, moves: false, honoursLimit: true, expire: true },
      { seed: SEED, runs: RUNS, ops: OPS },
    );
  }, 120_000);
});
