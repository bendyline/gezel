import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScorecardDataset } from '@bendyline/gezel';
import { shardFileName, splitIntoShards } from '@bendyline/gezel';

/**
 * Write the shards of the runs this ingest measured, and no others.
 *
 * The writer reads every shard back through `ScorecardDatasetSchema.parse`,
 * which reorders keys, and the merge re-sorts results. Neither changes what a
 * shard says, but both change its bytes, and a published round pins its
 * shard's hash in its manifest and publication test. Rewriting every shard
 * that "changed" broke ten of those tests in one ingest (2026-11-26). An
 * ingest only ever replaces its own run's rows (`mergeScorecard` keys every
 * result by run), so no other shard can have anything new to write.
 *
 * Returns the paths written; a shard whose bytes are already current is left
 * alone.
 */
export function writeRunShards(
  dir: string,
  dataset: ScorecardDataset,
  runIds: ReadonlySet<string>,
): string[] {
  mkdirSync(dir, { recursive: true });
  const touched: string[] = [];
  for (const shard of splitIntoShards(dataset)) {
    const runId = shard.runs[0]?.id;
    if (!runId || !runIds.has(runId)) continue;
    const path = join(dir, shardFileName(runId));
    const next = `${JSON.stringify(shard, null, 2)}\n`;
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === next) continue;
    writeFileSync(path, next);
    touched.push(path);
  }
  return touched;
}
