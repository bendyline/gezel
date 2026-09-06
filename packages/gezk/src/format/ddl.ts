/**
 * Index schema 3 DDL. Readers never migrate these. Every table is plain
 * SQLite (FTS5 is the only virtual-table module used), so any SQLite client
 * can read a catalog without extensions.
 */

export const ROUTER_DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE topics(
  id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
  description TEXT, sort_key TEXT NOT NULL, document_count INTEGER NOT NULL
);

CREATE TABLE documents(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, slug TEXT NOT NULL, summary TEXT,
  language TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topics(id),
  ordinal INTEGER,
  shard_id INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_url TEXT, source_revision TEXT, source_updated_at TEXT,
  attribution_json TEXT,
  meta_json TEXT,
  body_codec TEXT NOT NULL CHECK (body_codec IN ('none','br')),
  body_blob BLOB NOT NULL
);
CREATE INDEX documents_topic ON documents(topic_id, ordinal, slug);
CREATE INDEX documents_shard ON documents(shard_id);

CREATE TABLE aliases(alias TEXT NOT NULL, document_id TEXT NOT NULL,
  PRIMARY KEY (alias, document_id)) WITHOUT ROWID;

CREATE TABLE shards(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  chunk_count INTEGER NOT NULL, document_count INTEGER NOT NULL,
  topic_ids_json TEXT NOT NULL, centroid_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);

CREATE TABLE route_centroids(
  id INTEGER PRIMARY KEY,
  shard_id INTEGER NOT NULL REFERENCES shards(id),
  embedding BLOB NOT NULL,
  weight INTEGER NOT NULL
);
CREATE INDEX route_centroids_shard ON route_centroids(shard_id);

CREATE VIRTUAL TABLE fts_documents USING fts5(
  title, summary, aliases, document_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
`;

/**
 * Per-shard tables. Vectors are plain BLOB columns keyed by chunk id:
 * `chunk_vectors_bit.v` holds ceil(dim/8) bytes of sign bits (LSB-first) and
 * `chunk_vectors_int8.v` holds dim signed bytes (symmetric-linear, scale
 * 127). Two tables, not one, so a stage-1 scan pages in 48 bytes per row
 * rather than the whole record. Rowid alignment invariant:
 * chunks.id == chunk_vectors_bit.chunk_id == chunk_vectors_int8.chunk_id ==
 * fts_chunks.rowid, dense from 1.
 */
export const SHARD_DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE chunks(
  id INTEGER PRIMARY KEY,
  chunk_uid TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  heading_text TEXT NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX chunks_uid ON chunks(chunk_uid);
CREATE INDEX chunks_document ON chunks(document_id, ordinal);

CREATE VIRTUAL TABLE fts_chunks USING fts5(
  title, heading_text, text,
  content = 'chunks', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE chunk_vectors_bit(
  chunk_id INTEGER PRIMARY KEY,
  v BLOB NOT NULL
);

CREATE TABLE chunk_vectors_int8(
  chunk_id INTEGER PRIMARY KEY,
  v BLOB NOT NULL
);
`;
