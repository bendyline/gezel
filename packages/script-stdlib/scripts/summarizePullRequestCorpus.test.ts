import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let output: unknown;
  return {
    files,
    get output() { return output; },
    reset() { output = undefined; },
    gezel: {
      input: { manifestFile: 'data/pr/attachments/pr-files.json', batchesFile: 'tasks/1/pr-review/batches.json', outFile: 'tasks/1/pr-review/scope-data.json' },
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
  h.files.set('data/pr/attachments/pr-files.json', JSON.stringify({ pullRequest: 60, totalFiles: 3, files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'tests/a.test.ts' }] }));
  h.files.set('tasks/1/pr-review/batches.json', JSON.stringify([{ batchNumber: 1, start: 1, end: 2, paths: ['src/a.ts', 'src/b.ts'], records: ['data/a.md', 'data/b.md'] }, { batchNumber: 2, start: 3, end: 3, paths: ['tests/a.test.ts'], records: ['data/c.md'] }]));
});
describe('summarizePullRequestCorpus', () => {
  it('publishes counts and ranges without copying the huge path/record arrays', async () => {
    vi.resetModules(); await import('./summarizePullRequestCorpus');
    expect(h.output).toMatchObject({ ok: true, files: 3, batches: 2 });
    const raw = h.files.get('tasks/1/pr-review/scope-data.json')!;
    const summary = JSON.parse(raw);
    expect(summary).toMatchObject({ totalFiles: 3, batchCount: 2 });
    expect(summary.topAreas[0]).toEqual({ area: 'src', count: 2 });
    expect(summary.ranges).toEqual([{ number: 1, start: 1, end: 2, files: 2 }, { number: 2, start: 3, end: 3, files: 1 }]);
    expect(raw).not.toContain('data/a.md');
    expect(raw).not.toContain('src/a.ts');
  });
  it('fails closed when the manifest file count disagrees with its array', async () => {
    h.files.set('data/pr/attachments/pr-files.json', JSON.stringify({ totalFiles: 4, files: [{ path: 'src/a.ts' }] }));
    vi.resetModules();
    await expect(import('./summarizePullRequestCorpus')).rejects.toThrow(/totalFiles/);
    expect(h.files.has('tasks/1/pr-review/scope-data.json')).toBe(false);
  });
});
