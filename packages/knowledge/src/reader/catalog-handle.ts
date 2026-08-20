/**
 * One mounted catalog: the router database plus lazily opened shards, and
 * the two-stage query flow (gezk-format-v1.md §3, §9):
 *
 *   embed query (caller) → centroid routing → per shard: bit-hamming KNN
 *   top-K → int8 rerank → fuse.
 *
 * The handle is synchronous (node:sqlite) and single-threaded by design —
 * the daemon confines every handle to its knowledge worker thread; the CLI
 * and tests call it directly.
 */

import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync } from 'node:zlib';
import {
  RERANK_FINAL_K,
  ROUTER_DB_PATH,
  ROUTE_SHARDS_EXPLICIT,
  rerankK,
} from '../format/constants.js';
import { quantizeBinary, rerankScore } from '../format/quantize.js';
import { type CatalogDb, CatalogOpenError, openCatalogDatabase } from './open.js';

export interface CatalogTopic {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  sortKey: string;
  documentCount: number;
}

export interface CatalogDocumentMeta {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  language: string;
  topicId: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  attribution: Record<string, string> | null;
}

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

export class CatalogHandle {
  private readonly connections = new Map<string, CatalogDb>();
  readonly meta: Record<string, string>;
  readonly shards: ShardInfo[];

  private constructor(
    readonly rootDir: string,
    private readonly router: CatalogDb,
  ) {
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
  }

  private shardDb(shard: ShardInfo): DatabaseSync {
    let conn = this.connections.get(shard.path);
    if (!conn) {
      // Shard paths come from the catalog's own router.db, but confine them
      // to the catalog root anyway — defense in depth on a signed artifact.
      const abs = resolve(this.rootDir, shard.path);
      const rootWithSep = normalize(this.rootDir) + sep;
      if (!abs.startsWith(rootWithSep) && normalize(abs) !== normalize(this.rootDir)) {
        throw new CatalogOpenError(`shard path escapes catalog root: ${shard.path}`, 'corrupt');
      }
      conn = openCatalogDatabase(abs);
      this.connections.set(shard.path, conn);
    }
    return conn.db;
  }

  // ── browsing (the shipped table of contents) ──────────────────────────────

  topics(): CatalogTopic[] {
    return (
      this.router.db
        .prepare(
          'SELECT id, parent_id, name, description, sort_key, document_count FROM topics ORDER BY sort_key',
        )
        .all() as Array<{
        id: string;
        parent_id: string | null;
        name: string;
        description: string | null;
        sort_key: string;
        document_count: number | bigint;
      }>
    ).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      description: r.description,
      sortKey: r.sort_key,
      documentCount: Number(r.document_count),
    }));
  }

  documentsPage(opts: { topicId?: string; offset?: number; limit?: number } = {}): {
    documents: CatalogDocumentMeta[];
    total: number;
  } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const where = opts.topicId ? 'WHERE topic_id = ?' : '';
    const params: unknown[] = opts.topicId ? [opts.topicId] : [];
    const total = Number(
      (
        this.router.db
          .prepare(`SELECT COUNT(*) AS n FROM documents ${where}`)
          .get(...(params as [])) as { n: number | bigint }
      ).n,
    );
    const documents = (
      this.router.db
        .prepare(
          `SELECT id, title, slug, summary, language, topic_id, source_url, source_revision,
                  source_updated_at, attribution_json
           FROM documents ${where} ORDER BY slug, id LIMIT ? OFFSET ?`,
        )
        .all(...(params as []), limit, offset) as Array<Record<string, unknown>>
    ).map(rowToDocumentMeta);
    return { documents, total };
  }

  getDocument(id: string): (CatalogDocumentMeta & { markdown: string }) | null {
    const row = this.router.db
      .prepare(
        `SELECT id, title, slug, summary, language, topic_id, source_url, source_revision,
                source_updated_at, attribution_json, body_codec, body_blob
         FROM documents WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const blob = row.body_blob as Uint8Array;
    const markdown =
      row.body_codec === 'br'
        ? brotliDecompressSync(blob).toString('utf8')
        : Buffer.from(blob).toString('utf8');
    return { ...rowToDocumentMeta(row), markdown };
  }

  // ── search ────────────────────────────────────────────────────────────────

  /** Catalog-wide title/summary/alias FTS — always runs regardless of routing. */
  searchDocumentsFts(query: string, limit = 10): Array<{ documentId: string; rank: number }> {
    const match = ftsQuery(query);
    if (!match) return [];
    try {
      return (
        this.router.db
          .prepare(
            'SELECT document_id FROM fts_documents WHERE fts_documents MATCH ? ORDER BY rank LIMIT ?',
          )
          .all(match, limit) as Array<{ document_id: string }>
      ).map((r, i) => ({ documentId: r.document_id, rank: i }));
    } catch {
      return [];
    }
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
    const queryBits = Buffer.from(quantizeBinary(queryVector));
    const hits: CatalogChunkHit[] = [];
    for (const shardId of shardIds) {
      const shard = this.shards.find((s) => s.id === shardId);
      if (!shard) continue;
      const db = this.shardDb(shard);
      const k = rerankK(finalK, shard.chunkCount);
      const candidates = db
        .prepare(
          'SELECT chunk_id FROM vec_chunks WHERE embedding MATCH vec_bit(?) AND k = ? ORDER BY distance',
        )
        .all(queryBits, BigInt(k)) as Array<{ chunk_id: number | bigint }>;
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
   * Embedder-free integrity smoke (§6.3): chunk 1's own bit vector must be
   * its own nearest neighbor — proves the extension parses this file's vec
   * blobs. Returns false instead of throwing (callers report a reason).
   */
  selfKnnSmoke(shardId: number): boolean {
    const shard = this.shards.find((s) => s.id === shardId);
    if (!shard) return false;
    try {
      const db = this.shardDb(shard);
      const first = db.prepare('SELECT embedding FROM vec_chunks WHERE chunk_id = 1').get() as
        | { embedding: Uint8Array }
        | undefined;
      if (!first) return false;
      const nearest = db
        .prepare(
          'SELECT chunk_id FROM vec_chunks WHERE embedding MATCH vec_bit(?) AND k = 1 ORDER BY distance',
        )
        .get(Buffer.from(first.embedding)) as { chunk_id: number | bigint } | undefined;
      return nearest !== undefined && Number(nearest.chunk_id) === 1;
    } catch {
      return false;
    }
  }
}

function rowToDocumentMeta(row: Record<string, unknown>): CatalogDocumentMeta {
  let attribution: Record<string, string> | null = null;
  if (typeof row.attribution_json === 'string') {
    try {
      attribution = JSON.parse(row.attribution_json) as Record<string, string>;
    } catch {
      attribution = null;
    }
  }
  return {
    id: row.id as string,
    title: row.title as string,
    slug: row.slug as string,
    summary: (row.summary as string | null) ?? null,
    language: row.language as string,
    topicId: row.topic_id as string,
    sourceUrl: (row.source_url as string | null) ?? null,
    sourceRevision: (row.source_revision as string | null) ?? null,
    sourceUpdatedAt: (row.source_updated_at as string | null) ?? null,
    attribution,
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

/** Injection-safe FTS5 query: quoted OR'd tokens, capped. */
function ftsQuery(query: string): string | null {
  const tokens = [
    ...new Set((query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16)),
  ];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
