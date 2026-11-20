import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';
import { markdownChunksByCharacters } from './chunks.js';
import { LiveIndex } from './live-index.js';
import { type WasmSqlite3, openMemoryDatabase, openPoolDatabase } from './sqlite-wasm.js';

// The same build an app ships in its worker; Node runs it in memory (no OPFS).
const sqlite3 = await sqlite3InitModule();
const typed: WasmSqlite3 = sqlite3;

describe('sqlite-wasm adapter', () => {
  it('runs the live index read-write', () => {
    const db = openMemoryDatabase(typed);
    const index = LiveIndex.open(db, {
      chunking: markdownChunksByCharacters(),
      appVersion: 'test@1',
    });
    index.upsert({
      path: 'a.md',
      version: '1',
      title: 'Garden',
      body: '# Garden\n\nAphids under the leaves 🌱.\n',
      payload: new Uint8Array([9, 8, 7]),
    });
    index.upsert({ path: 'b.md', version: '1', title: 'Kitchen', body: 'Roast tomatoes.' });
    expect(index.search('aphids')[0]).toMatchObject({ path: 'a.md', headingPath: ['Garden'] });
    expect([...(index.get('a.md')?.payload ?? [])]).toEqual([9, 8, 7]);
    expect(index.remove('b.md')).toBe(true);
    expect(index.manifest()).toEqual([{ path: 'a.md', version: '1' }]);
    db.exec("INSERT INTO fts_chunks(fts_chunks, rank) VALUES('integrity-check', 1)");
    expect(
      LiveIndex.open(db, { chunking: markdownChunksByCharacters(), appVersion: 'test@1' }).reset,
    ).toBeNull();
    db.close();
  });

  it('refuses a pool where origin-private storage is unavailable', async () => {
    await expect(
      openPoolDatabase(typed, { pool: 'test', filename: '/index.sqlite3' }),
    ).rejects.toThrow();
  });
});
