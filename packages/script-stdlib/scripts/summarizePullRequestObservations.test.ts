import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let output: unknown;
  return {
    files,
    get output() { return output; },
    reset() { output = undefined; },
    gezel: {
      input: { batchesFile: 'tasks/1/pr-review/batches.json', shardDir: 'tasks/1/pr-review', outFile: 'tasks/1/pr-review/synthesis-data.json' },
      output(value: unknown) { output = value; },
      artifacts: {
        async read(path: string) { const result = files.get(path); if (result === undefined) throw new Error(`missing ${path}`); return result; },
        async write(path: string, content: string) { files.set(path, content); },
      },
    },
  };
});
vi.mock('@bendyline/gezel-sdk', () => ({ defineScript: <T>(meta: T) => meta, gezel: h.gezel }));
beforeEach(() => {
  h.files.clear(); h.reset();
  h.files.set('tasks/1/pr-review/batches.json', JSON.stringify([
    { batchNumber: 1, start: 1, end: 2, paths: ['src/a.ts', 'src/b.ts'] },
    { batchNumber: 2, start: 3, end: 3, paths: ['src/c.ts'] },
  ]));
  h.files.set('tasks/1/pr-review/observations-1.md', '# Batch 1\n## src/a.ts\nVerified OK.\n## src/b.ts\n### Findings\n**B1-1 [major] src/b.ts:4 authorization bypass**\n- Mechanism: owner check skipped.\n- Fix: compare owner.\n' + 'padding not copied\n'.repeat(1000));
  h.files.set('tasks/1/pr-review/observations-2.md', '## Batch 2\n### `src/c.ts`\n### Findings\n### B2-1 — Minor: no issue\n- Fix: None needed.\n');
});

describe('summarizePullRequestObservations', () => {
  it('indexes every exact shard and keeps long prose out of synthesis context', async () => {
    vi.resetModules(); await import('./summarizePullRequestObservations');
    expect(h.output).toMatchObject({ ok: true, batches: 2, candidates: 2 });
    const raw = h.files.get('tasks/1/pr-review/synthesis-data.json')!;
    const index = JSON.parse(raw);
    expect(index).toMatchObject({ batchCount: 2, candidateCount: 2 });
    expect(index.batches[0].candidates[0]).toMatchObject({ id: 'B1-1', severity: 'major', likelyNonIssue: false });
    expect(index.batches[1].candidates[0]).toMatchObject({ id: 'B2-1', severity: 'minor', likelyNonIssue: true });
    expect(raw.length).toBeLessThan(2500);
  });
  it('fails closed if a shard is missing or omits an assigned path', async () => {
    h.files.delete('tasks/1/pr-review/observations-2.md');
    vi.resetModules();
    await expect(import('./summarizePullRequestObservations')).rejects.toThrow(/Missing exact observations shard/);
    expect(h.files.has('tasks/1/pr-review/synthesis-data.json')).toBe(false);
    h.files.set('tasks/1/pr-review/observations-2.md', '## Batch 2\n### src/not-c.ts\n');
    vi.resetModules();
    await expect(import('./summarizePullRequestObservations')).rejects.toThrow(/lacks path heading/);
  });
});
