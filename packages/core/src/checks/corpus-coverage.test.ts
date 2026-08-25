import { describe, expect, it } from 'vitest';
import { mergeCorpusCoverageShards } from './corpus-coverage.js';

const batches = JSON.stringify([
  { batchNumber: 1, paths: ['a.ts', 'b.ts'], records: ['data/a.md', 'data/b.md'] },
  { batchNumber: 2, paths: ['c.ts'], records: ['data/c.md'] },
]);

const shard = (batchNumber: number, reviewedFiles: string[], reviewedRecords: string[]) => ({
  path: `tasks/13/pr-review/coverage-${batchNumber}.json`,
  content: JSON.stringify({ batchNumber, reviewedFiles, reviewedRecords }),
});

describe('mergeCorpusCoverageShards', () => {
  it('builds a canonical ledger from exact batch-owned shards', () => {
    const result = mergeCorpusCoverageShards(
      batches,
      [shard(2, ['c.ts'], ['data/c.md']), shard(1, ['a.ts', 'b.ts'], ['data/a.md', 'data/b.md'])],
      { pullRequest: 46, requireComplete: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ledger).toEqual({
      pullRequest: 46,
      reviewedFiles: ['a.ts', 'b.ts', 'c.ts'],
      reviewedRecords: ['data/a.md', 'data/b.md', 'data/c.md'],
      sources: [
        { batchNumber: 1, shard: 'tasks/13/pr-review/coverage-1.json' },
        { batchNumber: 2, shard: 'tasks/13/pr-review/coverage-2.json' },
      ],
      complete: true,
    });
  });

  it('can publish an in-progress ledger but fails a completeness gate', () => {
    const shards = [shard(1, ['a.ts', 'b.ts'], ['data/a.md', 'data/b.md'])];
    const partial = mergeCorpusCoverageShards(batches, shards);
    expect(partial).toMatchObject({ ok: true, mergedBatches: 1, missingBatches: [2] });
    expect(partial.ledger?.complete).toBe(false);

    const strict = mergeCorpusCoverageShards(batches, shards, { requireComplete: true });
    expect(strict).toMatchObject({ ok: false, mergedBatches: 1, missingBatches: [2] });
  });

  it('rejects a shard that fabricates paths outside its published batch', () => {
    const result = mergeCorpusCoverageShards(batches, [
      shard(1, ['a.ts', 'b.ts', 'c.ts'], ['data/a.md', 'data/b.md', 'data/c.md']),
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not exactly match batch 1/);
  });

  it('rejects a shard that claims records it did not receive', () => {
    const result = mergeCorpusCoverageShards(batches, [
      shard(1, ['a.ts', 'b.ts'], ['data/a.md', 'data/c.md']),
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/artifact records/);
  });
});
