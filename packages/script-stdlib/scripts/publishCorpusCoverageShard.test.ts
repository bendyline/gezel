import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let input: Record<string, unknown> = {};
  let output: unknown;
  return {
    files,
    begin(next: Record<string, unknown>) { input = next; output = undefined; },
    result() { return output; },
    gezel: {
      get input() { return input; },
      output(value: unknown) { output = value; },
      artifacts: {
        async read(path: string) { const value = files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; },
        async write(path: string, content: string) { files.set(path, content); },
      },
    },
  };
});
vi.mock('@bendyline/gezel-sdk', () => ({ defineScript: <T>(meta: T) => meta, gezel: h.gezel }));

beforeEach(() => {
  h.files.clear();
  h.files.set('pr-review/batches.json', JSON.stringify([
    { batchNumber: 1, paths: ['a.ts'], records: ['data/a.md'] },
    { batchNumber: 2, paths: ['b.ts'], records: ['data/b.md'] },
  ]));
});
describe('publishCorpusCoverageShard', () => {
  it('copies only the selected exact batch after the gate has approved it', async () => {
    h.begin({ batchesFile: 'pr-review/batches.json', batchNumber: '2', outFile: 'pr-review/coverage-2.json' });
    vi.resetModules();
    await import('./publishCorpusCoverageShard');
    expect(h.result()).toMatchObject({ ok: true, files: 1 });
    expect(JSON.parse(h.files.get('pr-review/coverage-2.json')!)).toEqual({
      batchNumber: 2, reviewedFiles: ['b.ts'], reviewedRecords: ['data/b.md'],
    });
  });
  it('fails closed on a missing batch instead of publishing arbitrary coverage', async () => {
    h.begin({ batchesFile: 'pr-review/batches.json', batchNumber: '3', outFile: 'pr-review/coverage-3.json' });
    vi.resetModules();
    await expect(import('./publishCorpusCoverageShard')).rejects.toThrow(/invalid exact paths/);
    expect(h.files.has('pr-review/coverage-3.json')).toBe(false);
  });
});
