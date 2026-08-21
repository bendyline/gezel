/**
 * `.gezk` compiler (gezk-format-v1.md). One owner of normalization, chunk
 * ids, embedding-profile conformance, SQLite schema, shard assignment,
 * centroid routing, and deterministic archive layout — the CLI's Markdown
 * adapter and Qualla's Wikipedia adapter both feed this API.
 *
 * Determinism contract (§11): identical inputs + identical toolchain
 * fingerprint ⇒ byte-identical archive. Everything time- or random-shaped is
 * an input (`createdAt`) or seeded (k-means); the embedder is injected so
 * callers control its determinism (tests inject a hash-based embedder; the
 * real pipeline's content-hash vector cache is the reproducibility
 * authority across machines).
 *
 * Memory note: documents are collected and sorted in-process. That is fine
 * for author-built catalogs (the CLI path); the Wikipedia-scale pipeline
 * spools per-catalog NDJSON partitions and feeds each partition separately
 * (its documents arrive pre-sorted), so the in-memory set stays bounded.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import type {
  CatalogDocument,
  KnowledgeCatalogManifest,
  KnowledgeChunkingProfile,
  KnowledgeEmbeddingProfile,
} from '@bendyline/gezel';
import { KnowledgeCatalogManifestSchema } from '@bendyline/gezel';
import { writeGezkArchive } from '../archive/write.js';
import { type MarkdownChunk, chunkMarkdownProfile } from '../chunking/markdown-chunker.js';
import {
  BODY_CODEC_MIN_BYTES,
  CENTROID_CHUNKS_PER,
  CENTROID_KMEANS_MAX_ITER,
  CENTROID_MAX_PER_SHARD,
  CENTROID_SAMPLE_MAX,
  GEZK_APPLICATION_ID,
  GEZK_FORMAT_VERSION,
  GEZK_INDEX_SCHEMA_VERSION,
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  ROUTER_DB_PATH,
  SHARD_TARGET_CHUNKS,
} from '../format/constants.js';
import { ROUTER_DDL, SHARD_DDL, vecChunksDdl } from '../format/ddl.js';
import { hashFileStreaming } from '../format/file-hash.js';
import { chunkContentHash, chunkUid, documentSlug } from '../format/ids.js';
import { DatabaseSync } from '../format/node-sqlite.js';
import { l2Normalize, quantizeBinary, quantizeInt8 } from '../format/quantize.js';
import { loadVecExtension } from './vec-load.js';

export interface CompileTopic {
  id: string;
  name: string;
  parentId?: string;
  description?: string;
  sortKey?: string;
}

export interface CompileKnowledgeCatalogOptions {
  catalog: {
    id: string;
    version: string;
    name: string;
    description?: string;
    language: string;
    publisher: { id: string; name: string; url?: string };
    /** Supplied, never wall-clock — determinism. */
    createdAt: string;
    license: { name: string; noticePath?: string; attributionRequired: boolean };
    sourceSnapshot?: { name: string; date: string; taxonomyVersion?: string };
  };
  /** The shipped table of contents — the compiler REJECTS an empty list. */
  topics: CompileTopic[];
  documents: AsyncIterable<CatalogDocument>;
  outputPath: string;
  embeddingProfile: KnowledgeEmbeddingProfile;
  chunkingProfile: KnowledgeChunkingProfile;
  /**
   * Profile-conformant passage embedder: takes ALREADY-PREFIXED texts,
   * returns unit vectors at the profile's dimension. Injected so the CLI
   * wires the daemon's pipeline, Qualla wires its worker pool, and tests
   * wire a deterministic fake.
   */
  embed: (texts: string[]) => Promise<number[][]>;
  /** The profile tokenizer's counter (chunking + header truncation). */
  countTokens: (text: string) => number;
  /** Scratch directory for the staged databases (removed on success). */
  workDir: string;
  smokeQueries?: Array<{ query: string; expectedDocumentIds: string[] }>;
  toolchain?: KnowledgeCatalogManifest['toolchain'];
  /** Extra archive files (README.md, LICENSES/…): path → utf8 content. */
  extraFiles?: Record<string, string>;
  /**
   * Last touch before the manifest is archived — the signing seam
   * (signatures/signing.ts `signManifest`). Must only add/replace the
   * `signature` field; the result is re-parsed, so structural edits fail
   * loudly rather than shipping.
   */
  finalizeManifest?: (manifest: KnowledgeCatalogManifest) => KnowledgeCatalogManifest;
  onProgress?: (progress: { phase: string; done: number; total: number }) => void;
  embedBatchSize?: number;
}

export interface CompileReport {
  manifest: KnowledgeCatalogManifest;
  documents: number;
  chunks: number;
  shards: number;
  archiveBytes: number;
}

interface PreparedDocument {
  doc: CatalogDocument;
  topicPathKey: string;
  chunks: MarkdownChunk[];
}

export async function compileKnowledgeCatalog(
  opts: CompileKnowledgeCatalogOptions,
): Promise<CompileReport> {
  if (opts.topics.length === 0) {
    throw new Error(
      'a catalog must ship a table of contents: provide at least one topic (a flat corpus gets a single root topic)',
    );
  }
  const topicIds = new Set(opts.topics.map((t) => t.id));
  const profile = opts.embeddingProfile;
  const chunkerOpts = {
    unit: 'tokens' as const,
    target: opts.chunkingProfile.targetTokens,
    overlap: opts.chunkingProfile.overlapTokens,
    countTokens: opts.countTokens,
  };

  // ── collect + sort + chunk ────────────────────────────────────────────────
  const prepared: PreparedDocument[] = [];
  const seenIds = new Set<string>();
  for await (const doc of opts.documents) {
    if (seenIds.has(doc.id)) throw new Error(`duplicate document id: ${doc.id}`);
    seenIds.add(doc.id);
    const rootTopic = doc.topicPath[0];
    if (!rootTopic || !topicIds.has(rootTopic)) {
      throw new Error(`document ${doc.id} names unknown topic '${rootTopic ?? ''}'`);
    }
    prepared.push({
      doc,
      topicPathKey: doc.topicPath.join('/'),
      chunks: chunkMarkdownProfile(normalizeMarkdown(doc.markdown), chunkerOpts),
    });
  }
  prepared.sort((a, b) =>
    a.topicPathKey === b.topicPathKey
      ? a.doc.id < b.doc.id
        ? -1
        : a.doc.id > b.doc.id
          ? 1
          : 0
      : a.topicPathKey < b.topicPathKey
        ? -1
        : 1,
  );
  const totalChunks = prepared.reduce((sum, p) => sum + p.chunks.length, 0);

  // ── shard assignment (greedy, topic-affine — §3.2) ────────────────────────
  const embedded = totalChunks <= SHARD_TARGET_CHUNKS;
  const shardOf = new Map<string, number>();
  let shardCount = 1;
  if (embedded) {
    for (const p of prepared) shardOf.set(p.doc.id, 0);
  } else {
    let current = 0;
    let filled = 0;
    for (const p of prepared) {
      if (filled > 0 && filled + p.chunks.length > SHARD_TARGET_CHUNKS) {
        current++;
        filled = 0;
      }
      shardOf.set(p.doc.id, current);
      filled += p.chunks.length;
    }
    shardCount = current + 1;
  }

  // ── staged database files ─────────────────────────────────────────────────
  rmSync(opts.workDir, { recursive: true, force: true });
  mkdirSync(join(opts.workDir, 'index', 'shards'), { recursive: true });
  const routerStaged = join(opts.workDir, ROUTER_DB_PATH);
  const shardPath = (id: number): string =>
    embedded ? ROUTER_DB_PATH : `index/shards/${String(id).padStart(3, '0')}.db`;

  // Every staged connection must close on ALL exit paths: an open handle
  // makes the workDir rmSync fail with EBUSY on Windows (both our own
  // cleanup and a caller's retry into the same workDir).
  const shardDbs = new Map<number, DatabaseSync>();
  const router = createCatalogDb(routerStaged);
  const closeAll = (): void => {
    for (const db of [router, ...shardDbs.values()]) {
      try {
        db.close();
      } catch {
        // already closed on the success path
      }
    }
  };
  try {
    router.exec(ROUTER_DDL);
    // One transaction per database for the whole build: without it every
    // insert autocommits (journal DELETE ⇒ an fsync each), which turns a
    // thousand-document build into minutes on Windows.
    router.exec('BEGIN');
    if (embedded) {
      router.exec(SHARD_DDL.replace('CREATE TABLE meta', 'CREATE TABLE IF NOT EXISTS meta'));
      router.exec(vecChunksDdl(profile.dimensions));
    }

    const commonMeta: Record<string, string> = {
      format_version: String(GEZK_FORMAT_VERSION),
      index_schema_version: String(GEZK_INDEX_SCHEMA_VERSION),
      catalog_id: opts.catalog.id,
      catalog_version: opts.catalog.version,
      embedding_profile_id: profile.id,
      chunking_profile_id: opts.chunkingProfile.id,
    };
    const putMeta = (db: DatabaseSync, extra: Record<string, string>) => {
      const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries({ ...commonMeta, ...extra })) stmt.run(k, v);
    };
    putMeta(router, {
      embedding_profile_json: JSON.stringify(profile),
      chunking_profile_json: JSON.stringify(opts.chunkingProfile),
      created_at: opts.catalog.createdAt,
      ...(opts.toolchain ? { toolchain_json: JSON.stringify(opts.toolchain) } : {}),
    });

    // topics (document_count filled below)
    const topicDocCount = new Map<string, number>();
    for (const p of prepared) {
      const t = p.doc.topicPath[0] as string;
      topicDocCount.set(t, (topicDocCount.get(t) ?? 0) + 1);
    }
    {
      const stmt = router.prepare(
        'INSERT INTO topics (id, parent_id, name, description, sort_key, document_count) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const t of [...opts.topics].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        stmt.run(
          t.id,
          t.parentId ?? null,
          t.name,
          t.description ?? null,
          t.sortKey ?? t.name.toLowerCase(),
          topicDocCount.get(t.id) ?? 0,
        );
      }
    }

    // documents + aliases + doc-FTS
    {
      const insertDoc = router.prepare(
        `INSERT INTO documents (id, title, slug, summary, language, topic_id, shard_id, chunk_count,
        source_url, source_revision, source_updated_at, attribution_json, body_codec, body_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAlias = router.prepare(
        'INSERT OR IGNORE INTO aliases (alias, document_id) VALUES (?, ?)',
      );
      const insertFts = router.prepare(
        'INSERT INTO fts_documents (title, summary, aliases, document_id) VALUES (?, ?, ?, ?)',
      );
      for (const p of prepared) {
        const body = Buffer.from(normalizeMarkdown(p.doc.markdown), 'utf8');
        if (body.byteLength > MAX_KNOWLEDGE_DOCUMENT_BYTES) {
          throw new Error(
            `document ${p.doc.id} exceeds the ${MAX_KNOWLEDGE_DOCUMENT_BYTES} byte body limit`,
          );
        }
        const useBrotli = body.length >= BODY_CODEC_MIN_BYTES;
        const blob = useBrotli
          ? brotliCompressSync(body, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
                [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
              },
            })
          : body;
        insertDoc.run(
          p.doc.id,
          p.doc.title,
          p.doc.slug || documentSlug(p.doc.title),
          p.doc.summary ?? null,
          p.doc.language,
          p.doc.topicPath[0] as string,
          BigInt(shardOf.get(p.doc.id) as number),
          BigInt(p.chunks.length),
          p.doc.sourceUrl ?? null,
          p.doc.sourceRevision ?? null,
          p.doc.sourceUpdatedAt ?? null,
          p.doc.attribution ? JSON.stringify(p.doc.attribution) : null,
          useBrotli ? 'br' : 'none',
          blob,
        );
        const aliases = [...new Set(p.doc.aliases ?? [])].sort();
        for (const alias of aliases) insertAlias.run(alias, p.doc.id);
        insertFts.run(p.doc.title, p.doc.summary ?? '', aliases.join(' '), p.doc.id);
      }
    }

    // ── per-shard chunk + vector writes ───────────────────────────────────────
    const shardChunkCounts = new Map<number, number>();
    const shardDocCounts = new Map<number, number>();
    const shardTopicIds = new Map<number, Set<string>>();
    /** Deterministic stride samples of float vectors per shard, for k-means. */
    const shardSamples = new Map<number, Float32Array[]>();

    const shardDb = (id: number): DatabaseSync => {
      if (embedded) return router;
      let db = shardDbs.get(id);
      if (!db) {
        db = createCatalogDb(join(opts.workDir, shardPath(id)));
        db.exec(SHARD_DDL);
        db.exec(vecChunksDdl(profile.dimensions));
        db.exec('BEGIN');
        shardDbs.set(id, db);
      }
      return db;
    };

    /** Cached per-db insert statements — re-preparing per row is a hot cost. */
    const vecStmts = new Map<
      DatabaseSync,
      { vec: ReturnType<DatabaseSync['prepare']>; int8: ReturnType<DatabaseSync['prepare']> }
    >();
    const vecStmtsFor = (db: DatabaseSync) => {
      let stmts = vecStmts.get(db);
      if (!stmts) {
        stmts = {
          vec: db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_bit(?))'),
          int8: db.prepare('INSERT INTO chunk_vectors_int8 (chunk_id, v) VALUES (?, ?)'),
        };
        vecStmts.set(db, stmts);
      }
      return stmts;
    };

    const embedBatchSize = opts.embedBatchSize ?? 32;
    let pendingTexts: string[] = [];
    let pendingRows: Array<{ shardId: number; chunkId: number }> = [];
    let processedChunks = 0;

    const flushEmbeds = async (): Promise<void> => {
      if (pendingTexts.length === 0) return;
      const vectors = await opts.embed(pendingTexts);
      if (vectors.length !== pendingTexts.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${pendingTexts.length} texts`,
        );
      }
      for (let i = 0; i < vectors.length; i++) {
        const unit = l2Normalize(vectors[i] as number[]);
        if (unit.length !== profile.dimensions) {
          throw new Error(
            `embedder returned dim ${unit.length}, profile expects ${profile.dimensions}`,
          );
        }
        const row = pendingRows[i] as { shardId: number; chunkId: number };
        const stmts = vecStmtsFor(shardDb(row.shardId));
        stmts.vec.run(BigInt(row.chunkId), Buffer.from(quantizeBinary(unit)));
        stmts.int8.run(BigInt(row.chunkId), Buffer.from(quantizeInt8(unit).buffer));
        // Deterministic stride sample for centroids (§3.3).
        const shardTotal = shardChunkCounts.get(row.shardId) ?? 0;
        void shardTotal;
        const samples = shardSamples.get(row.shardId) ?? [];
        shardSamples.set(row.shardId, samples);
        const stride = Math.max(1, Math.ceil(totalChunks / CENTROID_SAMPLE_MAX));
        if ((row.chunkId - 1) % stride === 0) samples.push(unit);
      }
      processedChunks += pendingTexts.length;
      opts.onProgress?.({ phase: 'embed', done: processedChunks, total: totalChunks });
      pendingTexts = [];
      pendingRows = [];
    };

    for (const p of prepared) {
      const shardId = shardOf.get(p.doc.id) as number;
      const db = shardDb(shardId);
      shardDocCounts.set(shardId, (shardDocCounts.get(shardId) ?? 0) + 1);
      const topics = shardTopicIds.get(shardId) ?? new Set<string>();
      topics.add(p.doc.topicPath[0] as string);
      shardTopicIds.set(shardId, topics);

      const insertChunk = db.prepare(
        `INSERT INTO chunks (chunk_uid, document_id, ordinal, title, heading_path, heading_text,
        line_start, line_end, token_count, content_hash, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      );
      const insertChunkFts = db.prepare(
        'INSERT INTO fts_chunks (rowid, title, heading_text, text) VALUES (?, ?, ?, ?)',
      );
      for (let ordinal = 0; ordinal < p.chunks.length; ordinal++) {
        const chunk = p.chunks[ordinal] as MarkdownChunk;
        const headingText = chunk.headingPath.join(' > ');
        const row = insertChunk.get(
          chunkUid(p.doc.id, ordinal, chunk.text),
          p.doc.id,
          BigInt(ordinal),
          p.doc.title,
          JSON.stringify(chunk.headingPath),
          headingText,
          BigInt(chunk.lineStart),
          BigInt(chunk.lineEnd),
          BigInt(opts.countTokens(chunk.text)),
          chunkContentHash(chunk.text),
          chunk.text,
        ) as { id: number | bigint };
        const chunkId = Number(row.id);
        insertChunkFts.run(BigInt(chunkId), p.doc.title, headingText, chunk.text);
        shardChunkCounts.set(shardId, (shardChunkCounts.get(shardId) ?? 0) + 1);

        // Embed input = title + heading path header (≤ contextHeader.maxTokens)
        // + chunk text, with the profile's passage instruction (§5).
        const header = buildContextHeader(
          p.doc.title,
          chunk.headingPath,
          opts.chunkingProfile.contextHeader.maxTokens,
          opts.countTokens,
        );
        pendingTexts.push(`${profile.passageInstruction}${header}${chunk.text}`);
        pendingRows.push({ shardId, chunkId });
        if (pendingTexts.length >= embedBatchSize) await flushEmbeds();
      }
    }
    await flushEmbeds();

    // ── shards table + centroids (§3.3) ───────────────────────────────────────
    {
      const insertShard = router.prepare(
        'INSERT INTO shards (id, path, chunk_count, document_count, topic_ids_json, centroid_count, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const insertCentroid = router.prepare(
        'INSERT INTO route_centroids (shard_id, embedding, weight) VALUES (?, ?, ?)',
      );
      for (let id = 0; id < shardCount; id++) {
        const chunkCount = shardChunkCounts.get(id) ?? 0;
        const samples = shardSamples.get(id) ?? [];
        const k = Math.max(
          1,
          Math.min(CENTROID_MAX_PER_SHARD, Math.ceil(chunkCount / CENTROID_CHUNKS_PER)),
        );
        const centroids = kMeans(samples, k, seedFor(opts.catalog.id, id));
        // Shard row first — route_centroids carries an FK to shards(id).
        insertShard.run(
          BigInt(id),
          shardPath(id),
          BigInt(chunkCount),
          BigInt(shardDocCounts.get(id) ?? 0),
          JSON.stringify([...(shardTopicIds.get(id) ?? [])].sort()),
          BigInt(centroids.length),
          BigInt(0), // authoritative sizes live in the manifest (post-VACUUM)
        );
        for (const c of centroids) {
          insertCentroid.run(BigInt(id), Buffer.from(c.centroid.buffer.slice(0)), BigInt(c.weight));
        }
      }
    }

    for (let id = 0; id < shardCount; id++) {
      if (!embedded)
        putMeta(shardDb(id), {
          shard_id: String(id),
          chunk_count: String(shardChunkCounts.get(id) ?? 0),
        });
    }
    if (embedded) putMeta(router, { shard_id: '0', chunk_count: String(totalChunks) });

    // ── VACUUM INTO final staged files (deterministic layout, §11) ────────────
    const finalDir = join(opts.workDir, 'final');
    mkdirSync(join(finalDir, 'index', 'shards'), { recursive: true });
    const vacuumed: Array<{ archivePath: string; absPath: string }> = [];
    const vacuumInto = (db: DatabaseSync, archivePath: string): void => {
      db.exec('COMMIT');
      const dest = join(finalDir, archivePath);
      db.exec(`VACUUM INTO '${dest.replaceAll("'", "''").replaceAll('\\', '/')}'`);
      vacuumed.push({ archivePath, absPath: dest });
    };
    vacuumInto(router, ROUTER_DB_PATH);
    if (!embedded) {
      for (let id = 0; id < shardCount; id++) vacuumInto(shardDb(id), shardPath(id));
    }
    router.close();
    for (const db of shardDbs.values()) db.close();

    // Patch shard byte sizes into the (already vacuumed) router? No — the
    // shards row records the PRE-vacuum estimate being wrong would drift the
    // manifest. Instead: sizes are measured from the vacuumed files and only
    // recorded in the MANIFEST (authoritative); shards.bytes stays 0 in v1
    // readers' eyes as "see manifest". Simpler than a re-vacuum cycle.

    // ── manifest + archive ────────────────────────────────────────────────────
    const files: KnowledgeCatalogManifest['files'] = [];
    const routerShardStats: KnowledgeCatalogManifest['router']['shards'] = [];
    for (const f of vacuumed) {
      const { sha256, sizeBytes } = await hashFileStreaming(f.absPath);
      files.push({ path: f.archivePath, sizeBytes, sha256 });
      const idMatch = /(\d+)\.db$/.exec(f.archivePath);
      const shardId = f.archivePath === ROUTER_DB_PATH ? 0 : Number(idMatch?.[1] ?? -1);
      if (f.archivePath !== ROUTER_DB_PATH || embedded) {
        routerShardStats.push({
          id: shardId,
          path: f.archivePath,
          chunks: shardChunkCounts.get(shardId) ?? 0,
          documents: shardDocCounts.get(shardId) ?? 0,
          centroids: Math.max(
            1,
            Math.min(
              CENTROID_MAX_PER_SHARD,
              Math.ceil((shardChunkCounts.get(shardId) ?? 0) / CENTROID_CHUNKS_PER),
            ),
          ),
          sha256,
        });
      }
    }
    const extraFiles = opts.extraFiles ?? {};
    for (const [path, content] of Object.entries(extraFiles)) {
      const bytes = Buffer.from(content, 'utf8');
      files.push({
        path,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }

    const unsignedManifest: KnowledgeCatalogManifest = KnowledgeCatalogManifestSchema.parse({
      kind: 'gezel-knowledge-catalog',
      formatVersion: GEZK_FORMAT_VERSION,
      indexSchemaVersion: GEZK_INDEX_SCHEMA_VERSION,
      id: opts.catalog.id,
      version: opts.catalog.version,
      name: opts.catalog.name,
      ...(opts.catalog.description ? { description: opts.catalog.description } : {}),
      language: opts.catalog.language,
      publisher: opts.catalog.publisher,
      createdAt: opts.catalog.createdAt,
      ...(opts.catalog.sourceSnapshot ? { sourceSnapshot: opts.catalog.sourceSnapshot } : {}),
      license: opts.catalog.license,
      embedding: profile,
      chunking: opts.chunkingProfile,
      topics: opts.topics.map((t) => ({ id: t.id, name: t.name })),
      router: {
        shardTargetChunks: SHARD_TARGET_CHUNKS,
        shards: routerShardStats.sort((a, b) => a.id - b.id),
        totalCentroids: routerShardStats.reduce((sum, s) => sum + s.centroids, 0),
      },
      counts: { documents: prepared.length, chunks: totalChunks, shards: shardCount },
      files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      compatibility: { maximumIndexSchemaVersion: GEZK_INDEX_SCHEMA_VERSION },
      ...(opts.smokeQueries ? { smokeQueries: opts.smokeQueries } : {}),
      ...(opts.toolchain ? { toolchain: opts.toolchain } : {}),
    });
    const manifest = opts.finalizeManifest
      ? KnowledgeCatalogManifestSchema.parse(opts.finalizeManifest(unsignedManifest))
      : unsignedManifest;

    const archiveEntries: Array<{ path: string; absPath?: string; content?: Buffer }> = [
      {
        path: MANIFEST_PATH,
        content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      },
      ...vacuumed.map((f) => ({ path: f.archivePath, absPath: f.absPath })),
      ...Object.entries(extraFiles).map(([path, content]) => ({
        path,
        content: Buffer.from(content, 'utf8'),
      })),
    ];
    await writeGezkArchive(opts.outputPath, archiveEntries);
    const archiveBytes = (await stat(opts.outputPath)).size;
    rmSync(opts.workDir, { recursive: true, force: true });

    return {
      manifest,
      documents: prepared.length,
      chunks: totalChunks,
      shards: shardCount,
      archiveBytes,
    };
  } finally {
    closeAll();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function createCatalogDb(absPath: string): DatabaseSync {
  const db = new DatabaseSync(absPath, { allowExtension: true });
  loadVecExtension(db);
  db.exec('PRAGMA page_size=8192');
  db.exec(`PRAGMA application_id=${GEZK_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version=${GEZK_INDEX_SCHEMA_VERSION}`);
  db.exec('PRAGMA journal_mode=DELETE');
  return db;
}

function normalizeMarkdown(md: string): string {
  return md.replace(/\r\n/g, '\n').normalize('NFC');
}

/** `title\nheadingPath\n`, truncated to the header token budget (§5). */
function buildContextHeader(
  title: string,
  headingPath: string[],
  maxTokens: number,
  countTokens: (text: string) => number,
): string {
  const path = headingPath.filter((h) => h !== title);
  let header = path.length > 0 ? `${title}\n${path.join(' > ')}\n` : `${title}\n`;
  if (countTokens(header) > maxTokens) {
    header = `${title}\n`;
    if (countTokens(header) > maxTokens) header = '';
  }
  return header;
}

/** Low 64 bits of SHA-256(catalogId \0 shardId) as the k-means seed (§3.3). */
function seedFor(catalogId: string, shardId: number): bigint {
  const digest = createHash('sha256')
    .update(catalogId, 'utf8')
    .update(Buffer.from([0]))
    .update(String(shardId), 'utf8')
    .digest();
  return digest.readBigUInt64LE(24);
}

/** Deterministic xorshift64* PRNG for seeded k-means++. */
function makePrng(seed: bigint): () => number {
  let state = seed === 0n ? 0x9e3779b97f4a7c15n : seed;
  return () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & 0xffffffffffffffffn;
    state ^= state >> 27n;
    const out = (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
    return Number(out >> 11n) / 2 ** 53;
  };
}

/** Bounded seeded k-means++ over unit vectors; returns unit centroids. */
function kMeans(
  samples: Float32Array[],
  k: number,
  seed: bigint,
): Array<{ centroid: Float32Array; weight: number }> {
  if (samples.length === 0) return [];
  const kk = Math.min(k, samples.length);
  const rand = makePrng(seed);
  const dim = (samples[0] as Float32Array).length;

  // k-means++ init: first pick uniform, then distance-weighted.
  const centroids: Float32Array[] = [
    Float32Array.from(samples[Math.floor(rand() * samples.length)] as Float32Array),
  ];
  const dist2 = (a: Float32Array, b: Float32Array): number => {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += (a[i] as number) * (b[i] as number);
    return Math.max(0, 2 - 2 * dot); // squared euclidean on unit vectors
  };
  while (centroids.length < kk) {
    const weights = samples.map((s) => Math.min(...centroids.map((c) => dist2(s, c))));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) break;
    let target = rand() * total;
    let pick = 0;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i] as number;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(Float32Array.from(samples[pick] as Float32Array));
  }

  const assignment = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < CENTROID_KMEANS_MAX_ITER; iter++) {
    let moved = 0;
    for (let s = 0; s < samples.length; s++) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(samples[s] as Float32Array, centroids[c] as Float32Array);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignment[s] !== best) {
        assignment[s] = best;
        moved++;
      }
    }
    // Recompute means (re-normalized to unit — routing compares cosine).
    const sums = centroids.map(() => new Float64Array(dim));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let s = 0; s < samples.length; s++) {
      const c = assignment[s] as number;
      counts[c] = (counts[c] as number) + 1;
      const sum = sums[c] as Float64Array;
      const sample = samples[s] as Float32Array;
      for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) + (sample[i] as number);
    }
    for (let c = 0; c < centroids.length; c++) {
      if ((counts[c] as number) === 0) continue;
      const sum = sums[c] as Float64Array;
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += (sum[i] as number) ** 2;
      norm = Math.sqrt(norm) || 1;
      const centroid = centroids[c] as Float32Array;
      for (let i = 0; i < dim; i++) centroid[i] = (sum[i] as number) / norm;
    }
    if (moved === 0) break;
  }

  const weights = new Array<number>(centroids.length).fill(0);
  for (const a of assignment) weights[a] = (weights[a] as number) + 1;
  return centroids
    .map((centroid, i) => ({ centroid, weight: weights[i] as number }))
    .filter((c) => c.weight > 0);
}
