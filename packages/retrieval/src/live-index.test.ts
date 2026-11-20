import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { markdownChunksByCharacters, markdownChunksByTokens } from './chunks.js';
import { LiveIndex, type LiveIndexOptions } from './live-index.js';
import type { SqlDatabase } from './sql.js';

// Loaded by name: bundlers strip the `node:` prefix, and `sqlite` exists only with it.
type NodeSqlite = typeof import('node:sqlite');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;

const options: LiveIndexOptions = {
  chunking: markdownChunksByCharacters(),
  appVersion: 'test@1',
  now: () => 1_700_000_000_000,
};

function memory(): SqlDatabase {
  return new DatabaseSync(':memory:');
}

/** FTS5's own consistency check of the index against the content view. */
function assertIntact(db: SqlDatabase): void {
  db.exec("INSERT INTO fts_chunks(fts_chunks, rank) VALUES('integrity-check', 1)");
}

function chunkTexts(db: SqlDatabase, path: string): string[] {
  return db
    .prepare(
      `SELECT v.text AS text FROM chunk_content v JOIN documents d ON d.id = v.document_id
       WHERE d.path = ? ORDER BY v.id`,
    )
    .all(path)
    .map((row) => String(row.text));
}

const garden = `# Garden notes

Tomatoes need full sun and steady water.

## Pests

Aphids gather under the leaves; a soap spray clears them.

## Harvest

Pick zucchini small, before the seeds harden.
`;

describe('LiveIndex', () => {
  it('creates its schema once and reopens without resetting', () => {
    const db = memory();
    expect(LiveIndex.open(db, options).reset).toBe('created');
    const index = LiveIndex.open(db, options);
    expect(index.reset).toBeNull();
    expect(index.stats()).toEqual({ documents: 0, chunks: 0, stale: 0 });
  });

  it('finds passages with their heading path, line span and highlighted snippet', () => {
    const db = memory();
    const index = LiveIndex.open(db, options);
    index.upsert({ path: 'garden.md', version: 'v1', title: 'Garden notes', body: garden });
    index.upsert({
      path: 'kitchen.md',
      version: 'v1',
      title: 'Kitchen',
      body: '# Kitchen\n\nRoast the tomatoes slowly.\n',
    });

    const [hit] = index.search('aphids');
    expect(hit?.path).toBe('garden.md');
    expect(hit?.headingPath).toEqual(['Garden notes', 'Pests']);
    expect(hit?.lineStart).toBe(5);
    expect(hit?.lineEnd).toBeGreaterThanOrEqual(7);
    const range = hit?.ranges[0];
    expect(range).toBeDefined();
    expect(hit?.snippet.slice(range?.[0], range?.[1])).toBe('Aphids');
    assertIntact(db);
  });

  it('reads the full text of passages a search found', () => {
    const index = LiveIndex.open(memory(), options);
    index.upsert({ path: 'garden.md', version: 'v1', title: 'Garden notes', body: garden });
    const [hit] = index.search('aphids');
    const texts = index.passageTexts([hit?.chunk ?? -1, hit?.chunk ?? -1, 999_999]);
    expect([...texts.keys()]).toEqual([hit?.chunk]);
    expect(texts.get(hit?.chunk ?? -1)).toContain('Aphids gather under the leaves');
    expect(index.passageTexts([]).size).toBe(0);
  });

  it('ranks a document named by the query above one that mentions it', () => {
    const index = LiveIndex.open(memory(), options);
    index.upsert({
      path: 'a.md',
      version: '1',
      title: 'Weekly review',
      body: 'Done: the visa renewal form.',
    });
    index.upsert({ path: 'b.md', version: '1', title: 'Visa renewal', body: 'Steps and fees.' });
    expect(index.search('visa renewal').map((hit) => hit.path)).toEqual(['b.md', 'a.md']);
  });

  it('replaces a document so only its new text matches', () => {
    const db = memory();
    const index = LiveIndex.open(db, options);
    index.upsert({ path: 'n.md', version: '1', title: 'Note', body: 'The heron waits.' });
    index.upsert({ path: 'n.md', version: '2', title: 'Renamed', body: 'The kingfisher dives.' });
    expect(index.search('heron')).toEqual([]);
    expect(index.search('kingfisher')[0]?.title).toBe('Renamed');
    expect(index.search('note')).toEqual([]);
    expect(index.manifest()).toEqual([{ path: 'n.md', version: '2' }]);
    assertIntact(db);
  });

  it('removes a document from search and the manifest', () => {
    const db = memory();
    const index = LiveIndex.open(db, options);
    index.upsert({ path: 'a.md', version: '1', title: 'A', body: 'lantern' });
    index.upsert({ path: 'b.md', version: '1', title: 'B', body: 'lantern' });
    expect(index.remove('a.md')).toBe(true);
    expect(index.remove('a.md')).toBe(false);
    expect(index.search('lantern').map((hit) => hit.path)).toEqual(['b.md']);
    expect(index.manifest().map((entry) => entry.path)).toEqual(['b.md']);
    assertIntact(db);
  });

  it('stores the payload untouched and returns documents in batches', () => {
    const index = LiveIndex.open(memory(), options);
    const payload = new Uint8Array([0, 1, 2, 255]);
    for (let n = 0; n < 7; n++) {
      index.upsert({
        path: `d${n}.md`,
        version: String(n),
        title: `D${n}`,
        body: 'x',
        payload: n === 3 ? payload : null,
      });
    }
    expect([...(index.get('d3.md')?.payload ?? [])]).toEqual([0, 1, 2, 255]);
    expect(index.get('d4.md')?.payload).toBeNull();
    expect(index.get('missing.md')).toBeNull();
    expect([...index.documents(2)].map((document) => document.path)).toHaveLength(7);
  });

  it('keeps chunk text as offsets into the body, astral characters and CRLF included', () => {
    const db = memory();
    const index = LiveIndex.open(db, options);
    const body =
      '# Trip 🏔️ notes\r\n\r\nPack 🧦 socks and a 🔦 torch.\r\n\r\n## Day 2 🌧️\r\n\r\nRain; read 📚 instead.\r\n';
    index.upsert({ path: 'trip.md', version: '1', title: 'Trip', body });
    const lf = body.replace(/\r\n/g, '\n');
    for (const text of chunkTexts(db, 'trip.md')) expect(lf).toContain(text);
    const inline = db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE text_inline IS NOT NULL')
      .get();
    expect(Number(inline?.n)).toBe(0);
    expect(index.body('trip.md')).toBe(lf);
    expect(index.search('torch')[0]?.snippet).toContain('🔦 torch');
    assertIntact(db);
  });

  it('stores text inline for a chunk that is not a slice of the body', () => {
    const db = memory();
    // One word per token: a long line splits by sentence and re-joins with single spaces.
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    const index = LiveIndex.open(db, {
      ...options,
      chunking: markdownChunksByTokens(words, 'words'),
    });
    const sentence = 'Alpha beta gamma delta epsilon.';
    const line = Array.from({ length: 200 }, () => sentence).join('   ');
    index.upsert({ path: 'long.md', version: '1', title: 'Long', body: `${line}\n` });
    const inline = Number(
      db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE text_inline IS NOT NULL').get()?.n,
    );
    expect(inline).toBeGreaterThan(0);
    expect(index.search('epsilon')[0]?.path).toBe('long.md');
    assertIntact(db);
  });

  it('drops a word too common to rank by, keeping the rare one', () => {
    const index = LiveIndex.open(memory(), options);
    for (let n = 0; n < 10; n++) {
      index.upsert({
        path: `common${n}.md`,
        version: '1',
        title: `Common ${n}`,
        body: 'meeting notes',
      });
    }
    index.upsert({
      path: 'rare.md',
      version: '1',
      title: 'Rare',
      body: 'meeting about the zebracorn',
    });
    expect(index.search('meeting zebracorn').map((hit) => hit.path)).toEqual(['rare.md']);
    // A query of only common words still searches for them.
    expect(index.search('meeting', { limit: 50 })).toHaveLength(11);
  });

  it('caps hits per document, honours the limit and leaves out excluded documents', () => {
    const index = LiveIndex.open(memory(), options);
    const sections = Array.from(
      { length: 8 },
      (_, n) => `## Part ${n}\n\n${'heron '.repeat(800)}\n`,
    ).join('\n');
    index.upsert({ path: 'long.md', version: '1', title: 'Long', body: `# Long\n\n${sections}` });
    index.upsert({ path: 'short.md', version: '1', title: 'Short', body: 'one heron' });
    const hits = index.search('heron', { perDocument: 2 });
    expect(hits.filter((hit) => hit.path === 'long.md')).toHaveLength(2);
    expect(index.search('heron', { limit: 1 })).toHaveLength(1);
    expect(index.search('heron', { exclude: new Set(['long.md']) }).map((hit) => hit.path)).toEqual(
      ['short.md'],
    );
  });

  it('matches the last word as a prefix only when asked', () => {
    const index = LiveIndex.open(memory(), options);
    index.upsert({ path: 'fish.md', version: '1', title: 'Fish', body: 'The lanternfish glows.' });
    expect(index.search('lantern')).toEqual([]);
    expect(index.search('lantern', { prefix: true })[0]?.path).toBe('fish.md');
  });

  it('matches without diacritics and finds a document with no text by its title', () => {
    const index = LiveIndex.open(memory(), options);
    index.upsert({
      path: 'cafe.md',
      version: '1',
      title: 'Café list',
      body: 'Crème brûlée at noon.',
    });
    index.upsert({ path: 'empty.md', version: '1', title: 'Quarterly plan', body: '' });
    expect(index.search('creme brulee')[0]?.path).toBe('cafe.md');
    expect(index.search('quarterly')[0]?.path).toBe('empty.md');
  });

  it('treats query text as words, never as FTS syntax', () => {
    const index = LiveIndex.open(memory(), options);
    index.upsert({ path: 'a.md', version: '1', title: 'A', body: 'near the OR gate' });
    expect(() => index.search('"unbalanced NEAR( OR * ^')).not.toThrow();
    expect(index.search('gate AND')[0]?.path).toBe('a.md');
    expect(index.search('   ')).toEqual([]);
  });

  it('empties itself when the app format changes, and rebuilds an unknown schema', () => {
    const db = memory();
    LiveIndex.open(db, options).upsert({ path: 'a.md', version: '1', title: 'A', body: 'text' });
    const next = LiveIndex.open(db, { ...options, appVersion: 'test@2' });
    expect(next.reset).toBe('app');
    expect(next.stats().documents).toBe(0);
    next.upsert({ path: 'b.md', version: '1', title: 'B', body: 'text' });
    db.exec("UPDATE meta SET value = '999' WHERE key = 'schema'");
    const rebuilt = LiveIndex.open(db, { ...options, appVersion: 'test@2' });
    expect(rebuilt.reset).toBe('schema');
    expect(rebuilt.stats().documents).toBe(0);
    assertIntact(db);
  });

  it('re-chunks documents from their stored bodies when the chunking changes', () => {
    const db = memory();
    const first = LiveIndex.open(db, options);
    for (let n = 0; n < 5; n++) {
      first.upsert({
        path: `n${n}.md`,
        version: '1',
        title: `N${n}`,
        body: `# N${n}\n\nheron ${n}\n`,
      });
    }
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    const second = LiveIndex.open(db, {
      ...options,
      chunking: markdownChunksByTokens(words, 'words'),
    });
    expect(second.reset).toBeNull();
    expect(second.stats().stale).toBe(5);
    expect(second.search('heron')).toHaveLength(5);
    expect(second.rechunkStale(3)).toBe(3);
    expect(second.rechunkStale(10)).toBe(2);
    expect(second.rechunkStale(10)).toBe(0);
    expect(second.stats().stale).toBe(0);
    expect(second.search('heron')).toHaveLength(5);
    assertIntact(db);
  });

  it('undoes every write of a failed transaction', () => {
    const db = memory();
    const index = LiveIndex.open(db, options);
    index.upsert({ path: 'keep.md', version: '1', title: 'Keep', body: 'heron' });
    expect(() =>
      index.transaction(() => {
        index.upsert({ path: 'lost.md', version: '1', title: 'Lost', body: 'heron' });
        index.remove('keep.md');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(index.search('heron').map((hit) => hit.path)).toEqual(['keep.md']);
    assertIntact(db);
  });

  it('rejects malformed input before touching the index', () => {
    const index = LiveIndex.open(memory(), options);
    expect(() => index.upsert({ path: '', version: '1', title: 'T', body: '' })).toThrow(TypeError);
    expect(() =>
      index.upsert({
        path: 'a.md',
        version: '1',
        title: 'T',
        body: '',
        payload: 'x' as unknown as Uint8Array,
      }),
    ).toThrow(TypeError);
    expect(index.stats().documents).toBe(0);
  });
});
