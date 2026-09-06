/**
 * One mounted catalog: the router database plus lazily opened shards, and
 * the two-stage query flow (the gezk spec §8 and §9):
 *
 *   embed query (caller) → centroid routing → per shard: bit-hamming KNN
 *   top-K → int8 rerank → fuse.
 *
 * Stage 1 runs in memory: a shard's sign-bit rows are loaded once into a
 * contiguous array (9.6 MB for a full 200k-chunk shard) and scanned with a
 * popcount, so no vector extension is needed to read a catalog.
 *
 * The handle is synchronous (node:sqlite) and single-threaded by design —
 * the daemon confines every handle to its knowledge worker thread; the CLI
 * and tests call it directly.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync } from 'node:zlib';
import {
  type GezkIndexSchemaVersion,
  MAX_KNOWLEDGE_ASSET_BYTES,
  assetContentType,
  isKnowledgeAssetPath,
} from '@bendyline/gezk';
import {
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  RERANK_FINAL_K,
  ROUTER_DB_PATH,
  ROUTE_SHARDS_EXPLICIT,
  rerankK,
} from '../format/constants.js';
import { quantizeBinary, rerankScore } from '../format/quantize.js';
import { type ShardBitIndex, hammingTopK } from './bit-scan.js';
import { documentFtsTopIds, sanitizeFtsQuery } from './fts-query.js';
import { type CatalogDb, CatalogOpenError, openCatalogDatabase } from './open.js';

export interface CatalogTopic {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  sortKey: string;
  /** Documents filed directly at this topic (`topics.document_count`). */
  documentCount: number;
  /** Direct plus every descendant topic's documents (computed at read time). */
  totalDocumentCount: number;
}

export interface CatalogDocumentMeta {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  language: string;
  /** The topic the document is filed at — the leaf of its path on 0.6, the root on 0.5. */
  topicId: string;
  /** Listing position among the documents of its topic; null when unordered. */
  ordinal: number | null;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  attribution: Record<string, string> | null;
  /** Producer-defined metadata (`meta_json`), opaque to the reader. */
  meta: Record<string, unknown> | null;
}

export interface CatalogAssetInfo {
  /** Archive path under `assets/`. */
  path: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CatalogAssetRead extends CatalogAssetInfo {
  bytes: Uint8Array;
}

/**
 * Descendant walks are bounded so a hostile `parent_id` cycle terminates;
 * the validator refuses cycles and depth beyond MAX_KNOWLEDGE_TOPIC_DEPTH.
 */
const TOPIC_WALK_MAX_DEPTH = 32;

export interface CatalogChunkHit {
  chunkUid: string;
  documentId: string;
  title: string;
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  text: string;
  /** Rerank cosine (semantic hits) — absent for FTS-only hits. */
  cosine?: number;
  source: 'vector' | 'fts';
  shardId: number;
}

interface ShardInfo {
  id: number;
  path: string;
  chunkCount: number;
}

/** Resident sign-bit budget across mounted shards before the oldest is dropped. */
const BIT_INDEX_BUDGET_BYTES = 256 * 1024 * 1024;

export class CatalogHandle {
  private readonly connections = new Map<string, CatalogDb>();
  private readonly bitIndexes = new Map<string, ShardBitIndex>();
  private assetsByPath: Map<string, CatalogAssetInfo> | null = null;
  readonly meta: Record<string, string>;
  readonly shards: ShardInfo[];
  /** The router's `PRAGMA user_version` generation; decides which columns exist. */
  readonly schemaVersion: GezkIndexSchemaVersion;

  private constructor(
    readonly rootDir: string,
    private readonly router: CatalogDb,
  ) {
    this.schemaVersion = router.schemaVersion;
    this.meta = {};
    for (const row of router.db.prepare('SELECT key, value FROM meta').all() as Array<{
      key: string;
      value: string;
    }>) {
      this.meta[row.key] = row.value;
    }
    this.shards = (
      router.db.prepare('SELECT id, path, chunk_count FROM shards ORDER BY id').all() as Array<{
        id: number | bigint;
        path: string;
        chunk_count: number | bigint;
      }>
    ).map((r) => ({ id: Number(r.id), path: r.path, chunkCount: Number(r.chunk_count) }));
    this.connections.set(ROUTER_DB_PATH, router);
  }

  /** Open a catalog's extracted version directory (the dir holding manifest.json). */
  static open(rootDir: string): CatalogHandle {
    const router = openCatalogDatabase(join(rootDir, ROUTER_DB_PATH));
    return new CatalogHandle(rootDir, router);
  }

  close(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.bitIndexes.clear();
  }

  /** Integrity check for the router connection, used by deep validation. */
  routerQuickCheck(): string {
    const row = this.router.db.prepare('PRAGMA quick_check').get() as {
      quick_check?: string;
    };
    return row.quick_check ?? 'no result';
  }

  /** Metadata-only body profile; SQLite's length() does not materialize blobs. */
  documentBodyProfile(): {
    maxRawBytes: number;
    maxCompressedBytes: number;
    unknownCodecs: number;
  } {
    const row = this.router.db
      .prepare(
        `SELECT
           COALESCE(MAX(CASE WHEN body_codec = 'none' THEN length(body_blob) ELSE 0 END), 0) AS max_raw,
           COALESCE(MAX(CASE WHEN body_codec = 'br' THEN length(body_blob) ELSE 0 END), 0) AS max_br,
           COALESCE(SUM(CASE WHEN body_codec IN ('none', 'br') THEN 0 ELSE 1 END), 0) AS unknown
         FROM documents`,
      )
      .get() as { max_raw: number | bigint; max_br: number | bigint; unknown: number | bigint };
    return {
      maxRawBytes: Number(row.max_raw),
      maxCompressedBytes: Number(row.max_br),
      unknownCodecs: Number(row.unknown),
    };
  }

  private shardDb(shard: ShardInfo): DatabaseSync {
    let conn = this.connections.get(shard.path);
    if (!conn) {
      // Shard paths come from the catalog's own router.db, but confine them
      // to the catalog root anyway — defense in depth on a signed artifact.
      const abs = this.resolveCatalogPath(shard.path);
      conn = openCatalogDatabase(abs);
      this.connections.set(shard.path, conn);
    }
    return conn.db;
  }

  /**
   * A shard's sign-bit rows as one contiguous array, loaded on first use and
   * kept while the resident budget allows. Chunk ids must be dense from 1 —
   * the row index IS the id — so a gap is a corrupt shard, not a sparse one.
   */
  private shardBits(shard: ShardInfo): ShardBitIndex {
    const cached = this.bitIndexes.get(shard.path);
    if (cached) return cached;
    const db = this.shardDb(shard);
    const span = db
      .prepare(
        'SELECT COUNT(*) AS n, MIN(chunk_id) AS lo, MAX(chunk_id) AS hi FROM chunk_vectors_bit',
      )
      .get() as { n: number | bigint; lo: number | bigint | null; hi: number | bigint | null };
    const rows = Number(span.n);
    if (rows > 0 && (Number(span.lo) !== 1 || Number(span.hi) !== rows)) {
      throw new CatalogOpenError(`chunk ids are not dense in ${shard.path}`, 'corrupt');
    }
    const bytesPerRow = Math.ceil(this.dimensions() / 8);
    const bits = new Uint8Array(rows * bytesPerRow);
    const rowsIter = db
      .prepare('SELECT chunk_id, v FROM chunk_vectors_bit ORDER BY chunk_id')
      .iterate() as Iterable<{ chunk_id: number | bigint; v: Uint8Array }>;
    for (const row of rowsIter) {
      if (row.v.byteLength !== bytesPerRow) {
        throw new CatalogOpenError(
          `bit vector width ${row.v.byteLength} != ${bytesPerRow} in ${shard.path}`,
          'corrupt',
        );
      }
      bits.set(row.v, (Number(row.chunk_id) - 1) * bytesPerRow);
    }
    const index: ShardBitIndex = { bits, bytesPerRow, rows };
    let resident = bits.byteLength;
    for (const other of this.bitIndexes.values()) resident += other.bits.byteLength;
    for (const [key, other] of this.bitIndexes) {
      if (resident <= BIT_INDEX_BUDGET_BYTES) break;
      this.bitIndexes.delete(key);
      resident -= other.bits.byteLength;
    }
    this.bitIndexes.set(shard.path, index);
    return index;
  }

  /** The embedding dimension from the router's profile echo. */
  private dimensions(): number {
    const raw = this.meta.embedding_profile_json;
    if (raw) {
      try {
        const dims = (JSON.parse(raw) as { dimensions?: unknown }).dimensions;
        if (typeof dims === 'number' && dims > 0) return dims;
      } catch {
        /* fall through to the corrupt error */
      }
    }
    throw new CatalogOpenError('router meta lacks a usable embedding profile', 'corrupt');
  }

  /** Resolve a manifest/router path without allowing it to escape the catalog. */
  resolveCatalogPath(path: string): string {
    const root = resolve(this.rootDir);
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new CatalogOpenError(`path escapes catalog root: ${path}`, 'corrupt');
    }
    return target;
  }

  // ── browsing (the shipped table of contents) ──────────────────────────────

  /** The format version the router was written with (`meta.format_version`). */
  get formatVersion(): string {
    return this.meta.format_version ?? '';
  }

  private documentColumns(): string {
    const base =
      'id, title, slug, summary, language, topic_id, source_url, source_revision, source_updated_at, attribution_json';
    return this.schemaVersion >= 3 ? `${base}, ordinal, meta_json` : base;
  }

  private documentOrder(): string {
    return this.schemaVersion >= 3
      ? 'ORDER BY (ordinal IS NULL), ordinal, slug, id'
      : 'ORDER BY slug, id';
  }

  /**
   * Every topic with its direct count and a rollup over its subtree. On a
   * 0.5 catalog every document sits at a root, so both counts agree there.
   */
  topics(): CatalogTopic[] {
    return (
      this.router.db
        .prepare(
          `WITH RECURSIVE sub(root, id, depth) AS (
             SELECT id, id, 0 FROM topics
             UNION ALL
             SELECT sub.root, t.id, sub.depth + 1 FROM topics t JOIN sub ON t.parent_id = sub.id
             WHERE sub.depth < ${TOPIC_WALK_MAX_DEPTH}
           ),
           rollup AS (
             SELECT sub.root AS id, SUM(t.document_count) AS total
             FROM sub JOIN topics t ON t.id = sub.id GROUP BY sub.root
           )
           SELECT t.id, t.parent_id, t.name, t.description, t.sort_key, t.document_count,
                  rollup.total AS total_document_count
           FROM topics t JOIN rollup ON rollup.id = t.id
           ORDER BY t.sort_key, t.id`,
        )
        .all() as Array<{
        id: string;
        parent_id: string | null;
        name: string;
        description: string | null;
        sort_key: string;
        document_count: number | bigint;
        total_document_count: number | bigint;
      }>
    ).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      description: r.description,
      sortKey: r.sort_key,
      documentCount: Number(r.document_count),
      totalDocumentCount: Number(r.total_document_count),
    }));
  }

  /**
   * A page of documents, by default including those filed under the topic's
   * descendants (`descendants: false` lists only the topic's own).
   */
  documentsPage(
    opts: { topicId?: string; offset?: number; limit?: number; descendants?: boolean } = {},
  ): {
    documents: CatalogDocumentMeta[];
    total: number;
  } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const descendants = opts.descendants ?? true;
    let scope = '';
    let where = '';
    const params: unknown[] = [];
    if (opts.topicId && descendants) {
      scope = `WITH RECURSIVE sub(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT t.id, sub.depth + 1 FROM topics t JOIN sub ON t.parent_id = sub.id
                 WHERE sub.depth < ${TOPIC_WALK_MAX_DEPTH}
               )`;
      where = 'WHERE topic_id IN (SELECT id FROM sub)';
      params.push(opts.topicId);
    } else if (opts.topicId) {
      where = 'WHERE topic_id = ?';
      params.push(opts.topicId);
    }
    const total = Number(
      (
        this.router.db
          .prepare(`${scope} SELECT COUNT(*) AS n FROM documents ${where}`)
          .get(...(params as [])) as { n: number | bigint }
      ).n,
    );
    const documents = (
      this.router.db
        .prepare(
          `${scope} SELECT ${this.documentColumns()}
           FROM documents ${where} ${this.documentOrder()} LIMIT ? OFFSET ?`,
        )
        .all(...(params as []), limit, offset) as Array<Record<string, unknown>>
    ).map(rowToDocumentMeta);
    return { documents, total };
  }

  getDocument(id: string): (CatalogDocumentMeta & { markdown: string }) | null {
    const row = this.router.db
      .prepare(
        `SELECT ${this.documentColumns()}, body_codec, body_blob
         FROM documents WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...rowToDocumentMeta(row), markdown: this.decodeBody(id, row) };
  }

  /** Documents whose `topic_id` names no declared topic (a validator check). */
  documentsWithUndeclaredTopic(): number {
    return Number(
      (
        this.router.db
          .prepare(
            'SELECT COUNT(*) AS n FROM documents d LEFT JOIN topics t ON t.id = d.topic_id WHERE t.id IS NULL',
          )
          .get() as { n: number | bigint }
      ).n,
    );
  }

  /**
   * Validator support: every `meta_json` must be a JSON object within the
   * byte limit. Returns the offending ids (capped) rather than throwing.
   */
  checkDocumentMeta(maxBytes: number, cap = 5): { invalid: string[]; oversize: string[] } {
    const invalid: string[] = [];
    const oversize: string[] = [];
    if (this.schemaVersion < 3) return { invalid, oversize };
    const rows = this.router.db
      .prepare('SELECT id, meta_json FROM documents WHERE meta_json IS NOT NULL')
      .iterate() as Iterable<{ id: string; meta_json: string }>;
    for (const row of rows) {
      if (invalid.length >= cap && oversize.length >= cap) break;
      if (Buffer.byteLength(row.meta_json, 'utf8') > maxBytes) {
        if (oversize.length < cap) oversize.push(row.id);
        continue;
      }
      if (parseJsonObject(row.meta_json) === null && invalid.length < cap) invalid.push(row.id);
    }
    return { invalid, oversize };
  }

  /** Validator support: decoded bodies, streamed one at a time. */
  *documentBodies(): IterableIterator<{ id: string; markdown: string }> {
    const rows = this.router.db
      .prepare('SELECT id, body_codec, body_blob FROM documents ORDER BY id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const id = row.id as string;
      yield { id, markdown: this.decodeBody(id, row) };
    }
  }

  private decodeBody(id: string, row: Record<string, unknown>): string {
    const blob = row.body_blob as Uint8Array;
    if (blob.byteLength > MAX_KNOWLEDGE_DOCUMENT_BYTES + 1024) {
      throw new CatalogOpenError(`document body exceeds the stored-size limit: ${id}`, 'corrupt');
    }
    let body: Buffer;
    if (row.body_codec === 'br') {
      try {
        body = brotliDecompressSync(blob, { maxOutputLength: MAX_KNOWLEDGE_DOCUMENT_BYTES });
      } catch (error) {
        throw new CatalogOpenError(
          `document body is invalid or exceeds the decompression limit: ${id} (${error instanceof Error ? error.message : String(error)})`,
          'corrupt',
        );
      }
    } else if (row.body_codec === 'none') {
      body = Buffer.from(blob);
      if (body.byteLength > MAX_KNOWLEDGE_DOCUMENT_BYTES) {
        throw new CatalogOpenError(`document body exceeds the size limit: ${id}`, 'corrupt');
      }
    } else {
      throw new CatalogOpenError(`unknown document body codec for ${id}`, 'corrupt');
    }
    return body.toString('utf8');
  }

  // ── assets ────────────────────────────────────────────────────────────────

  /**
   * The manifest's `files` entries under `assets/`, read lazily: the
   * declaration in the manifest is what authorizes serving a file, since
   * extraction reconciled and hashed every declared entry.
   */
  private assetIndex(): Map<string, CatalogAssetInfo> {
    if (this.assetsByPath) return this.assetsByPath;
    const index = new Map<string, CatalogAssetInfo>();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.rootDir, MANIFEST_PATH), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.assetsByPath = index;
        return index;
      }
      throw new CatalogOpenError(
        `cannot read ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        'corrupt',
      );
    }
    const files = (raw as { files?: unknown } | null)?.files;
    if (Array.isArray(files)) {
      for (const file of files as Array<Record<string, unknown>>) {
        const path = file?.path;
        if (typeof path !== 'string' || !isKnowledgeAssetPath(path)) continue;
        const contentType = assetContentType(path);
        if (!contentType || typeof file.sizeBytes !== 'number' || typeof file.sha256 !== 'string') {
          continue;
        }
        index.set(path, { path, contentType, sizeBytes: file.sizeBytes, sha256: file.sha256 });
      }
    }
    this.assetsByPath = index;
    return index;
  }

  /** Declared assets, sorted by path. */
  assets(): CatalogAssetInfo[] {
    return [...this.assetIndex().values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** One declared asset's bytes, or null when the catalog declares no such asset. */
  readAsset(path: string): CatalogAssetRead | null {
    const info = this.assetIndex().get(path);
    if (!info) return null;
    if (info.sizeBytes > MAX_KNOWLEDGE_ASSET_BYTES) {
      throw new CatalogOpenError(`asset exceeds the size limit: ${path}`, 'corrupt');
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.resolveCatalogPath(path));
    } catch (error) {
      throw new CatalogOpenError(
        `cannot read asset ${path}: ${error instanceof Error ? error.message : String(error)}`,
        'corrupt',
      );
    }
    if (bytes.byteLength !== info.sizeBytes) {
      throw new CatalogOpenError(`asset size differs from the manifest: ${path}`, 'corrupt');
    }
    return { ...info, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }

  // ── search ────────────────────────────────────────────────────────────────

  /** Catalog-wide title/summary/alias FTS — always runs regardless of routing. */
  searchDocumentsFts(query: string, limit = 10): Array<{ documentId: string; rank: number }> {
    const match = ftsQuery(query);
    if (!match) return [];
    try {
      return documentFtsTopIds(this.router.db, match, limit).map((documentId, i) => ({
        documentId,
        rank: i,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Router-level shape stats: topic-tree size and total route centroids.
   * Read-only counts for inspectors and recall/routing diagnostics — a
   * single-topic catalog fills shards in documentId order, which is the
   * first thing to check when centroid routing underperforms.
   */
  routerStats(): { topics: number; routeCentroids: number } {
    const count = (table: string): number =>
      Number(
        (
          this.router.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
            c: number | bigint;
          }
        ).c,
      );
    return { topics: count('topics'), routeCentroids: count('route_centroids') };
  }

  /**
   * Score every shard against the (unit float32) query: shard score = max
   * cosine over its centroids (§3.4). This is the cross-catalog routing
   * primitive — the daemon merges scores from every active catalog and
   * takes the top-S GLOBALLY, so multiple catalogs share one scan budget.
   */
  scoreShards(queryVector: Float32Array): Array<{ shardId: number; score: number }> {
    const rows = this.router.db
      .prepare('SELECT shard_id, embedding FROM route_centroids')
      .all() as Array<{ shard_id: number | bigint; embedding: Uint8Array }>;
    const best = new Map<number, number>();
    for (const row of rows) {
      const centroid = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        Math.floor(row.embedding.byteLength / 4),
      );
      let dot = 0;
      const n = Math.min(centroid.length, queryVector.length);
      for (let i = 0; i < n; i++) dot += centroid[i]! * queryVector[i]!;
      const id = Number(row.shard_id);
      if (dot > (best.get(id) ?? Number.NEGATIVE_INFINITY)) best.set(id, dot);
    }
    // A shard with no centroid row (empty shard) simply never routes.
    return [...best.entries()].map(([shardId, score]) => ({ shardId, score }));
  }

  /** Top-S shard ids within THIS catalog (single-catalog callers, tests). */
  routeShards(queryVector: Float32Array, shardBudget: number): number[] {
    if (this.shards.length <= shardBudget) return this.shards.map((s) => s.id);
    return this.scoreShards(queryVector)
      .sort((a, b) => b.score - a.score)
      .slice(0, shardBudget)
      .map((s) => s.shardId);
  }

  /**
   * Two-stage semantic search over the routed shards: bit-hamming KNN
   * (stage 1) → int8 rerank (stage 2). Sequential by design (§9).
   */
  searchSemantic(
    queryVector: Float32Array,
    opts: { shardBudget?: number; finalK?: number } = {},
  ): CatalogChunkHit[] {
    const shardIds = this.routeShards(queryVector, opts.shardBudget ?? ROUTE_SHARDS_EXPLICIT);
    return this.searchShards(queryVector, shardIds, opts.finalK ?? RERANK_FINAL_K);
  }

  /**
   * The scan stage against an EXPLICIT shard list — what the daemon calls
   * after global cross-catalog routing has already spent the S budget.
   */
  searchShards(queryVector: Float32Array, shardIds: number[], finalK: number): CatalogChunkHit[] {
    const queryBits = quantizeBinary(queryVector);
    const hits: CatalogChunkHit[] = [];
    for (const shardId of shardIds) {
      const shard = this.shards.find((s) => s.id === shardId);
      if (!shard) continue;
      const db = this.shardDb(shard);
      const k = rerankK(finalK, shard.chunkCount);
      const candidates = hammingTopK(this.shardBits(shard), queryBits, k).map((hit) => ({
        chunk_id: hit.chunkId,
      }));
      if (candidates.length === 0) continue;
      const getInt8 = db.prepare('SELECT v FROM chunk_vectors_int8 WHERE chunk_id = ?');
      const reranked = candidates
        .map((c) => {
          const row = getInt8.get(BigInt(c.chunk_id)) as { v: Uint8Array } | undefined;
          if (!row) return null;
          const int8 = new Int8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength);
          return { chunkId: Number(c.chunk_id), cosine: rerankScore(queryVector, int8) };
        })
        .filter((r): r is { chunkId: number; cosine: number } => r !== null)
        .sort((a, b) => b.cosine - a.cosine)
        .slice(0, finalK);
      const getChunk = db.prepare(
        `SELECT chunk_uid, document_id, title, heading_path, line_start, line_end, text
         FROM chunks WHERE id = ?`,
      );
      for (const r of reranked) {
        const row = getChunk.get(BigInt(r.chunkId)) as Record<string, unknown> | undefined;
        if (!row) continue;
        hits.push({
          chunkUid: row.chunk_uid as string,
          documentId: row.document_id as string,
          title: row.title as string,
          headingPath: parseHeadingPath(row.heading_path as string),
          lineStart: Number(row.line_start),
          lineEnd: Number(row.line_end),
          text: row.text as string,
          cosine: r.cosine,
          source: 'vector',
          shardId,
        });
      }
    }
    hits.sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0));
    return hits;
  }

  /** Chunk-body FTS over the routed shards (explicit search only). */
  searchChunksFts(query: string, shardIds: number[], limitPerShard = 12): CatalogChunkHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const hits: CatalogChunkHit[] = [];
    for (const shardId of shardIds) {
      const shard = this.shards.find((s) => s.id === shardId);
      if (!shard) continue;
      const db = this.shardDb(shard);
      try {
        const rows = db
          .prepare(
            `SELECT c.chunk_uid, c.document_id, c.title, c.heading_path, c.line_start, c.line_end, c.text
             FROM fts_chunks f JOIN chunks c ON c.id = f.rowid
             WHERE fts_chunks MATCH ? ORDER BY f.rank LIMIT ?`,
          )
          .all(match, limitPerShard) as Array<Record<string, unknown>>;
        for (const row of rows) {
          hits.push({
            chunkUid: row.chunk_uid as string,
            documentId: row.document_id as string,
            title: row.title as string,
            headingPath: parseHeadingPath(row.heading_path as string),
            lineStart: Number(row.line_start),
            lineEnd: Number(row.line_end),
            text: row.text as string,
            source: 'fts',
            shardId,
          });
        }
      } catch {
        /* malformed FTS query after escaping — treat as no hits */
      }
    }
    return hits;
  }

  /**
   * Embedder-free integrity smoke: chunk 1's own bit vector must be its own
   * nearest neighbor — proves the shard's vectors load and scan. Returns
   * false instead of throwing (callers report a reason).
   */
  selfKnnSmoke(shardId: number): boolean {
    const shard = this.shards.find((s) => s.id === shardId);
    if (!shard) return false;
    try {
      const index = this.shardBits(shard);
      if (index.rows === 0) return false;
      const first = index.bits.subarray(0, index.bytesPerRow);
      const nearest = hammingTopK(index, first, 1)[0];
      return nearest !== undefined && nearest.chunkId === 1 && nearest.distance === 0;
    } catch {
      return false;
    }
  }
}

function parseJsonObject<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

function rowToDocumentMeta(row: Record<string, unknown>): CatalogDocumentMeta {
  const ordinal = row.ordinal;
  return {
    id: row.id as string,
    title: row.title as string,
    slug: row.slug as string,
    summary: (row.summary as string | null) ?? null,
    language: row.language as string,
    topicId: row.topic_id as string,
    ordinal: typeof ordinal === 'number' || typeof ordinal === 'bigint' ? Number(ordinal) : null,
    sourceUrl: (row.source_url as string | null) ?? null,
    sourceRevision: (row.source_revision as string | null) ?? null,
    sourceUpdatedAt: (row.source_updated_at as string | null) ?? null,
    attribution: parseJsonObject<Record<string, string>>(row.attribution_json),
    meta: parseJsonObject<Record<string, unknown>>(row.meta_json),
  };
}

function parseHeadingPath(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// Shared with the compiler's seal-time smoke verification — semantics must
// never drift between "what the build proved" and "what the install checks".
const ftsQuery = sanitizeFtsQuery;
