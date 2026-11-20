import { createRequire } from 'node:module';
import {
  BGE_SMALL_EN_V15_1,
  KNOWLEDGE_VECTOR_FLOORS,
  MULTILINGUAL_E5_SMALL_2,
} from '@bendyline/gezel-knowledge/browser';
import { describe, expect, it } from 'vitest';
import { markdownChunksByCharacters } from './chunks.js';
import { LiveIndex } from './live-index.js';
import type { SqlDatabase } from './sql.js';
import { liveIndexEmbedding } from './vectors.js';

type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

const STOP = new Set(['the', 'a', 'and', 'of', 'to', 'in', 'under', 'with', 'them', 'is', 'for']);
const words = (text: string) =>
  (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !STOP.has(w));
const countTokens = (text: string) => words(text).length;

/** A seeded pseudo-random direction per word; distinct words are near orthogonal in 384-d. */
function wordVector(word: string): Float32Array {
  let seed = 2166136261;
  for (const character of word) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  const out = new Float32Array(384);
  for (let i = 0; i < out.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  return out;
}

/** Stand-in embedder: the sum of its words' directions (the index normalizes). */
function embed(text: string): Float32Array {
  const out = new Float32Array(384);
  for (const word of words(text)) {
    const vector = wordVector(word);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (vector[i] as number);
  }
  if (out.every((value) => value === 0)) out[0] = 1;
  return out;
}

function open(db: SqlDatabase, profile = BGE_SMALL_EN_V15_1): LiveIndex {
  return LiveIndex.open(db, { ...liveIndexEmbedding(profile, countTokens), appVersion: 'test@1' });
}

function embedAll(index: LiveIndex): number {
  let stored = 0;
  for (;;) {
    const pending = index.pendingEmbeddings(16);
    if (pending.length === 0) return stored;
    index.storeEmbeddings(pending.map(({ hash, input }) => ({ hash, vector: embed(input) })));
    stored += pending.length;
  }
}

const garden =
  '# Garden notes\n\n## Pests\n\nAphids gather under the leaves; soap spray clears them.\n';
const kitchen = '# Kitchen\n\nRoast tomatoes slowly with garlic and thyme.\n';

describe('LiveIndex vectors', () => {
  it('hands out passages awaiting vectors, as the embedder must see them', () => {
    const index = open(new DatabaseSync(':memory:'));
    index.upsert({ path: 'garden.md', version: '1', title: 'Garden notes', body: garden });
    index.upsert({ path: 'kitchen.md', version: '1', title: 'Kitchen', body: kitchen });
    const pending = index.pendingEmbeddings();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const aphids = pending.find((entry) => entry.input.includes('Aphids'));
    // bge has no passage instruction: header (title, then heading path) and the chunk.
    expect(aphids?.input.startsWith('Garden notes\nPests\n')).toBe(true);
    expect(index.embeddingStats()).toEqual({ total: pending.length, embedded: 0 });

    expect(embedAll(index)).toBe(pending.length);
    expect(index.pendingEmbeddings()).toEqual([]);
    expect(index.embeddingStats()).toEqual({ total: pending.length, embedded: pending.length });
  });

  it('finds the passage nearest in meaning, and nothing below the measured floor', () => {
    const index = open(new DatabaseSync(':memory:'));
    index.upsert({ path: 'garden.md', version: '1', title: 'Garden notes', body: garden });
    index.upsert({ path: 'kitchen.md', version: '1', title: 'Kitchen', body: kitchen });
    embedAll(index);

    const [best] = index.semanticSearch(embed('aphids on the leaves, soap spray'), { floor: 0.2 });
    expect(best).toMatchObject({ path: 'garden.md', headingPath: ['Garden notes', 'Pests'] });
    expect(best?.similarity).toBeGreaterThan(0.2);
    expect(best?.snippet).toContain('Aphids gather');

    // The profile's measured floor by default: an unrelated question finds nothing,
    // the passage's own text clears it.
    expect(KNOWLEDGE_VECTOR_FLOORS[BGE_SMALL_EN_V15_1.id]).toBe(0.55);
    expect(index.semanticSearch(embed('quarterly budget spreadsheet totals'))).toEqual([]);
    const pending = 'Kitchen\nRoast tomatoes slowly with garlic and thyme.';
    expect(index.semanticSearch(embed(pending))[0]?.path).toBe('kitchen.md');
  });

  it('never re-embeds unchanged text, and identical passages share one vector', () => {
    const index = open(new DatabaseSync(':memory:'));
    index.upsert({ path: 'a.md', version: '1', title: 'Note', body: 'Heron at the pond.' });
    embedAll(index);
    index.upsert({ path: 'a.md', version: '2', title: 'Note', body: 'Heron at the pond.' });
    index.upsert({ path: 'copy.md', version: '1', title: 'Note', body: 'Heron at the pond.' });
    expect(index.pendingEmbeddings()).toEqual([]);
    const hits = index.semanticSearch(embed('Note\nHeron at the pond.'));
    expect(hits.map((hit) => hit.path).sort()).toEqual(['a.md', 'copy.md']);

    index.upsert({ path: 'a.md', version: '3', title: 'Note', body: 'Kingfisher at the pond.' });
    expect(index.pendingEmbeddings()).toHaveLength(1);
  });

  it('drops vectors and marks documents stale when the profile changes', () => {
    const db = new DatabaseSync(':memory:');
    const bge = open(db);
    bge.upsert({ path: 'garden.md', version: '1', title: 'Garden notes', body: garden });
    embedAll(bge);
    expect(bge.embeddingStats().embedded).toBeGreaterThan(0);

    const e5 = open(db, MULTILINGUAL_E5_SMALL_2);
    expect(e5.reset).toBeNull();
    expect(e5.stats().stale).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get()?.n).toBe(0);
    e5.rechunkStale();
    const pending = e5.pendingEmbeddings();
    // e5 prefixes passages with its passage instruction.
    expect(pending[0]?.input.startsWith(MULTILINGUAL_E5_SMALL_2.passageInstruction)).toBe(true);
    embedAll(e5);
    expect(e5.semanticSearch(embed('aphids leaves soap spray'), { floor: null })[0]?.path).toBe(
      'garden.md',
    );
  });

  it('fuses the passages that match the words with those that mean the same', () => {
    const index = open(new DatabaseSync(':memory:'));
    index.upsert({ path: 'garden.md', version: '1', title: 'Garden notes', body: garden });
    index.upsert({ path: 'kitchen.md', version: '1', title: 'Kitchen', body: kitchen });
    index.upsert({ path: 'soap.md', version: '1', title: 'Errands', body: 'Buy soap and stamps.' });
    embedAll(index);

    const hits = index.hybridSearch('soap', embed('aphids leaves pests soap spray garden'), {
      floor: 0.2,
    });
    const gardenHit = hits.find((hit) => hit.path === 'garden.md');
    expect(gardenHit?.arms).toEqual({ lexical: expect.any(Number), vector: expect.any(Number) });
    expect(hits.map((hit) => hit.path)).toContain('soap.md');
    expect(hits[0]?.path).toBe('garden.md');
    // Without a query vector it is the lexical search.
    expect(
      index
        .hybridSearch('soap', null)
        .map((hit) => hit.path)
        .sort(),
    ).toEqual(['garden.md', 'soap.md']);
  });

  it('prunes vectors whose text no passage holds', () => {
    const index = open(new DatabaseSync(':memory:'));
    index.upsert({ path: 'a.md', version: '1', title: 'A', body: 'Heron at the pond.' });
    index.upsert({ path: 'b.md', version: '1', title: 'B', body: 'Kingfisher on the wire.' });
    embedAll(index);
    index.remove('b.md');
    expect(index.pruneEmbeddings()).toBe(1);
    expect(index.pruneEmbeddings()).toBe(0);
    expect(index.semanticSearch(embed('A\nHeron at the pond.'))[0]?.path).toBe('a.md');
  });

  it('is lexical only without a profile', () => {
    const index = LiveIndex.open(new DatabaseSync(':memory:'), {
      chunking: markdownChunksByCharacters(),
      appVersion: 'test@1',
    });
    index.upsert({ path: 'a.md', version: '1', title: 'A', body: 'Heron at the pond.' });
    expect(index.pendingEmbeddings()).toEqual([]);
    expect(index.semanticSearch(embed('heron'))).toEqual([]);
    expect(() => index.storeEmbeddings([{ hash: 'a'.repeat(64), vector: embed('x') }])).toThrow();
    expect(index.hybridSearch('heron', null)[0]?.path).toBe('a.md');
  });
});
