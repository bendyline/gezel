import { asymmetricTopK, selectiveFtsQuery } from '@bendyline/gezel-knowledge/browser';
import { sha256Hex } from '@bendyline/gezk';
import {
  type LiveChunking,
  MATCH_CLOSE,
  MATCH_OPEN,
  type PlacedChunk,
  normalizeBody,
  placeChunks,
} from './chunks.js';
import {
  LIVE_CHUNK_FTS_WEIGHTS,
  LIVE_INDEX_SCHEMA,
  createLiveIndexSchema,
  dropLiveIndexSchema,
} from './schema.js';
import type { SqlDatabase, SqlStatement, SqlValue } from './sql.js';
import {
  LIVE_HYBRID_WEIGHTS,
  LIVE_RRF_K,
  type LiveEmbedding,
  embedInputFor,
  excerpt,
  measuredFloor,
  prepareQuery,
  quantizeEmbedding,
  similarity,
} from './vectors.js';

export interface LiveIndexOptions {
  readonly chunking: LiveChunking;
  /**
   * The app's format for `version` and `payload`. When it changes, stored
   * rows no longer mean what the app expects, so the index starts empty.
   */
  readonly appVersion: string;
  /** Milliseconds since the epoch, for `updatedAt`. */
  readonly now?: () => number;
  /**
   * Store vectors for this embedding profile (see `liveIndexEmbedding`).
   * Without it the index is lexical only. Changing it marks every document
   * stale for `rechunkStale()` and drops vectors from the old profile.
   */
  readonly embedding?: LiveEmbedding;
}

/** Why the index opened empty: a new database, an incompatible one, or a new app format. */
export type LiveIndexReset = 'created' | 'schema' | 'app' | null;

export interface LiveDocumentInput {
  /** The app's key for the document, unique in the index (a workspace path, say). */
  readonly path: string;
  /** The app's change token: the index stores it and hands it back in `manifest()`. */
  readonly version: string;
  readonly title: string;
  /** The Markdown to chunk and index. Line numbers in results refer to it. */
  readonly body: string;
  /** Opaque app data stored beside the document, never interpreted. */
  readonly payload?: Uint8Array | null;
}

export interface LiveDocument {
  readonly path: string;
  readonly version: string;
  readonly title: string;
  readonly payload: Uint8Array | null;
  readonly updatedAt: number;
}

export interface LiveManifestEntry {
  readonly path: string;
  readonly version: string;
}

export interface LiveSearchOptions {
  /** Most hits returned; default 20, at most 200. */
  readonly limit?: number;
  /** Most hits from one document; default 3. */
  readonly perDocument?: number;
  /** Match the query's last word as a prefix, for search as you type. */
  readonly prefix?: boolean;
  /** Documents to leave out (the one being edited, say). */
  readonly exclude?: ReadonlySet<string>;
}

export interface LiveSearchHit {
  readonly path: string;
  readonly title: string;
  /** Headings above the passage, outermost first. */
  readonly headingPath: readonly string[];
  /** 1-based inclusive line span of the passage in the document body. */
  readonly lineStart: number;
  readonly lineEnd: number;
  /** An excerpt of the passage around its matches. */
  readonly snippet: string;
  /** Match ranges within `snippet`, as [start, end) UTF-16 offsets. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** Higher is better; comparable within one search. */
  readonly score: number;
  /** The passage's chunk, stable until its document changes. */
  readonly chunk: number;
  /** Cosine similarity to the query, for a hit the vector arm found. */
  readonly similarity?: number;
  /** Rank in each arm that found the hit (1 is best), for a hybrid search. */
  readonly arms?: { readonly lexical?: number; readonly vector?: number };
}

export interface LiveSemanticOptions {
  readonly limit?: number;
  readonly perDocument?: number;
  readonly exclude?: ReadonlySet<string>;
  /**
   * Cosine below which a hit is no evidence. Default: the profile's measured
   * floor; `null` keeps every candidate (calibration, tests).
   */
  readonly floor?: number | null;
}

/** A passage awaiting its vector: embed `input` and hand the result back with `hash`. */
export interface LivePendingEmbedding {
  readonly hash: string;
  readonly input: string;
}

export interface LiveEmbeddingStats {
  /** Distinct passages that need a vector. */
  readonly total: number;
  /** Of those, how many have one. */
  readonly embedded: number;
}

export interface LiveIndexStats {
  readonly documents: number;
  readonly chunks: number;
  /** Documents chunked by an earlier chunking, awaiting `rechunkStale()`. */
  readonly stale: number;
}

const SEARCH_LIMIT_MAX = 200;
/** First-stage candidates per hit asked for, before int8 rescoring. */
const VECTOR_CANDIDATES_PER_HIT = 16;
const VECTOR_CANDIDATES_MIN = 256;
const SNIPPET_TOKENS = 24;
const TERM_CACHE_MAX = 512;
const BM25 = `bm25(fts_chunks, ${LIVE_CHUNK_FTS_WEIGHTS.title}.0, ${LIVE_CHUNK_FTS_WEIGHTS.heading}.0, ${LIVE_CHUNK_FTS_WEIGHTS.text}.0)`;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function requireText(value: unknown, name: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value;
}

/** The term as unicode61 with remove_diacritics stores it, for the vocab table. */
function indexedTerm(phrase: string): string {
  return phrase
    .slice(1, -1)
    .replace(/""/g, '"')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Turn the query's last word into a prefix phrase, if the selective query kept it. */
function withPrefix(query: string, match: string): string {
  const last = /[\p{L}\p{N}_]+$/u.exec(query.normalize('NFKC'))?.[0];
  if (!last) return match;
  const quoted = `"${last.replace(/"/g, '""')}"`;
  return match
    .split(' OR ')
    .map((phrase) => (phrase === quoted ? `${quoted}*` : phrase))
    .join(' OR ');
}

/** Split snippet() output into text and the ranges its markers enclosed. */
function parseSnippet(marked: string): {
  snippet: string;
  ranges: Array<readonly [number, number]>;
} {
  let snippet = '';
  const ranges: Array<readonly [number, number]> = [];
  let open = -1;
  for (const character of marked) {
    if (character === MATCH_OPEN) open = snippet.length;
    else if (character === MATCH_CLOSE) {
      if (open !== -1 && snippet.length > open) ranges.push([open, snippet.length]);
      open = -1;
    } else snippet += character;
  }
  return { snippet, ranges };
}

/**
 * A mutable retrieval index over documents an app owns: each document's
 * Markdown is chunked by heading, indexed with SQLite FTS5, and searchable
 * by BM25 with snippets and line spans. Documents are replaced or removed
 * one at a time, so an app keeps it current as files change and reopens it
 * across launches instead of rebuilding.
 *
 * Runs over any synchronous SQLite handle: `node:sqlite` in Node, or
 * sqlite-wasm on origin-private storage in a Web Worker (`./sqlite-wasm`).
 * The index owns its tables; give it a database of its own.
 */
export class LiveIndex {
  readonly reset: LiveIndexReset;
  readonly #db: SqlDatabase;
  readonly #chunking: LiveChunking;
  readonly #embedding: LiveEmbedding | null;
  /** What `documents.chunked_with` records: the chunking, and the profile hashes are for. */
  readonly #identity: string;
  readonly #now: () => number;
  /** Every stored vector's sign bits in one block, and the hash of each row. */
  #bitIndex: { bits: Uint8Array; bytesPerRow: number; rows: number; hashes: string[] } | null =
    null;
  readonly #statements = new Map<string, SqlStatement>();
  readonly #termRows = new Map<string, number>();
  #chunkCount: number | null = null;
  #savepoints = 0;

  private constructor(db: SqlDatabase, options: LiveIndexOptions, reset: LiveIndexReset) {
    this.#db = db;
    this.#chunking = options.chunking;
    this.#embedding = options.embedding ?? null;
    this.#identity = identityOf(options);
    this.#now = options.now ?? Date.now;
    this.reset = reset;
  }

  /** Open (or create) the index in `db`, emptying it when its schema or the app's format changed. */
  static open(db: SqlDatabase, options: LiveIndexOptions): LiveIndex {
    requireText(options.appVersion, 'appVersion', false);
    requireText(options.chunking?.id, 'chunking.id', false);
    const hasMeta =
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get() !== undefined;
    const meta = (key: string) =>
      hasMeta
        ? (db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value as string | undefined)
        : undefined;
    let reset: LiveIndexReset = null;
    if (!hasMeta) reset = 'created';
    else if (meta('schema') !== String(LIVE_INDEX_SCHEMA)) reset = 'schema';
    else if (meta('app') !== options.appVersion) reset = 'app';

    db.exec('BEGIN');
    try {
      if (reset === 'created' || reset === 'schema') {
        dropLiveIndexSchema(db);
        createLiveIndexSchema(db);
      } else if (reset === 'app') {
        db.exec(
          "INSERT INTO fts_chunks(fts_chunks) VALUES('delete-all'); DELETE FROM chunks; DELETE FROM documents;",
        );
      }
      const profile = options.embedding?.profile.id ?? '';
      // Vectors from another profile are another vector space.
      if (reset === null && meta('embedding') !== profile) db.exec('DELETE FROM embeddings');
      const write = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
      write.run('schema', String(LIVE_INDEX_SCHEMA));
      write.run('app', options.appVersion);
      write.run('chunking', identityOf(options));
      write.run('embedding', profile);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return new LiveIndex(db, options, reset);
  }

  /** Run `fn` atomically; writes inside it are undone if it throws. Nests. */
  transaction<T>(fn: () => T): T {
    const name = `live_${++this.#savepoints}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO ${name}`);
      this.#db.exec(`RELEASE ${name}`);
      this.#changed();
      throw error;
    } finally {
      this.#savepoints--;
    }
  }

  /** Add or replace a document. Returns how many chunks it was indexed as. */
  upsert(input: LiveDocumentInput): { readonly chunks: number } {
    const path = requireText(input.path, 'path', false);
    const version = requireText(input.version, 'version', true);
    const title = requireText(input.title, 'title', true);
    const body = normalizeBody(requireText(input.body, 'body', true));
    const payload = input.payload ?? null;
    if (payload !== null && !(payload instanceof Uint8Array)) {
      throw new TypeError('payload must be a Uint8Array or null');
    }
    const placed = placeChunks(body, this.#chunking);
    return this.transaction(() => {
      const existing = this.#statement('SELECT id FROM documents WHERE path = ?').get(path);
      let id: number;
      if (existing) {
        id = Number(existing.id);
        this.#unindex(id);
        this.#statement(
          `UPDATE documents SET version = ?, title = ?, body = ?, payload = ?, chunked_with = ?,
             updated_at = ? WHERE id = ?`,
        ).run(version, title, body, payload, this.#identity, this.#now(), id);
      } else {
        const row = this.#statement(
          `INSERT INTO documents (path, version, title, body, payload, chunked_with, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        ).get(path, version, title, body, payload, this.#identity, this.#now());
        id = Number(row?.id);
      }
      const chunks = this.#index(id, title, placed);
      this.#changed();
      return { chunks };
    });
  }

  /** Remove a document; false when it was not indexed. */
  remove(path: string): boolean {
    return this.transaction(() => {
      const existing = this.#statement('SELECT id FROM documents WHERE path = ?').get(path);
      if (!existing) return false;
      const id = Number(existing.id);
      this.#unindex(id);
      this.#statement('DELETE FROM documents WHERE id = ?').run(id);
      this.#changed();
      return true;
    });
  }

  /** Remove every document, and every stored vector. */
  clear(): void {
    this.transaction(() => {
      this.#db.exec(
        "INSERT INTO fts_chunks(fts_chunks) VALUES('delete-all'); DELETE FROM chunks; DELETE FROM documents; DELETE FROM embeddings;",
      );
      this.#changed();
      this.#bitIndex = null;
    });
  }

  /** Every document's path and version, for diffing against the app's own listing. */
  manifest(): LiveManifestEntry[] {
    return this.#statement('SELECT path, version FROM documents ORDER BY path')
      .all()
      .map((row) => ({ path: String(row.path), version: String(row.version) }));
  }

  get(path: string): LiveDocument | null {
    const row = this.#statement(
      'SELECT path, version, title, payload, updated_at FROM documents WHERE path = ?',
    ).get(path);
    return row ? toDocument(row) : null;
  }

  /** The body as indexed (LF line endings), or null. */
  body(path: string): string | null {
    const row = this.#statement('SELECT body FROM documents WHERE path = ?').get(path);
    return row ? String(row.body) : null;
  }

  /** Every document in batches, without holding them all in memory. */
  *documents(batchSize = 256): Generator<LiveDocument> {
    const size = clamp(batchSize, 256, 10_000);
    let after = 0;
    for (;;) {
      const rows = this.#statement(
        `SELECT id, path, version, title, payload, updated_at FROM documents
         WHERE id > ? ORDER BY id LIMIT ?`,
      ).all(after, size);
      for (const row of rows) yield toDocument(row);
      if (rows.length < size) return;
      after = Number(rows[rows.length - 1]?.id);
    }
  }

  stats(): LiveIndexStats {
    const row = this.#statement(
      `SELECT (SELECT COUNT(*) FROM documents) AS documents,
              (SELECT COUNT(*) FROM chunks) AS chunks,
              (SELECT COUNT(*) FROM documents WHERE chunked_with != ?) AS stale`,
    ).get(this.#identity);
    return {
      documents: Number(row?.documents ?? 0),
      chunks: Number(row?.chunks ?? 0),
      stale: Number(row?.stale ?? 0),
    };
  }

  /**
   * Re-chunk up to `limit` documents indexed under an earlier chunking, from
   * their stored bodies. Returns how many it did; 0 when none are left.
   * They stay searchable by their old chunks until then.
   */
  rechunkStale(limit = 100): number {
    const rows = this.#statement(
      'SELECT id, title, body FROM documents WHERE chunked_with != ? LIMIT ?',
    ).all(this.#identity, clamp(limit, 100, 100_000));
    if (rows.length === 0) return 0;
    this.transaction(() => {
      for (const row of rows) {
        const id = Number(row.id);
        this.#unindex(id);
        this.#index(id, String(row.title), placeChunks(String(row.body), this.#chunking));
        this.#statement('UPDATE documents SET chunked_with = ? WHERE id = ?').run(
          this.#identity,
          id,
        );
      }
      this.#changed();
    });
    return rows.length;
  }

  /**
   * Best-matching passages for a query, by BM25 over titles, headings and
   * text. The query is plain words, not FTS syntax; words in more than half
   * the passages are dropped, since they cost a full ranking and cannot
   * change its order.
   */
  search(query: string, options: LiveSearchOptions = {}): LiveSearchHit[] {
    const limit = clamp(options.limit, 20, SEARCH_LIMIT_MAX);
    const perDocument = clamp(options.perDocument, 3, SEARCH_LIMIT_MAX);
    const rows = this.#rows();
    if (rows === 0) return [];
    let match = selectiveFtsQuery(requireText(query, 'query', true), rows, (phrase) =>
      this.#termRowCount(phrase),
    );
    if (!match) return [];
    if (options.prefix) match = withPrefix(query, match);

    const candidates = this.#statement(
      `SELECT f.rowid AS id, d.path AS path, ${BM25} AS score
       FROM fts_chunks f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
       WHERE fts_chunks MATCH ? ORDER BY score LIMIT ?`,
    ).all(match, Math.max(200, limit * perDocument * 4));

    const picked: Array<{ id: number; score: number }> = [];
    const perPath = new Map<string, number>();
    for (const row of candidates) {
      const path = String(row.path);
      if (options.exclude?.has(path)) continue;
      const taken = perPath.get(path) ?? 0;
      if (taken >= perDocument) continue;
      perPath.set(path, taken + 1);
      picked.push({ id: Number(row.id), score: -Number(row.score) });
      if (picked.length >= limit) break;
    }
    if (picked.length === 0) return [];

    const ids = JSON.stringify(picked.map((hit) => hit.id));
    const snippets = new Map<number, string>();
    for (const row of this.#statement(
      `SELECT f.rowid AS id, snippet(fts_chunks, 2, char(2), char(3), '…', ${SNIPPET_TOKENS}) AS snippet
       FROM fts_chunks f WHERE fts_chunks MATCH ? AND f.rowid IN (SELECT value FROM json_each(?))`,
    ).all(match, ids)) {
      snippets.set(Number(row.id), String(row.snippet ?? ''));
    }
    const details = new Map<number, Record<string, SqlValue>>();
    for (const row of this.#statement(
      `SELECT c.id AS id, d.path AS path, d.title AS title, c.heading_path AS heading_path,
              c.line_start AS line_start, c.line_end AS line_end
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id IN (SELECT value FROM json_each(?))`,
    ).all(ids)) {
      details.set(Number(row.id), row);
    }

    return picked.flatMap(({ id, score }) => {
      const row = details.get(id);
      if (!row) return [];
      const { snippet, ranges } = parseSnippet(snippets.get(id) ?? '');
      return [
        {
          path: String(row.path),
          title: String(row.title),
          headingPath: JSON.parse(String(row.heading_path)) as string[],
          lineStart: Number(row.line_start),
          lineEnd: Number(row.line_end),
          snippet,
          ranges,
          score,
          chunk: id,
        },
      ];
    });
  }

  /**
   * Passages still waiting for a vector, most recently changed documents
   * first. Embed each `input` with the profile's passage model and hand the
   * vectors back through `storeEmbeddings`. Empty without an embedding
   * profile, or when every passage has one.
   */
  /**
   * The full text of these passages, by chunk id (a hit's `chunk`), for an
   * app that quotes passages to a model. Ids that are gone are absent.
   */
  passageTexts(chunks: readonly number[]): Map<number, string> {
    const ids = [...new Set(chunks)].filter((id) => Number.isSafeInteger(id)).slice(0, 1_000);
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    for (const row of this.#statement(
      'SELECT id, text FROM chunk_content WHERE id IN (SELECT value FROM json_each(?))',
    ).all(JSON.stringify(ids))) {
      out.set(Number(row.id), String(row.text));
    }
    return out;
  }

  pendingEmbeddings(limit = 64): LivePendingEmbedding[] {
    const embedding = this.#embedding;
    if (!embedding) return [];
    const rows = this.#statement(
      `SELECT c.embed_hash AS hash, MIN(c.id) AS id, MAX(d.updated_at) AS updated
       FROM chunks c JOIN documents d ON d.id = c.document_id
       LEFT JOIN embeddings e ON e.hash = c.embed_hash
       WHERE c.embed_hash IS NOT NULL AND e.hash IS NULL
       GROUP BY c.embed_hash ORDER BY updated DESC, id LIMIT ?`,
    ).all(clamp(limit, 64, 4_096));
    if (rows.length === 0) return [];
    const content = new Map<number, Record<string, SqlValue>>();
    for (const row of this.#statement(
      `SELECT v.id AS id, v.title AS title, c.heading_path AS heading_path, v.text AS text
       FROM chunk_content v JOIN chunks c ON c.id = v.id
       WHERE v.id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(rows.map((row) => Number(row.id))))) {
      content.set(Number(row.id), row);
    }
    return rows.flatMap((row) => {
      const chunk = content.get(Number(row.id));
      if (!chunk) return [];
      return [
        {
          hash: String(row.hash),
          input: embedInputFor(
            embedding,
            String(chunk.title),
            JSON.parse(String(chunk.heading_path)) as string[],
            String(chunk.text),
          ),
        },
      ];
    });
  }

  /** Store passage vectors, raw from the model, against the hashes `pendingEmbeddings` gave. */
  storeEmbeddings(
    entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
  ): void {
    const embedding = this.#embedding;
    if (!embedding) throw new Error('This live index has no embedding profile');
    const quantized = entries.map(({ hash, vector }) => {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new TypeError('embedding hash must be a SHA-256 hex string');
      }
      return { hash, ...quantizeEmbedding(embedding.profile, vector) };
    });
    this.transaction(() => {
      const insert = this.#statement(
        'INSERT OR REPLACE INTO embeddings(hash, bits, int8) VALUES (?, ?, ?)',
      );
      for (const { hash, bits, int8 } of quantized) insert.run(hash, bits, int8);
      this.#bitIndex = null;
    });
  }

  embeddingStats(): LiveEmbeddingStats {
    const row = this.#statement(
      `SELECT (SELECT COUNT(DISTINCT embed_hash) FROM chunks WHERE embed_hash IS NOT NULL) AS total,
              (SELECT COUNT(DISTINCT c.embed_hash) FROM chunks c
               JOIN embeddings e ON e.hash = c.embed_hash) AS embedded`,
    ).get();
    return { total: Number(row?.total ?? 0), embedded: Number(row?.embedded ?? 0) };
  }

  /** Drop vectors whose text no passage holds any more; returns how many. */
  pruneEmbeddings(): number {
    return this.transaction(() => {
      const result = this.#statement(
        'DELETE FROM embeddings WHERE hash NOT IN (SELECT embed_hash FROM chunks WHERE embed_hash IS NOT NULL)',
      ).run();
      this.#bitIndex = null;
      return Number(result.changes);
    });
  }

  /**
   * Passages nearest a query embedding (raw from the profile's query model,
   * query instruction applied): the catalogs' two-stage scan, sign bits then
   * int8 rescoring, kept only above the profile's measured cosine floor.
   */
  semanticSearch(vector: ArrayLike<number>, options: LiveSemanticOptions = {}): LiveSearchHit[] {
    const embedding = this.#embedding;
    if (!embedding) return [];
    const limit = clamp(options.limit, 20, SEARCH_LIMIT_MAX);
    const perDocument = clamp(options.perDocument, 3, SEARCH_LIMIT_MAX);
    const floor = options.floor === undefined ? measuredFloor(embedding.profile) : options.floor;
    const index = this.#bits();
    if (index.rows === 0) return [];
    const { unit, scan } = prepareQuery(embedding.profile, vector);
    const candidates = asymmetricTopK(
      index,
      scan,
      Math.max(VECTOR_CANDIDATES_MIN, limit * perDocument * VECTOR_CANDIDATES_PER_HIT),
    );
    const hashes = candidates.map((candidate) => index.hashes[candidate.chunkId - 1] as string);
    const scored = new Map<string, number>();
    for (const row of this.#statement(
      'SELECT hash, int8 FROM embeddings WHERE hash IN (SELECT value FROM json_each(?))',
    ).all(JSON.stringify(hashes))) {
      const score = similarity(unit, row.int8 as Uint8Array);
      if (floor === null || score >= floor) scored.set(String(row.hash), score);
    }
    if (scored.size === 0) return [];

    const chunks = this.#statement(
      `SELECT c.id AS id, c.embed_hash AS hash, d.path AS path, d.title AS title,
              c.heading_path AS heading_path, c.line_start AS line_start, c.line_end AS line_end,
              v.text AS text
       FROM chunks c JOIN documents d ON d.id = c.document_id JOIN chunk_content v ON v.id = c.id
       WHERE c.embed_hash IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify([...scored.keys()]));
    chunks.sort(
      (left, right) =>
        (scored.get(String(right.hash)) ?? 0) - (scored.get(String(left.hash)) ?? 0) ||
        Number(left.id) - Number(right.id),
    );
    const hits: LiveSearchHit[] = [];
    const perPath = new Map<string, number>();
    for (const row of chunks) {
      const path = String(row.path);
      if (options.exclude?.has(path)) continue;
      const taken = perPath.get(path) ?? 0;
      if (taken >= perDocument) continue;
      perPath.set(path, taken + 1);
      const score = scored.get(String(row.hash)) ?? 0;
      hits.push({
        path,
        title: String(row.title),
        headingPath: JSON.parse(String(row.heading_path)) as string[],
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end),
        snippet: excerpt(String(row.text)),
        ranges: [],
        score,
        chunk: Number(row.id),
        similarity: score,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * Lexical and semantic results fused by reciprocal rank: the passages that
   * match the words, and those that mean the same thing, in one list. Without
   * a query vector (no model yet) it is the lexical search.
   */
  hybridSearch(
    query: string,
    vector: ArrayLike<number> | null,
    options: LiveSearchOptions & Pick<LiveSemanticOptions, 'floor'> = {},
  ): LiveSearchHit[] {
    const limit = clamp(options.limit, 20, SEARCH_LIMIT_MAX);
    const perDocument = clamp(options.perDocument, 3, SEARCH_LIMIT_MAX);
    const wide = {
      ...options,
      limit: Math.min(SEARCH_LIMIT_MAX, limit * 3),
      perDocument: perDocument * 2,
    };
    const lexical = this.search(query, wide);
    const semantic = vector ? this.semanticSearch(vector, wide) : [];
    if (semantic.length === 0) return lexical.slice(0, limit);

    const fused = new Map<
      number,
      { hit: LiveSearchHit; score: number; lexical?: number; vector?: number }
    >();
    lexical.forEach((hit, index) => {
      fused.set(hit.chunk, {
        hit,
        score: LIVE_HYBRID_WEIGHTS.lexical / (LIVE_RRF_K + index + 1),
        lexical: index + 1,
      });
    });
    semantic.forEach((hit, index) => {
      const share = LIVE_HYBRID_WEIGHTS.vector / (LIVE_RRF_K + index + 1);
      const existing = fused.get(hit.chunk);
      // Keep the lexical hit's snippet, which highlights the words.
      if (existing) {
        existing.score += share;
        existing.vector = index + 1;
        existing.hit = { ...existing.hit, similarity: hit.similarity };
      } else {
        fused.set(hit.chunk, { hit, score: share, vector: index + 1 });
      }
    });
    const ordered = [...fused.values()].sort(
      (left, right) => right.score - left.score || left.hit.chunk - right.hit.chunk,
    );
    const hits: LiveSearchHit[] = [];
    const perPath = new Map<string, number>();
    for (const entry of ordered) {
      const taken = perPath.get(entry.hit.path) ?? 0;
      if (taken >= perDocument) continue;
      perPath.set(entry.hit.path, taken + 1);
      hits.push({
        ...entry.hit,
        score: entry.score,
        arms: {
          ...(entry.lexical ? { lexical: entry.lexical } : {}),
          ...(entry.vector ? { vector: entry.vector } : {}),
        },
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  #statement(sql: string): SqlStatement {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Drop a document's chunks from FTS and the chunk table; its row must be unchanged. */
  #unindex(documentId: number): void {
    this.#statement(
      `INSERT INTO fts_chunks(fts_chunks, rowid, title, heading_text, text)
       SELECT 'delete', id, title, heading_text, text FROM chunk_content WHERE document_id = ?`,
    ).run(documentId);
    this.#statement('DELETE FROM chunks WHERE document_id = ?').run(documentId);
  }

  #index(documentId: number, title: string, placed: readonly PlacedChunk[]): number {
    // A document with no text still gets one chunk, so its title is searchable.
    const chunks: readonly PlacedChunk[] =
      placed.length > 0
        ? placed
        : [
            {
              kind: 'doc',
              headingPath: [],
              lineStart: 1,
              lineEnd: 1,
              text: '',
              start: 0,
              length: 0,
            },
          ];
    const insert = this.#statement(
      `INSERT INTO chunks (document_id, ordinal, kind, heading_path, heading_text, line_start,
         line_end, text_start, text_length, text_inline, embed_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const embedding = this.#embedding;
    chunks.forEach((chunk, ordinal) => {
      const inline = chunk.start === null || chunk.length === null;
      // A title-only chunk has nothing to embed.
      const embedHash =
        embedding && chunk.text.length > 0
          ? sha256Hex(embedInputFor(embedding, title, chunk.headingPath, chunk.text))
          : null;
      insert.run(
        documentId,
        ordinal,
        chunk.kind,
        JSON.stringify(chunk.headingPath),
        chunk.headingPath.join(' / '),
        chunk.lineStart,
        chunk.lineEnd,
        inline ? null : chunk.start,
        inline ? null : chunk.length,
        inline ? chunk.text : null,
        embedHash,
      );
    });
    this.#statement(
      `INSERT INTO fts_chunks(rowid, title, heading_text, text)
       SELECT id, title, heading_text, text FROM chunk_content WHERE document_id = ?`,
    ).run(documentId);
    return chunks.length;
  }

  /** The sign-bit block for the first-stage scan, rebuilt after vectors change. */
  #bits(): { bits: Uint8Array; bytesPerRow: number; rows: number; hashes: string[] } {
    if (this.#bitIndex) return this.#bitIndex;
    const rows = this.#statement('SELECT hash, bits FROM embeddings ORDER BY id').all();
    const bytesPerRow = Math.ceil((this.#embedding?.profile.dimensions ?? 0) / 8);
    const bits = new Uint8Array(rows.length * bytesPerRow);
    const hashes: string[] = [];
    rows.forEach((row, index) => {
      bits.set(row.bits as Uint8Array, index * bytesPerRow);
      hashes.push(String(row.hash));
    });
    this.#bitIndex = { bits, bytesPerRow, rows: rows.length, hashes };
    return this.#bitIndex;
  }

  #rows(): number {
    if (this.#chunkCount === null) {
      this.#chunkCount = Number(this.#statement('SELECT COUNT(*) AS n FROM chunks').get()?.n ?? 0);
    }
    return this.#chunkCount;
  }

  #termRowCount(phrase: string): number {
    let rows = this.#termRows.get(phrase);
    if (rows === undefined) {
      if (this.#termRows.size >= TERM_CACHE_MAX) this.#termRows.clear();
      rows = Number(
        this.#statement('SELECT doc FROM fts_chunks_vocab WHERE term = ?').get(indexedTerm(phrase))
          ?.doc ?? 0,
      );
      this.#termRows.set(phrase, rows);
    }
    return rows;
  }

  #changed(): void {
    this.#chunkCount = null;
    this.#termRows.clear();
  }
}

/** What a document's `chunked_with` records; any change re-chunks it. */
function identityOf(options: LiveIndexOptions): string {
  const profile = options.embedding?.profile.id;
  return profile ? `${options.chunking.id}|embed:${profile}` : options.chunking.id;
}

function toDocument(row: Record<string, SqlValue>): LiveDocument {
  const payload = row.payload;
  return {
    path: String(row.path),
    version: String(row.version),
    title: String(row.title),
    payload: payload instanceof Uint8Array ? payload : null,
    updatedAt: Number(row.updated_at),
  };
}
