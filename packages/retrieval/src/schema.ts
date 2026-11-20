import type { SqlDatabase } from './sql.js';

/**
 * Bumped for a change an existing database cannot be migrated across; the
 * index is then dropped and rebuilt, and the app re-ingests its documents.
 */
export const LIVE_INDEX_SCHEMA = 1;

/**
 * bm25() column weights for `fts_chunks`, in column order. A document's own
 * name outranks a heading, which outranks a passing mention: the shape of a
 * person searching their own notes, where the note titled "Visa renewal" is
 * the answer to "visa renewal" far more often than a note that mentions it.
 */
export const LIVE_CHUNK_FTS_WEIGHTS = { title: 5, heading: 2, text: 1 } as const;

/**
 * Documents keep the full text that was chunked (`body`), so a change of
 * chunker re-chunks from the index alone, with no file reads. A chunk keeps
 * no copy of its text: `text_start`/`text_length` locate it in `body` (in
 * code points, which is how SQLite's substr() counts), and `text_inline`
 * holds the text only for the rare chunk that is not a slice of it (a long
 * line the chunker re-joined sentence by sentence).
 *
 * `fts_chunks` is an external-content FTS5 table over the `chunk_content`
 * view, so snippets read the text through the view and the index holds only
 * postings. Its rows must be deleted with the exact values they were indexed
 * with, which the view supplies as long as a document's chunks are unindexed
 * before the document row changes.
 *
 * `fts_chunks_vocab` answers "how many chunks contain this term" from the
 * index's own term list, which is what lets a query drop words too common to
 * rank by without counting matches.
 */
const DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE documents(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload BLOB,
  chunked_with TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chunks(
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  heading_text TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  text_start INTEGER,
  text_length INTEGER,
  text_inline TEXT
);
CREATE INDEX chunks_document ON chunks(document_id, ordinal);

CREATE VIEW chunk_content AS
  SELECT c.id AS id, c.document_id AS document_id, d.title AS title,
         c.heading_text AS heading_text,
         COALESCE(c.text_inline, substr(d.body, c.text_start + 1, c.text_length)) AS text
  FROM chunks c JOIN documents d ON d.id = c.document_id;

CREATE VIRTUAL TABLE fts_chunks USING fts5(
  title, heading_text, text,
  content = 'chunk_content', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE VIRTUAL TABLE fts_chunks_vocab USING fts5vocab(fts_chunks, row);
`;

export function createLiveIndexSchema(db: SqlDatabase): void {
  db.exec(DDL);
}

export function dropLiveIndexSchema(db: SqlDatabase): void {
  db.exec(`
    DROP TABLE IF EXISTS fts_chunks_vocab;
    DROP TABLE IF EXISTS fts_chunks;
    DROP VIEW IF EXISTS chunk_content;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS meta;
  `);
}
