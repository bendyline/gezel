import { COMMUNITY_SHARDS, RUN_SHARDS } from './data/index.js';
import { type ScorecardDataset, ScorecardDatasetSchema } from './schema.js';
import { mergeShards } from './shards.js';

export * from './schema.js';
export * from './report.js';
export * from './csv.js';
export * from './filter.js';
export * from './shards.js';
export * from './lookup.js';

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

/**
 * Rounds submitted by people outside Bendyline (`gezel bench --json`, then
 * `gezel bench submit`), parsed by the same schema and kept apart.
 *
 * Nothing that quotes "the scorecard" reads this: model pages, the catalog's
 * measured column and `gezel doctor` use {@link SCORECARD} only, and the
 * Handboek renders community rounds in their own section. A community round
 * may not reuse a Bendyline run id, so a submission can never shadow or be
 * mistaken for a published round.
 */
export const COMMUNITY_SCORECARD: ScorecardDataset = communityDataset(COMMUNITY_SHARDS, SCORECARD);

/** Parse the community shards and refuse any run id the published scorecard already uses. */
export function communityDataset(
  shards: readonly unknown[],
  published: ScorecardDataset,
): ScorecardDataset {
  const dataset = mergeShards(shards.map((shard) => ScorecardDatasetSchema.parse(shard)));
  const taken = new Set(published.runs.map((run) => run.id));
  const clash = dataset.runs.find((run) => taken.has(run.id));
  if (clash) {
    throw new Error(
      `Community scorecard round "${clash.id}" reuses a published run id; rename the community shard's run.`,
    );
  }
  return dataset;
}

/** True when no sweep has been recorded yet — articles degrade gracefully. */
export function scorecardIsEmpty(dataset: ScorecardDataset = SCORECARD): boolean {
  return dataset.results.length === 0;
}
