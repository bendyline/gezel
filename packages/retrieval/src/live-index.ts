import { selectiveFtsQuery } from '@bendyline/gezel-knowledge/browser';
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

export interface LiveIndexOptions {
  readonly chunking: LiveChunking;
  /**
   * The app's format for `version` and `payload`. When it changes, stored
   * rows no longer mean what the app expects, so the index starts empty.
   */
  readonly appVersion: string;
  /** Milliseconds since the epoch, for `updatedAt`. */
  readonly now?: () => number;
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
}

export interface LiveIndexStats {
  readonly documents: number;
  readonly chunks: number;
  /** Documents chunked by an earlier chunking, awaiting `rechunkStale()`. */
  readonly stale: number;
}

const SEARCH_LIMIT_MAX = 200;
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
  readonly #now: () => number;
  readonly #statements = new Map<string, SqlStatement>();
  readonly #termRows = new Map<string, number>();
  #chunkCount: number | null = null;
  #savepoints = 0;

  private constructor(db: SqlDatabase, options: LiveIndexOptions, reset: LiveIndexReset) {
    this.#db = db;
    this.#chunking = options.chunking;
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
      const write = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
      write.run('schema', String(LIVE_INDEX_SCHEMA));
      write.run('app', options.appVersion);
      write.run('chunking', options.chunking.id);
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
        ).run(version, title, body, payload, this.#chunking.id, this.#now(), id);
      } else {
        const row = this.#statement(
          `INSERT INTO documents (path, version, title, body, payload, chunked_with, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        ).get(path, version, title, body, payload, this.#chunking.id, this.#now());
        id = Number(row?.id);
      }
      const chunks = this.#index(id, placed);
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

  /** Remove every document. */
  clear(): void {
    this.transaction(() => {
      this.#db.exec(
        "INSERT INTO fts_chunks(fts_chunks) VALUES('delete-all'); DELETE FROM chunks; DELETE FROM documents;",
      );
      this.#changed();
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
    ).get(this.#chunking.id);
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
      'SELECT id, body FROM documents WHERE chunked_with != ? LIMIT ?',
    ).all(this.#chunking.id, clamp(limit, 100, 100_000));
    if (rows.length === 0) return 0;
    this.transaction(() => {
      for (const row of rows) {
        const id = Number(row.id);
        this.#unindex(id);
        this.#index(id, placeChunks(String(row.body), this.#chunking));
        this.#statement('UPDATE documents SET chunked_with = ? WHERE id = ?').run(
          this.#chunking.id,
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
        },
      ];
    });
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

  #index(documentId: number, placed: readonly PlacedChunk[]): number {
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
         line_end, text_start, text_length, text_inline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    chunks.forEach((chunk, ordinal) => {
      const inline = chunk.start === null || chunk.length === null;
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
      );
    });
    this.#statement(
      `INSERT INTO fts_chunks(rowid, title, heading_text, text)
       SELECT id, title, heading_text, text FROM chunk_content WHERE document_id = ?`,
    ).run(documentId);
    return chunks.length;
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
