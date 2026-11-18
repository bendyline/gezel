import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let input: Record<string, unknown> = {};
  let output: unknown;
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
      artifacts: {
        async read(path: string) {
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        },
        async write(path: string, content: string) {
          files.set(path, content);
        },
      },
    },
  };
});
vi.mock('@bendyline/gezel-sdk', () => ({ defineScript: <T>(meta: T) => meta, gezel: h.gezel }));

const BATCHES = 'tasks/1/pr-review/batches.json';
const LOCK = 'data/pr/files/003--package-lock-json--aaaaaaaa.md';
const NOTICES = 'data/pr/files/004--third-party-notices-txt--bbbbbbbb.md';

async function run(): Promise<unknown> {
  h.begin({ batchesFile: BATCHES, shardDir: 'tasks/1/pr-review/' });
  vi.resetModules();
  await import('./publishGeneratedFileObservations');
  return h.result();
}

beforeEach(() => {
  h.files.clear();
  h.files.set(
    BATCHES,
    JSON.stringify([
      { batchNumber: 1, start: 1, end: 2, paths: ['a.ts', 'b.ts'], records: ['x.md', 'y.md'] },
      {
        batchNumber: 2,
        start: 3,
        end: 4,
        paths: ['package-lock.json', 'THIRD_PARTY_NOTICES.txt'],
        records: [LOCK, NOTICES],
        generated: true,
      },
    ]),
  );
  h.files.set(
    LOCK,
    [
      '# `package-lock.json`',
      '',
      '```diff',
      '@@ -4,3 +4,3 @@',
      '     "node_modules/left-pad": {',
      '-      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",',
      '+      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",',
      '     },',
      '```',
    ].join('\n'),
  );
});

describe('publishGeneratedFileObservations', () => {
  it('covers a generated batch with a summary and a coverage shard, and leaves reviewer batches alone', async () => {
    expect(await run()).toEqual({ ok: true, batches: 1, files: 2 });
    const observations = h.files.get('tasks/1/pr-review/observations-2.md')!;
    expect(observations).toContain('# Batch 2 — files 3–4');
    expect(observations).toContain('\n## package-lock.json\n');
    expect(observations).toContain('- left-pad 1.0.0 to 1.3.0');
    // The notices record was never synced: the file is still accounted for.
    expect(observations).toContain(
      '\n## THIRD_PARTY_NOTICES.txt\n\nThird-party notices. No patch available.',
    );
    expect(JSON.parse(h.files.get('tasks/1/pr-review/coverage-2.json')!)).toEqual({
      batchNumber: 2,
      reviewedFiles: ['package-lock.json', 'THIRD_PARTY_NOTICES.txt'],
      reviewedRecords: [LOCK, NOTICES],
    });
    expect(h.files.has('tasks/1/pr-review/observations-1.md')).toBe(false);
    expect(h.files.has('tasks/1/pr-review/coverage-1.json')).toBe(false);
  });

  it('refuses to vouch for a batch marked generated that holds an ordinary file', async () => {
    h.files.set(
      BATCHES,
      JSON.stringify([
        {
          batchNumber: 1,
          start: 1,
          end: 1,
          paths: ['src/auth.ts'],
          records: ['x.md'],
          generated: true,
        },
      ]),
    );
    await expect(run()).rejects.toThrow(/src\/auth\.ts is not a generated file/);
    expect(h.files.has('tasks/1/pr-review/coverage-1.json')).toBe(false);
  });

  it('writes nothing when no batch is generated', async () => {
    h.files.set(
      BATCHES,
      JSON.stringify([{ batchNumber: 1, start: 1, end: 1, paths: ['a.ts'], records: ['x.md'] }]),
    );
    expect(await run()).toEqual({ ok: true, batches: 0, files: 0 });
  });
});
