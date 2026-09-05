import { RUN_SHARDS } from './data/index.js';
import { type ScorecardDataset, ScorecardDatasetSchema } from './schema.js';
import { mergeShards } from './shards.js';

export * from './schema.js';
export * from './report.js';
export * from './filter.js';
export * from './shards.js';

/**
 * The checked-in scorecard, parsed once.
 *
 * Deliberately NOT lazy and NOT forgiving: a malformed dataset is a build
 * error, not a runtime surprise. The handboek renders these numbers to
 * users, so a shape that no longer matches the schema must fail where an
 * engineer sees it rather than quietly render an empty table.
 *
 * Stored one file per sweep (see shards.ts) and merged here, so the storage
 * layout stops at this module: every consumer reads `SCORECARD` and none of
 * them knows or cares how many files it came from. Each shard is validated
 * on its own first, so a malformed sweep names itself instead of failing
 * somewhere inside a merged blob.
 */
export const SCORECARD: ScorecardDataset = mergeShards(
  RUN_SHARDS.map((shard) => ScorecardDatasetSchema.parse(shard)),
);

/** True when no sweep has been recorded yet — articles degrade gracefully. */
export function scorecardIsEmpty(dataset: ScorecardDataset = SCORECARD): boolean {
  return dataset.results.length === 0;
}
