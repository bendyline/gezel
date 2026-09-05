import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_SHARDS } from './data/index.js';
import { SCORECARD } from './index.js';
import { ScorecardDatasetSchema } from './schema.js';
import { mergeShards, shardFileName, shardImportName, splitIntoShards } from './shards.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const runsDir = join(repoRoot, 'packages/core/src/scorecard/data/runs');

describe('scorecard shards', () => {
  it('every shard on disk is a valid dataset carrying exactly one run', () => {
    // Each file validating on its own is the point of reusing the dataset
    // schema for a shard: a malformed sweep names itself instead of failing
    // somewhere inside a merged blob.
    for (const shard of RUN_SHARDS) {
      const parsed = ScorecardDatasetSchema.parse(shard);
      expect(parsed.runs).toHaveLength(1);
      for (const result of parsed.results) {
        expect(result.runId).toBe(parsed.runs[0]!.id);
      }
    }
  });

  it('merges to the same runs and results the barrel carries', () => {
    const totalRuns = RUN_SHARDS.length;
    const totalResults = RUN_SHARDS.reduce((sum, s) => sum + s.results.length, 0);
    expect(SCORECARD.runs).toHaveLength(totalRuns);
    expect(SCORECARD.results).toHaveLength(totalResults);
  });

  it('orders runs newest first and results deterministically', () => {
    const starts = SCORECARD.runs.map((r) => r.provenance.startedAt);
    expect([...starts].sort((a, b) => b.localeCompare(a))).toEqual(starts);
  });

  it('round-trips: split then merge is the identity', () => {
    // The writer splits a merged dataset back into files, so a lossy split
    // would silently drop a sweep on the next ingest.
    expect(mergeShards(splitIntoShards(SCORECARD))).toEqual(SCORECARD);
  });

  it('leaves no result stranded without its run', () => {
    const runIds = new Set(SCORECARD.runs.map((r) => r.id));
    const orphans = SCORECARD.results.filter((r) => !runIds.has(r.runId));
    expect(orphans).toEqual([]);
  });

  it('names shard files by run id so the directory sorts by sweep date', () => {
    expect(shardFileName('2026-09-04-win32-amd')).toBe('2026-09-04-win32-amd.json');
    expect(shardImportName('2026-09-04-win32-amd')).toBe('run_2026_09_04_win32_amd');
  });

  it('has a barrel that matches the shard directory', () => {
    // The barrel is what core actually imports (ESM cannot glob), so a shard
    // added without regenerating it is a sweep missing from the published
    // table with no error anywhere — the silent-drop failure mode this
    // check exists to make loud.
    const onDisk = readdirSync(runsDir).filter((n) => n.endsWith('.json'));
    expect(RUN_SHARDS).toHaveLength(onDisk.length);

    execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts/gen-scorecard-barrel.mjs'), '--check'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
  });
});
