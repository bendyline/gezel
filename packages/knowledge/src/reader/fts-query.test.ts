/**
 * The document-FTS ranking is the exact-name arm of knowledge search, and the
 * same query the compiler's smoke verification and the validator run. These
 * fixtures are the real rows that ranked wrong under FTS5's default `rank`
 * (every column weighted alike), trimmed to what the ranking sees.
 */

import { describe, expect, it } from 'vitest';
import { ROUTER_DDL } from '../format/ddl.js';
import { DatabaseSync } from '../format/node-sqlite.js';
import { documentFtsTopIds, documentSmokeQueryMisses, sanitizeFtsQuery } from './fts-query.js';

function routerWith(
  rows: Array<{ id: string; title: string; summary?: string; aliases?: string }>,
) {
  const db = new DatabaseSync(':memory:');
  db.exec(ROUTER_DDL);
  const insert = db.prepare(
    'INSERT INTO fts_documents (title, summary, aliases, document_id) VALUES (?, ?, ?, ?)',
  );
  for (const r of rows) insert.run(r.title, r.summary ?? '', r.aliases ?? '', r.id);
  return db;
}

function top(db: DatabaseSync, query: string, limit = 5): string[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  return documentFtsTopIds(db, match, limit, query);
}

describe('documentFtsTopIds', () => {
  it('finds a series page by its own title, not the siblings whose summary repeats its words', () => {
    // Siblings carry the Wikidata description "vice presidential candidate
    // selection" as their summary — four query words in a four-word column —
    // and outranked the 1944 page, which differs only by its year.
    const siblings = [1948, 1952, 1956, 1960, 1964, 1968, 1976, 1988].map((year) => ({
      id: `vp-${year}`,
      title: `${year} Republican Party vice presidential candidate selection`,
      summary: 'vice presidential candidate selection',
      aliases: `${year} Republican Party vice presidential candidate selection`,
    }));
    // A real catalog is mostly unrelated documents, which is what gives the
    // shared words their weight: with nine rows alone every word is in every
    // row, BM25 ignores them, and the year decides.
    const filler = Array.from({ length: 300 }, (_, i) => ({
      id: `f${i}`,
      title: `Unrelated article ${i}`,
      summary: 'a document about something else entirely',
    }));
    const db = routerWith([
      ...filler,
      ...siblings,
      {
        id: 'vp-1944',
        title: '1944 Republican Party vice presidential candidate selection',
        summary:
          'This article lists those who were potential candidates for the Republican nomination for Vice President of the United States in the 1944 election.',
        aliases: '1944 Republican Party vice presidential candidate selection',
      },
    ]);
    // The column weights alone (no exact-title boost) must rank it first.
    const query = '1944 Republican Party vice presidential candidate selection';
    expect(documentFtsTopIds(db, sanitizeFtsQuery(query) as string, 5)[0]).toBe('vp-1944');
    db.close();
  });

  it('ranks an exact title first, ahead of longer titles that contain it', () => {
    const db = routerWith([
      {
        id: 'coronation',
        title: 'Coronation quiche',
        summary: 'British quiche; a quiche created for the coronation, a quiche of spinach',
        aliases: 'Coronation quiche',
      },
      { id: 'lorraine', title: 'Quiche Lorraine', summary: 'quiche with bacon' },
      {
        id: 'quiche',
        title: 'Quiche',
        summary: 'French tart consisting of pastry crust filled with savoury custard',
      },
    ]);
    expect(top(db, 'Quiche')[0]).toBe('quiche');
    expect(top(db, 'quiche')[0]).toBe('quiche'); // case-insensitive
    db.close();
  });

  it('keeps the smoke check in lockstep with search', () => {
    const db = routerWith([
      { id: 'a', title: 'Abbey', summary: 'monastery' },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `x${i}`,
        title: `Something ${i}`,
        summary: 'an abbey, near the abbey, beside another abbey',
      })),
    ]);
    expect(documentSmokeQueryMisses(db, { query: 'Abbey', expectedDocumentIds: ['a'] })).toEqual(
      [],
    );
    db.close();
  });
});
