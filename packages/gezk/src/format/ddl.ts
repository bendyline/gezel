/**
 * Index schema 4 and 5 DDL. Readers never migrate these. Every table is plain
 * SQLite (FTS5 is the only virtual-table module used), so any SQLite client
 * can read a catalog without extensions. The router is identical in both
 * generations; schema 5 adds media columns to the shard `chunks` table.
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

CREATE TABLE document_locations(
  document_id TEXT NOT NULL REFERENCES documents(id),
  location_id TEXT NOT NULL,
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude < 180),
  role TEXT NOT NULL CHECK (role IN ('subject','associated')),
  provenance_json TEXT,
  PRIMARY KEY (document_id, location_id)
) WITHOUT ROWID;
CREATE INDEX document_locations_latitude ON document_locations(latitude, longitude, document_id);
CREATE INDEX document_locations_longitude ON document_locations(longitude, latitude, document_id);

-- Includes the primary placement in documents.topic_id/ordinal as well as
-- shared TOC references. Bodies, chunks and vectors remain keyed by document id.
CREATE TABLE topic_documents(
  topic_id TEXT NOT NULL REFERENCES topics(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  ordinal INTEGER CHECK (ordinal IS NULL OR
    (typeof(ordinal) = 'integer' AND ordinal BETWEEN -2147483648 AND 2147483647)),
  PRIMARY KEY (topic_id, document_id)
) WITHOUT ROWID;
CREATE INDEX topic_documents_document ON topic_documents(document_id);
CREATE INDEX topic_documents_order ON topic_documents(topic_id, ordinal, document_id);

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
 * `chunk_vectors_bit.v` holds ceil(dim/8) bytes of sign bits (LSB-first; of
 * the unit vector for a `sign` profile, of `vector − center` for a
 * `centered-sign` profile — the profile echo in the router's meta says
 * which) and `chunk_vectors_int8.v` holds dim signed bytes
 * (symmetric-linear, scale 127, never centered). Two tables, not one, so a
 * stage-1 scan pages in only ceil(dim/8) bytes per row rather than the whole
 * record. Rowid alignment invariant:
 * chunks.id == chunk_vectors_bit.chunk_id == chunk_vectors_int8.chunk_id ==
 * fts_chunks.rowid, dense from 1.
 *
 * Schema 5 (format 0.8) adds media rows to `chunks`: an image, or one time
 * window of a video or audio asset, embedded by the profile's media encoders
 * into the same space as the text. They keep every invariant above, so
 * citations, FTS and both vector tables need no second path. A media row's
 * `text` is its caption, alt text or transcript — what FTS and a text judge
 * can see. Media rows follow a document's text chunks in ordinal order, so
 * adding media never changes a text chunk's id.
 */
function shardDdl(mediaColumns: string, mediaIndex: string): string {
  return `
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
  text TEXT NOT NULL${mediaColumns}
);
CREATE UNIQUE INDEX chunks_uid ON chunks(chunk_uid);
CREATE INDEX chunks_document ON chunks(document_id, ordinal);${mediaIndex}

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
}

const MEDIA_COLUMNS = `,
  modality TEXT NOT NULL DEFAULT 'text'
    CHECK (modality IN ('text','image','video','audio')),
  asset_path TEXT,
  mime_type TEXT,
  width INTEGER, height INTEGER,
  start_ms INTEGER, end_ms INTEGER,
  thumbnail_path TEXT,
  attribution_json TEXT,
  CHECK (modality <> 'text' OR (asset_path IS NULL AND mime_type IS NULL
    AND width IS NULL AND height IS NULL AND start_ms IS NULL AND end_ms IS NULL
    AND thumbnail_path IS NULL AND attribution_json IS NULL)),
  CHECK (modality = 'text' OR (asset_path IS NOT NULL AND mime_type IS NOT NULL)),
  CHECK (modality <> 'image' OR (start_ms IS NULL AND end_ms IS NULL)),
  CHECK (modality NOT IN ('video','audio') OR (start_ms >= 0 AND end_ms > start_ms))`;

const MEDIA_INDEX = `
CREATE INDEX chunks_media ON chunks(modality, id) WHERE modality <> 'text';`;

/** Index schema 4 shard DDL (format 0.7): text rows only. */
export const SHARD_DDL_V4 = shardDdl('', '');
/** Index schema 5 shard DDL (format 0.8): text rows plus media rows. */
export const SHARD_DDL_V5 = shardDdl(MEDIA_COLUMNS, MEDIA_INDEX);
/** The newest shard DDL. */
export const SHARD_DDL = SHARD_DDL_V5;

/** The shard DDL a writer uses for one index schema generation it writes. */
export function shardDdlFor(indexSchemaVersion: 4 | 5): string {
  return indexSchemaVersion === 5 ? SHARD_DDL_V5 : SHARD_DDL_V4;
}
