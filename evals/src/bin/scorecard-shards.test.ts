import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScorecardDatasetSchema, splitIntoShards } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { captureDevice, mergeScorecard } from '../scorecard.ts';
import { writeRunShards } from './scorecard-shards.ts';

const device = captureDevice();
const run = (id: string, startedAt: string) => ({
  id,
  provenance: {
    startedAt,
    device,
    harnessCommit: 'abc1234',
    gildeVersion: '0.1.15',
    count: 3,
    judgeModelId: null,
  },
  suites: ['core'],
  scenariosBySuite: { core: ['tictactoe'] },
});
const result = (modelId: string, runId: string, successes: number) => ({
  modelId,
  label: modelId,
  engine: 'llama-cpp',
  tier: 'medium',
  runId,
  suiteId: 'core',
  cells: [{ scenarioId: 'tictactoe', trials: 3, successes, nonModelFailures: 0 }],
});

/**
 * A round published by its own importer: valid, but laid out its own way —
 * `note` ahead of `suites`, `memoryCoverage` last, models out of order.
 */
function publishedShard(): string {
  const { suites, scenariosBySuite, ...head } = run('published', '2026-08-01T00:00:00Z');
  const shard = {
    schemaVersion: 1,
    runs: [{ ...head, note: 'hand-published', suites, scenariosBySuite, memoryCoverage: 'full' }],
    results: [result('zeta', 'published', 2), result('alpha', 'published', 3)],
  };
  return `${JSON.stringify(shard, null, 2)}\n`;
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('writeRunShards', () => {
  it('writes the ingested run and leaves a published shard byte for byte', () => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-scorecard-shards-'));
    const published = join(dir, 'published.json');
    const bytes = publishedShard();
    writeFileSync(published, bytes);

    const existing = ScorecardDatasetSchema.parse(JSON.parse(bytes));
    const merged = mergeScorecard(existing, run('new', '2026-08-09T00:00:00Z'), [
      result('beta', 'new', 1),
    ]);
    // The normalized read-back differs from the published bytes, which is
    // exactly what made a whole-dataset rewrite touch every published round.
    const normalized = splitIntoShards(merged).find((shard) => shard.runs[0]!.id === 'published');
    expect(`${JSON.stringify(normalized, null, 2)}\n`).not.toBe(bytes);

    expect(writeRunShards(dir, merged, new Set(['new']))).toEqual([join(dir, 'new.json')]);
    expect(readFileSync(published, 'utf8')).toBe(bytes);
    expect(readdirSync(dir).sort()).toEqual(['new.json', 'published.json']);
    const written = ScorecardDatasetSchema.parse(
      JSON.parse(readFileSync(join(dir, 'new.json'), 'utf8')),
    );
    expect(written.runs.map((entry) => entry.id)).toEqual(['new']);
    expect(written.results.map((entry) => entry.modelId)).toEqual(['beta']);
  });

  it('skips a shard that is already current', () => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-scorecard-shards-'));
    const empty = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [], results: [] });
    const merged = mergeScorecard(empty, run('new', '2026-08-09T00:00:00Z'), [
      result('beta', 'new', 1),
    ]);
    expect(writeRunShards(dir, merged, new Set(['new']))).toHaveLength(1);
    expect(writeRunShards(dir, merged, new Set(['new']))).toEqual([]);
  });
});
