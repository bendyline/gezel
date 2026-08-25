import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ArtifactEntry {
  path: string;
  size: number;
  modified: string;
}

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let input: Record<string, unknown> = {};
  let output: unknown;
  const norm = (path: string | undefined) =>
    String(path ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
  return {
    files,
    begin(next: Record<string, unknown>) {
      input = next;
      output = undefined;
    },
    result() {
      return output;
    },
    gezel: {
      get input() {
        return input;
      },
      output(value: unknown) {
        output = value;
      },
      log() {},
      artifacts: {
        async read(path: string) {
          const value = files.get(norm(path));
          if (value === undefined) throw new Error(`artifact not found: ${path}`);
          return value;
        },
        async write(path: string, content: string) {
          files.set(norm(path), content);
        },
        async list(prefix?: string): Promise<ArtifactEntry[]> {
          const scope = norm(prefix);
          return [...files]
            .filter(([path]) => !scope || path.startsWith(`${scope}/`))
            .map(([path, content]) => ({ path, size: content.length, modified: '' }));
        },
      },
    },
  };
});

vi.mock('@bendyline/gezel-sdk', () => ({
  defineScript: <T>(meta: T) => meta,
  gezel: h.gezel,
}));

const baseInput = {
  batchesFile: 'tasks/13/pr-review/batches.json',
  shardDir: 'tasks/13/pr-review',
  outFile: 'tasks/13/pr-review-coverage.json',
  ledgerFile: 'tasks/13/pr-review-coverage.json',
  pullRequest: '46',
};

const batches = [
  { batchNumber: 1, paths: ['a.ts'], records: ['data/a.md'] },
  { batchNumber: 2, paths: ['b.ts'], records: ['data/b.md'] },
];

async function run(module: './mergeCorpusCoverage' | './checkCorpusCoverageProvenance') {
  vi.resetModules();
  await import(module);
  return h.result() as Record<string, unknown>;
}

function writeShard(batchNumber: number, files: string[], records: string[]) {
  h.files.set(
    `tasks/13/pr-review/coverage-${batchNumber}.json`,
    JSON.stringify({ batchNumber, reviewedFiles: files, reviewedRecords: records }),
  );
}

beforeEach(() => {
  h.files.clear();
  h.files.set(baseInput.batchesFile, JSON.stringify(batches));
});

describe('mergeCorpusCoverage + checkCorpusCoverageProvenance', () => {
  it('publishes partial progress, then approves only after every exact shard lands', async () => {
    writeShard(1, ['a.ts'], ['data/a.md']);
    h.begin(baseInput);
    expect(await run('./mergeCorpusCoverage')).toMatchObject({
      ok: true,
      mergedBatches: 1,
      missingBatches: [2],
      complete: false,
    });

    h.begin(baseInput);
    expect(await run('./checkCorpusCoverageProvenance')).toMatchObject({ decision: 'reject' });

    writeShard(2, ['b.ts'], ['data/b.md']);
    h.begin(baseInput);
    expect(await run('./mergeCorpusCoverage')).toMatchObject({ complete: true, mergedBatches: 2 });
    h.begin(baseInput);
    expect(await run('./checkCorpusCoverageProvenance')).toMatchObject({ decision: 'approve' });
  });

  it('rejects a parent-authored ledger that claims paths absent from the shards', async () => {
    writeShard(1, ['a.ts'], ['data/a.md']);
    writeShard(2, ['b.ts'], ['data/b.md']);
    h.files.set(
      baseInput.outFile,
      JSON.stringify({
        pullRequest: 46,
        reviewedFiles: ['a.ts', 'b.ts', 'invented.ts'],
        reviewedRecords: ['data/a.md', 'data/b.md'],
      }),
    );

    h.begin(baseInput);
    const verdict = await run('./checkCorpusCoverageProvenance');
    expect(verdict).toMatchObject({ decision: 'reject' });
    expect(verdict.message).toMatch(/not the deterministic union/);
  });
});
