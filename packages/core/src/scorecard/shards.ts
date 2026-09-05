import type { ScorecardDataset, ScorecardModelResult, ScorecardRun } from './schema.js';

/**
 * The scorecard is stored one file per sweep, not as a single dataset.
 *
 * The whole-file layout made every ingest rewrite a sorted array, so two
 * branches that each measured a different machine conflicted on a 400 KB
 * JSON blob that git could only diff line-by-line — a merge with no semantic
 * conflict at all (11 shared runs, 2 added on one side, 1 on the other) still
 * had to be resolved by hand. Sweeps are append-mostly and independent, so
 * they are stored that way: a new sweep is a new file, and two of them never
 * touch the same bytes.
 *
 * A shard is a COMPLETE dataset carrying exactly one run. That deliberately
 * reuses `ScorecardDatasetSchema` rather than inventing a shard schema, so
 * each file validates on its own and the merged whole needs no second shape.
 *
 * These helpers are pure and fs-free: core loads shards through a generated
 * barrel of static imports (esbuild has no glob import, and core must stay
 * browser-safe), while the eval writer splits a merged dataset back out.
 */

/** Newest sweep first, matching how a reader scans the published table. */
function byRunRecency(a: ScorecardRun, b: ScorecardRun): number {
  return b.provenance.startedAt.localeCompare(a.provenance.startedAt);
}

/**
 * Stable result order within the merged dataset.
 *
 * Identical to the ordering `mergeScorecard` has always produced, so sharding
 * changes where the bytes live and nothing about what `SCORECARD` contains.
 */
function byResultIdentity(a: ScorecardModelResult, b: ScorecardModelResult): number {
  return (
    b.runId.localeCompare(a.runId) ||
    a.suiteId.localeCompare(b.suiteId) ||
    a.modelId.localeCompare(b.modelId)
  );
}

/** Combine per-sweep shards into the single dataset every consumer reads. */
export function mergeShards(shards: readonly ScorecardDataset[]): ScorecardDataset {
  const runs: ScorecardRun[] = [];
  const results: ScorecardModelResult[] = [];
  for (const shard of shards) {
    runs.push(...shard.runs);
    results.push(...shard.results);
  }
  return {
    schemaVersion: 1,
    runs: runs.sort(byRunRecency),
    results: results.sort(byResultIdentity),
  };
}

/**
 * Split a merged dataset back into one shard per run.
 *
 * Results whose `runId` names no run are dropped rather than parked in an
 * orphan file: they cannot be rendered (every scoreboard reads through a run)
 * and writing them somewhere would make the split non-round-tripping.
 */
export function splitIntoShards(dataset: ScorecardDataset): ScorecardDataset[] {
  const byRun = new Map<string, ScorecardModelResult[]>();
  for (const result of dataset.results) {
    const bucket = byRun.get(result.runId);
    if (bucket) bucket.push(result);
    else byRun.set(result.runId, [result]);
  }
  return [...dataset.runs].sort(byRunRecency).map((run) => ({
    schemaVersion: 1 as const,
    runs: [run],
    results: (byRun.get(run.id) ?? []).slice().sort(byResultIdentity),
  }));
}

/**
 * The file a run's shard lives in.
 *
 * The run id is already filesystem-safe (`runIdFor` slugifies it) and leads
 * with the sweep date, so it is used verbatim: sorting the directory sorts
 * the sweeps, and two sweeps from different days land at different positions
 * in the generated barrel, which is what keeps most concurrent additions
 * auto-mergeable.
 */
export function shardFileName(runId: string): string {
  return `${runId}.json`;
}

/** The import identifier a run gets in the generated barrel. */
export function shardImportName(runId: string): string {
  return `run_${runId.replace(/[^A-Za-z0-9]/g, '_')}`;
}
