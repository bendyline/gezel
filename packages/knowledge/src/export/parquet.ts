/**
 * The Parquet companion of a catalog: `documents-NNN.parquet` and
 * `chunks-NNN.parquet` per shard plus `topics.parquet`, derived from the
 * sealed archive so anyone can load a catalog with DuckDB, pandas, Polars or
 * the `datasets` library without a gezk reader. Column names are the gezk DDL
 * names; embeddings are the int8 and bit vectors EXACTLY as the archive
 * stores them (provably identical, one third of float32's size), with the
 * dequantisation rule recorded in the file metadata (gezk spec §6).
 *
 * Determinism: rows are read in primary-key order and written single-
 * threaded with insertion order preserved, a fixed codec and level, a fixed
 * row-group size, and no wall-clock metadata — so two exports of one archive
 * with one DuckDB release produce byte-identical files. The pinned DuckDB
 * version is part of the report because the writer's framing is part of the
 * bytes.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import type { KnowledgeCatalogManifest } from '@bendyline/gezk';
import { KnowledgeCatalogManifestSchema } from '@bendyline/gezk';
import { extractGezkVerified } from '../archive/read.js';
import {
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  ROUTER_DB_PATH,
} from '../format/constants.js';
import { type CatalogDb, openCatalogDatabase } from '../reader/open.js';
import { KNOWLEDGE_TOOLCHAIN } from '../toolchain.js';
import { type DuckdbCli, assertDuckdbCli, runDuckdbScript } from './duckdb.js';

export const PARQUET_EXPORT_VERSION = 1;
const DEFAULT_ROW_GROUP_SIZE = 32_768;
/** `read_ndjson` refuses objects above this; a document body can approach MAX_KNOWLEDGE_DOCUMENT_BYTES. */
const NDJSON_MAX_OBJECT_BYTES = Math.max(64 * 1024 * 1024, MAX_KNOWLEDGE_DOCUMENT_BYTES * 2);

export type ParquetExportSource = { archivePath: string } | { rootDir: string };

export interface ParquetExportOptions {
  source: ParquetExportSource;
  outDir: string;
  duckdb: DuckdbCli;
  rowGroupSize?: number;
  onProgress?: (event: ParquetExportProgress) => void;
}

export type ParquetExportProgress =
  | { phase: 'extract' }
  | { phase: 'stage'; table: ParquetTable; shardId?: number; rows: number }
  | { phase: 'write'; file: string };

export type ParquetTable = 'documents' | 'chunks' | 'topics';

export interface ParquetExportFile {
  /** Relative to `outDir`, forward slashes. */
  path: string;
  table: ParquetTable;
  shardId?: number;
  rows: number;
  sizeBytes: number;
  sha256: string;
}

export interface ParquetExportReport {
  exportVersion: number;
  catalogId: string;
  version: string;
  publisherId: string;
  formatVersion: string;
  embeddingProfileId: string;
  dimensions: number;
  files: ParquetExportFile[];
  duckdbVersion: string;
  exporter: { name: string; version: string };
}

export const PARQUET_REPORT_PATH = 'parquet-manifest.json';

export async function exportCatalogParquet(
  opts: ParquetExportOptions,
): Promise<ParquetExportReport> {
  const duckdbVersion = await assertDuckdbCli(opts.duckdb);
  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  const work = join(outDir, `.export-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(work, { recursive: true });
  try {
    let rootDir: string;
    if ('archivePath' in opts.source) {
      opts.onProgress?.({ phase: 'extract' });
      rootDir = join(work, 'catalog');
      await extractGezkVerified(opts.source.archivePath, rootDir);
    } else {
      rootDir = resolve(opts.source.rootDir);
    }
    const manifest = KnowledgeCatalogManifestSchema.parse(
      JSON.parse(await readFile(join(rootDir, MANIFEST_PATH), 'utf8')),
    );
    const staging = join(work, 'ndjson');
    await mkdir(staging, { recursive: true });
    const files: ParquetExportFile[] = [];
    const metadata = kvMetadata(manifest);
    const rowGroupSize = opts.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE;

    const router = openCatalogDatabase(join(rootDir, ROUTER_DB_PATH));
    try {
      const topicPaths = topicPathsOf(router);
      const topicRows = await stageTopics(router, join(staging, 'topics.ndjson'));
      opts.onProgress?.({ phase: 'stage', table: 'topics', rows: topicRows });
      files.push(
        await writeParquet(opts.duckdb, {
          outDir,
          file: 'topics.parquet',
          table: 'topics',
          rows: topicRows,
          sql: topicsCopy(
            join(staging, 'topics.ndjson'),
            join(outDir, 'topics.parquet'),
            rowGroupSize,
            metadata,
          ),
          onProgress: opts.onProgress,
        }),
      );

      for (const shard of manifest.router.shards) {
        const tag = String(shard.id).padStart(3, '0');
        const documentsNdjson = join(staging, `documents-${tag}.ndjson`);
        const documentRows = await stageDocuments(router, shard.id, topicPaths, documentsNdjson);
        opts.onProgress?.({
          phase: 'stage',
          table: 'documents',
          shardId: shard.id,
          rows: documentRows,
        });
        files.push(
          await writeParquet(opts.duckdb, {
            outDir,
            file: `documents-${tag}.parquet`,
            table: 'documents',
            shardId: shard.id,
            rows: documentRows,
            sql: documentsCopy(
              documentsNdjson,
              join(outDir, `documents-${tag}.parquet`),
              rowGroupSize,
              metadata,
            ),
            onProgress: opts.onProgress,
          }),
        );

        const shardDb = openCatalogDatabase(join(rootDir, shard.path));
        const chunksNdjson = join(staging, `chunks-${tag}.ndjson`);
        let chunkRows: number;
        try {
          chunkRows = await stageChunks(
            shardDb,
            shard.id,
            manifest.embedding.dimensions,
            chunksNdjson,
          );
        } finally {
          shardDb.close();
        }
        opts.onProgress?.({ phase: 'stage', table: 'chunks', shardId: shard.id, rows: chunkRows });
        files.push(
          await writeParquet(opts.duckdb, {
            outDir,
            file: `chunks-${tag}.parquet`,
            table: 'chunks',
            shardId: shard.id,
            rows: chunkRows,
            sql: chunksCopy(
              chunksNdjson,
              join(outDir, `chunks-${tag}.parquet`),
              manifest.embedding.dimensions,
              rowGroupSize,
              metadata,
            ),
            onProgress: opts.onProgress,
          }),
        );
      }
    } finally {
      router.close();
    }

    const report: ParquetExportReport = {
      exportVersion: PARQUET_EXPORT_VERSION,
      catalogId: manifest.id,
      version: manifest.version,
      publisherId: manifest.publisher.id,
      formatVersion: manifest.formatVersion,
      embeddingProfileId: manifest.embedding.id,
      dimensions: manifest.embedding.dimensions,
      files,
      duckdbVersion,
      exporter: { name: KNOWLEDGE_TOOLCHAIN.name, version: KNOWLEDGE_TOOLCHAIN.version },
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(outDir, PARQUET_REPORT_PATH),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    return report;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── staging: SQLite rows → NDJSON, one line per row in primary-key order ────

interface NdjsonWriter {
  write(row: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function ndjsonWriter(path: string): NdjsonWriter {
  const stream = createWriteStream(path, { encoding: 'utf8' });
  return {
    write(row) {
      const line = `${JSON.stringify(row)}\n`;
      if (stream.write(line)) return Promise.resolve();
      return new Promise((resolveDrain) => stream.once('drain', () => resolveDrain()));
    },
    close() {
      return new Promise((resolveClose, reject) => {
        stream.on('error', reject);
        stream.end(() => resolveClose());
      });
    },
  };
}

/** topic id → the ids from the root down to it, from the shipped tree. */
function topicPathsOf(router: CatalogDb): Map<string, string[]> {
  const parents = new Map<string, string | null>();
  for (const row of router.db.prepare('SELECT id, parent_id FROM topics').all() as Array<{
    id: string;
    parent_id: string | null;
  }>) {
    parents.set(row.id, row.parent_id);
  }
  const paths = new Map<string, string[]>();
  for (const id of parents.keys()) {
    const path: string[] = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      path.unshift(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    paths.set(id, path);
  }
  return paths;
}

async function stageTopics(router: CatalogDb, path: string): Promise<number> {
  const out = ndjsonWriter(path);
  let rows = 0;
  const statement = router.db.prepare(
    'SELECT id, parent_id, name, description, sort_key, document_count FROM topics ORDER BY sort_key, id',
  );
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    await out.write({
      id: row.id,
      parent_id: row.parent_id ?? null,
      name: row.name,
      description: row.description ?? null,
      sort_key: row.sort_key,
      document_count: Number(row.document_count),
    });
    rows++;
  }
  await out.close();
  return rows;
}

async function stageDocuments(
  router: CatalogDb,
  shardId: number,
  topicPaths: Map<string, string[]>,
  path: string,
): Promise<number> {
  const out = ndjsonWriter(path);
  let rows = 0;
  const aliasesOf = router.db.prepare(
    'SELECT alias FROM aliases WHERE document_id = ? ORDER BY alias',
  );
  const statement = router.db.prepare(
    `SELECT id, title, slug, summary, language, topic_id, shard_id, chunk_count,
            source_url, source_revision, source_updated_at, attribution_json, body_codec, body_blob
       FROM documents WHERE shard_id = ? ORDER BY id`,
  );
  for (const row of statement.iterate(shardId) as Iterable<Record<string, unknown>>) {
    const aliases = (aliasesOf.all(row.id as string) as Array<{ alias: string }>).map(
      (a) => a.alias,
    );
    await out.write({
      id: row.id,
      title: row.title,
      slug: row.slug,
      summary: row.summary ?? null,
      language: row.language,
      topic_id: row.topic_id,
      topic_path: topicPaths.get(row.topic_id as string) ?? [row.topic_id],
      shard_id: Number(row.shard_id),
      chunk_count: Number(row.chunk_count),
      markdown: decodeBody(row.body_codec as string, row.body_blob as Uint8Array),
      source_url: row.source_url ?? null,
      source_revision: row.source_revision ?? null,
      source_updated_at: row.source_updated_at ?? null,
      attribution: row.attribution_json ?? null,
      aliases,
    });
    rows++;
  }
  await out.close();
  return rows;
}

function decodeBody(codec: string, blob: Uint8Array): string {
  const bytes = Buffer.from(blob);
  if (codec === 'br') {
    return brotliDecompressSync(bytes, { maxOutputLength: MAX_KNOWLEDGE_DOCUMENT_BYTES }).toString(
      'utf8',
    );
  }
  if (codec === 'none') return bytes.toString('utf8');
  throw new Error(`unknown body codec ${codec}`);
}

async function stageChunks(
  shard: CatalogDb,
  shardId: number,
  dimensions: number,
  path: string,
): Promise<number> {
  const out = ndjsonWriter(path);
  const bitBytes = Math.ceil(dimensions / 8);
  let rows = 0;
  const statement = shard.db.prepare(
    `SELECT c.id, c.chunk_uid, c.document_id, c.ordinal, c.title, c.heading_path, c.heading_text,
            c.text, c.token_count, c.content_hash, c.line_start, c.line_end,
            i.v AS int8, b.v AS bits
       FROM chunks c
       JOIN chunk_vectors_int8 i ON i.chunk_id = c.id
       JOIN chunk_vectors_bit b ON b.chunk_id = c.id
      ORDER BY c.id`,
  );
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const int8 = Buffer.from(row.int8 as Uint8Array);
    const bits = Buffer.from(row.bits as Uint8Array);
    if (int8.length !== dimensions || bits.length !== bitBytes) {
      throw new Error(
        `chunk ${row.chunk_uid as string}: vector widths ${int8.length}/${bits.length} do not match the ${dimensions}-dimension profile`,
      );
    }
    await out.write({
      id: Number(row.id),
      chunk_uid: row.chunk_uid,
      document_id: row.document_id,
      ordinal: Number(row.ordinal),
      title: row.title,
      heading_path: parseJsonStrings(row.heading_path as string),
      heading_text: row.heading_text,
      text: row.text,
      token_count: Number(row.token_count),
      content_hash: row.content_hash,
      line_start: Number(row.line_start),
      line_end: Number(row.line_end),
      shard_id: shardId,
      embedding: Array.from(new Int8Array(int8.buffer, int8.byteOffset, int8.length)),
      embedding_bit: bits.toString('base64'),
    });
    rows++;
  }
  await out.close();
  return rows;
}

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// ── DuckDB COPY statements ──────────────────────────────────────────────────

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function kvMetadata(manifest: KnowledgeCatalogManifest): Record<string, string> {
  return {
    gezk_catalog_id: manifest.id,
    gezk_catalog_version: manifest.version,
    gezk_publisher_id: manifest.publisher.id,
    gezk_format_version: manifest.formatVersion,
    gezk_embedding_profile: manifest.embedding.id,
    gezk_embedding_model: manifest.embedding.model.repo,
    gezk_embedding_dimensions: String(manifest.embedding.dimensions),
    gezk_embedding_int8: 'symmetric-linear scale 127: x = q / 127',
    gezk_embedding_bit: 'sign bits, LSB-first, ceil(dimensions/8) bytes: bit = x > 0',
    gezk_parquet_export_version: String(PARQUET_EXPORT_VERSION),
    gezk_license: manifest.license.name,
  };
}

function copyOptions(rowGroupSize: number, metadata: Record<string, string>): string {
  const kv = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${sqlString(value)}`)
    .join(', ');
  return `(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 3, ROW_GROUP_SIZE ${rowGroupSize}, KV_METADATA {${kv}})`;
}

const PRELUDE = 'SET threads = 1;\nSET preserve_insertion_order = true;\n';

function readNdjson(path: string, columns: Record<string, string>): string {
  const spec = Object.entries(columns)
    .map(([name, type]) => `${name}: ${sqlString(type)}`)
    .join(', ');
  return `read_ndjson(${sqlString(path)}, columns = {${spec}}, maximum_object_size = ${NDJSON_MAX_OBJECT_BYTES})`;
}

function topicsCopy(
  ndjson: string,
  out: string,
  rowGroupSize: number,
  metadata: Record<string, string>,
): string {
  const source = readNdjson(ndjson, {
    id: 'VARCHAR',
    parent_id: 'VARCHAR',
    name: 'VARCHAR',
    description: 'VARCHAR',
    sort_key: 'VARCHAR',
    document_count: 'BIGINT',
  });
  return `${PRELUDE}COPY (SELECT id, parent_id, name, description, sort_key, document_count FROM ${source}) TO ${sqlString(out)} ${copyOptions(rowGroupSize, metadata)};\n`;
}

function documentsCopy(
  ndjson: string,
  out: string,
  rowGroupSize: number,
  metadata: Record<string, string>,
): string {
  const source = readNdjson(ndjson, {
    id: 'VARCHAR',
    title: 'VARCHAR',
    slug: 'VARCHAR',
    summary: 'VARCHAR',
    language: 'VARCHAR',
    topic_id: 'VARCHAR',
    topic_path: 'VARCHAR[]',
    shard_id: 'INTEGER',
    chunk_count: 'INTEGER',
    markdown: 'VARCHAR',
    source_url: 'VARCHAR',
    source_revision: 'VARCHAR',
    source_updated_at: 'VARCHAR',
    attribution: 'VARCHAR',
    aliases: 'VARCHAR[]',
  });
  return `${PRELUDE}COPY (SELECT id, title, slug, summary, language, topic_id, topic_path, shard_id, chunk_count, markdown, source_url, source_revision, source_updated_at, attribution, aliases FROM ${source}) TO ${sqlString(out)} ${copyOptions(rowGroupSize, metadata)};\n`;
}

function chunksCopy(
  ndjson: string,
  out: string,
  dimensions: number,
  rowGroupSize: number,
  metadata: Record<string, string>,
): string {
  const source = readNdjson(ndjson, {
    id: 'BIGINT',
    chunk_uid: 'VARCHAR',
    document_id: 'VARCHAR',
    ordinal: 'INTEGER',
    title: 'VARCHAR',
    heading_path: 'VARCHAR[]',
    heading_text: 'VARCHAR',
    text: 'VARCHAR',
    token_count: 'INTEGER',
    content_hash: 'VARCHAR',
    line_start: 'INTEGER',
    line_end: 'INTEGER',
    shard_id: 'INTEGER',
    embedding: 'TINYINT[]',
    embedding_bit: 'VARCHAR',
  });
  return `${PRELUDE}COPY (SELECT id, chunk_uid, document_id, ordinal, title, heading_path, heading_text, text, token_count, content_hash, line_start, line_end, shard_id, embedding::TINYINT[${dimensions}] AS embedding, from_base64(embedding_bit) AS embedding_bit FROM ${source}) TO ${sqlString(out)} ${copyOptions(rowGroupSize, metadata)};\n`;
}

async function writeParquet(
  cli: DuckdbCli,
  spec: {
    outDir: string;
    file: string;
    table: ParquetTable;
    shardId?: number;
    rows: number;
    sql: string;
    onProgress?: (event: ParquetExportProgress) => void;
  },
): Promise<ParquetExportFile> {
  spec.onProgress?.({ phase: 'write', file: spec.file });
  const target = join(spec.outDir, spec.file);
  await rm(target, { force: true });
  await runDuckdbScript(cli, spec.sql);
  const bytes = await readFile(target);
  return {
    path: spec.file,
    table: spec.table,
    ...(spec.shardId !== undefined ? { shardId: spec.shardId } : {}),
    rows: spec.rows,
    sizeBytes: (await stat(target)).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Where a test or CLI may find a DuckDB CLI without configuration: env, then a gezel engine cache. */
export async function findDuckdbBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = env.GEZEL_DUCKDB_BIN?.trim();
  if (configured) return configured;
  const { readdir } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const name = process.platform === 'win32' ? 'duckdb.exe' : 'duckdb';
  const homes = [env.GEZEL_HOME, join(homedir(), '.gezel-dev'), join(homedir(), '.gezel')].filter(
    (h): h is string => Boolean(h),
  );
  for (const home of homes) {
    const engines = join(home, 'engines', 'duckdb');
    const versions = (await readdir(engines).catch(() => [] as string[])).sort().reverse();
    for (const version of versions) {
      const candidate = join(engines, version, name);
      if (await stat(candidate).catch(() => null)) return candidate;
    }
  }
  const pathDirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await stat(candidate).catch(() => null)) return candidate;
  }
  return null;
}
