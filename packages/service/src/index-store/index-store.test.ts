import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexGitignore } from './gitignore.js';
import { IndexStore } from './index-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-index-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openStore(): Promise<IndexStore> {
  const store = await IndexStore.open(join(dir, 'index.db'), {
    collectionId: 'proj-1',
    kind: 'workspace',
    rootPath: dir,
  });
  expect(store).not.toBeNull();
  return store as IndexStore;
}

describe('IndexStore', () => {
  it('roundtrips import bindings, distinguishing [] from unrecorded', async () => {
    const store = await openStore();
    store.putImports('src/a.ts', 'h1', [
      { raw: './b.js', bindings: [{ name: 'foo', local: 'f', kind: 'named' }] },
      { raw: './side.js', bindings: [] },
      { raw: 'fmt' }, // unrecorded (legacy / undissected language)
    ]);
    const byRaw = new Map(store.allImportsWithBindings().map((i) => [i.raw, i.bindings]));
    expect(byRaw.get('./b.js')).toEqual([{ name: 'foo', local: 'f', kind: 'named' }]);
    expect(byRaw.get('./side.js')).toEqual([]);
    expect(byRaw.get('fmt')).toBeNull();
    expect(store.importsForFile('src/a.ts')).toHaveLength(3);
    store.close();
  });

  it('symbol summaries are hash-keyed and cascade on deleteFile', async () => {
    const store = await openStore();
    store.putSymbolSummaries('src/a.ts', 'h1', [{ name: 'foo', summary: 'Does x.' }], 'm');
    expect(store.symbolSummariesFor('src/a.ts', 'h1').get('foo')).toBe('Does x.');
    // Wrong hash → nothing (stale rows are never served).
    expect(store.symbolSummariesFor('src/a.ts', 'h2').size).toBe(0);
    // A rewrite for a new hash prunes the old hash's rows.
    store.putSymbolSummaries('src/a.ts', 'h2', [{ name: 'foo', summary: 'Does y.' }], 'm');
    expect(store.symbolSummariesFor('src/a.ts', 'h1').size).toBe(0);
    expect(store.symbolSummariesFor('src/a.ts', 'h2').get('foo')).toBe('Does y.');
    store.deleteFile('src/a.ts');
    expect(store.symbolSummariesFor('src/a.ts', 'h2').size).toBe(0);
    store.close();
  });

  it('setMetadata preserves reserved git: keys; prefix replace + bulk read work', async () => {
    const store = await openStore();
    store.replaceMetadataForKeyPrefix('git:', [
      { path: 'src/a.ts', key: 'git:commits365', value: '7' },
      { path: 'src/a.ts', key: 'git:lastCommitAt', value: '2026-01-01T00:00:00Z' },
      { path: 'src/gone.ts', key: 'git:commits365', value: '2' },
    ]);
    // A frontmatter-style rewrite must not clobber the git rows.
    store.setMetadata('src/a.ts', [{ key: 'title', value: 'A' }]);
    expect(store.getMetadata('src/a.ts')).toEqual({
      title: 'A',
      'git:commits365': '7',
      'git:lastCommitAt': '2026-01-01T00:00:00Z',
    });
    // A later prefix replace prunes rows for paths no longer present.
    store.replaceMetadataForKeyPrefix('git:', [
      { path: 'src/a.ts', key: 'git:commits365', value: '8' },
    ]);
    expect(store.getMetadata('src/gone.ts')).toEqual({});
    expect(store.getMetadata('src/a.ts')['git:commits365']).toBe('8');
    // But non-git metadata survives the git-prefix replace.
    expect(store.getMetadata('src/a.ts').title).toBe('A');

    store.mergeMetadata('src/a.ts', [{ key: 'title', value: 'B' }]);
    expect(store.getMetadata('src/a.ts').title).toBe('B');

    const bulk = store.metadataValuesForKeys(['git:commits365', 'git:lastCommitAt']);
    expect(bulk.get('src/a.ts')).toEqual({ 'git:commits365': '8' });
    expect(store.metadataValuesForKeys([]).size).toBe(0);
    store.close();
  });

  it('opens, applies schema, and roundtrips files', async () => {
    const store = await openStore();
    store.upsertFile({
      path: 'src/a.ts',
      hash: 'h1',
      size: 100,
      mtimeMs: 1,
      lang: 'ts',
      kind: 'code',
      modality: 'code',
      trivial: false,
      indexedAt: '2026-06-06T00:00:00Z',
      loc: 42,
    });
    const f = store.getFile('src/a.ts');
    expect(f?.hash).toBe('h1');
    expect(f?.modality).toBe('code');
    expect(f?.loc).toBe(42);
    expect(store.allFiles()).toHaveLength(1);
    store.close();
  });

  it('stores and finds symbols by name and by file', async () => {
    const store = await openStore();
    store.putSymbols('src/a.ts', 'h1', [
      {
        name: 'doThing',
        kind: 'function',
        lineStart: 10,
        lineEnd: 20,
        signature: 'function doThing()',
      },
      { name: 'Helper', kind: 'class', lineStart: 30, lineEnd: 60, signature: 'class Helper' },
    ]);
    const hits = store.searchSymbols({ name: 'doThing' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      filePath: 'src/a.ts',
      kind: 'function',
      lineStart: 10,
      lineEnd: 20,
      id: 'src/a.ts#doThing',
    });
    expect(store.symbolsForFile('src/a.ts')).toHaveLength(2);

    // Re-putting replaces (idempotent re-index of the file).
    store.putSymbols('src/a.ts', 'h2', [
      { name: 'doThing', kind: 'function', lineStart: 11, lineEnd: 21 },
    ]);
    expect(store.symbolsForFile('src/a.ts')).toHaveLength(1);
    store.close();
  });

  it('keyword-searches chunk text via FTS', async () => {
    const store = await openStore();
    if (!store.ftsAvailable) return store.close();
    store.putChunks('docs/readme.md', 'h1', [
      { kind: 'paragraph', lineStart: 1, lineEnd: 3, text: 'the quick brown fox jumps' },
      { kind: 'paragraph', lineStart: 4, lineEnd: 6, text: 'lazy dogs sleep all day' },
    ]);
    const hits = store.searchDocs('brown');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe('docs/readme.md');
    expect(hits[0]?.lineStart).toBe(1);
    store.close();
  });

  it('roundtrips a vector and finds the nearest neighbour', async () => {
    const store = await openStore();
    if (!store.vecAvailable) return store.close();
    const ids = store.putChunks('src/a.ts', 'h1', [
      { kind: 'symbol', lineStart: 1, lineEnd: 5, text: 'alpha' },
      { kind: 'symbol', lineStart: 6, lineEnd: 9, text: 'beta' },
    ]);
    const dim = 384;
    const va = new Float32Array(dim).fill(0);
    va[0] = 1;
    const vb = new Float32Array(dim).fill(0);
    vb[1] = 1;
    store.addTextVector(ids[0]!, va);
    store.addTextVector(ids[1]!, vb);

    const hits = store.searchTextVectors(va, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunkId).toBe(ids[0]);
    expect(hits[0]?.text).toBe('alpha');
    store.close();
  });

  it('upserts and reads a summary', async () => {
    const store = await openStore();
    store.upsertSummary({
      contentHash: 'h1',
      filePath: 'src/a.ts',
      summaryMd: 'Handles widget rendering.',
      model: 'test',
    });
    expect(store.getSummary('h1')).toBe('Handles widget rendering.');
    store.close();
  });

  it('writes a gitignore that covers the index subtree', async () => {
    await ensureIndexGitignore(dir);
    const gi = await readFile(join(dir, '.gezel', 'index', '.gitignore'), 'utf8');
    expect(gi.trim()).toBe('*');
  });
});
