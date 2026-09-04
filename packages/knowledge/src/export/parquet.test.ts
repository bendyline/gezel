import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from '../archive/read.js';
import { compileKnowledgeCatalog } from '../compiler/compile.js';
import { openCatalogDatabase } from '../reader/open.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from '../test/fixture.js';
import { duckdbVersion, runDuckdbScript } from './duckdb.js';
import { PARQUET_REPORT_PATH, exportCatalogParquet, findDuckdbBinary } from './parquet.js';

const binaryPath = await findDuckdbBinary();

let dir: string;
let archivePath: string;

async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  if (!binaryPath) throw new Error('no duckdb');
  const out = await runDuckdbScript({ binaryPath }, `.mode json\n${sql}`);
  return out.trim() ? (JSON.parse(out) as Array<Record<string, unknown>>) : [];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-parquet-'));
  archivePath = join(dir, 'fixture-en-1.0.0.gezk');
  const docs = generateFixtureCorpus(120, 7);
  await compileKnowledgeCatalog({
    catalog: {
      id: 'fixture-en',
      version: '1.0.0',
      name: 'Fixture Catalog',
      description: 'Synthetic corpus for Parquet export tests.',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of docs) yield doc;
    })(),
    outputPath: archivePath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, 'work'),
  });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!binaryPath)('exportCatalogParquet', () => {
  it('writes deterministic Parquet tables that mirror the archive byte for byte', async () => {
    if (!binaryPath) return;
    const cli = { binaryPath, expectedVersion: await duckdbVersion(binaryPath) };
    const first = await exportCatalogParquet({
      source: { archivePath },
      outDir: join(dir, 'out-1'),
      duckdb: cli,
    });
    const second = await exportCatalogParquet({
      source: { archivePath },
      outDir: join(dir, 'out-2'),
      duckdb: cli,
    });
    expect(first.files.map((f) => f.path)).toEqual([
      'topics.parquet',
      'documents-000.parquet',
      'chunks-000.parquet',
    ]);
    expect(second.files.map((f) => f.sha256)).toEqual(first.files.map((f) => f.sha256));
    for (const file of first.files) {
      const bytes = await readFile(join(dir, 'out-1', file.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      expect(bytes.length).toBe(file.sizeBytes);
    }
    expect(await stat(join(dir, 'out-1', PARQUET_REPORT_PATH))).toBeTruthy();
    expect(first.duckdbVersion).toBe(cli.expectedVersion);
    expect(first.catalogId).toBe('fixture-en');

    // Row counts follow the sealed manifest, not the staging.
    const manifest = await readGezkManifest(archivePath);
    const chunks = join(dir, 'out-1', 'chunks-000.parquet');
    const documents = join(dir, 'out-1', 'documents-000.parquet');
    const topics = join(dir, 'out-1', 'topics.parquet');
    const [counts] = await query(
      `SELECT (SELECT count(*) FROM '${chunks}') AS chunks, (SELECT count(*) FROM '${documents}') AS documents, (SELECT count(*) FROM '${topics}') AS topics;`,
    );
    expect(Number(counts?.chunks)).toBe(manifest.counts.chunks);
    expect(Number(counts?.documents)).toBe(manifest.counts.documents);
    expect(Number(counts?.topics)).toBe(FIXTURE_TOPICS.length);
    expect(first.files.find((f) => f.table === 'chunks')?.rows).toBe(manifest.counts.chunks);

    // Embeddings are the archive's int8 and bit blobs, unchanged.
    const extracted = join(dir, 'extracted');
    await extractGezkVerified(archivePath, extracted);
    const shard = openCatalogDatabase(join(extracted, manifest.router.shards[0]?.path ?? ''));
    try {
      const sampled = await query(
        `SELECT id, chunk_uid, embedding, hex(embedding_bit) AS bits, heading_path FROM '${chunks}' ORDER BY id LIMIT 5;`,
      );
      expect(sampled.length).toBe(5);
      for (const row of sampled) {
        const stored = shard.db
          .prepare(
            'SELECT c.chunk_uid, i.v AS int8, b.v AS bits FROM chunks c JOIN chunk_vectors_int8 i ON i.chunk_id = c.id JOIN chunk_vectors_bit b ON b.chunk_id = c.id WHERE c.id = ?',
          )
          .get(Number(row.id)) as { chunk_uid: string; int8: Uint8Array; bits: Uint8Array };
        expect(row.chunk_uid).toBe(stored.chunk_uid);
        const int8 = Buffer.from(stored.int8);
        expect(row.embedding).toEqual(
          Array.from(new Int8Array(int8.buffer, int8.byteOffset, int8.length)),
        );
        expect(String(row.bits).toLowerCase()).toBe(Buffer.from(stored.bits).toString('hex'));
        expect(Array.isArray(row.heading_path)).toBe(true);
      }
    } finally {
      shard.close();
    }

    // Document bodies are decoded, and the topic path is materialised.
    const router = openCatalogDatabase(join(extracted, 'index', 'router.db'));
    try {
      const [doc] = await query(
        `SELECT id, markdown, topic_id, topic_path, aliases FROM '${documents}' ORDER BY id LIMIT 1;`,
      );
      const stored = router.db
        .prepare('SELECT body_codec, body_blob, topic_id FROM documents WHERE id = ?')
        .get(doc?.id as string) as { body_codec: string; body_blob: Uint8Array; topic_id: string };
      const body =
        stored.body_codec === 'br'
          ? brotliDecompressSync(Buffer.from(stored.body_blob)).toString('utf8')
          : Buffer.from(stored.body_blob).toString('utf8');
      expect(doc?.markdown).toBe(body);
      expect(doc?.topic_id).toBe(stored.topic_id);
      expect((doc?.topic_path as string[]).at(-1)).toBe(stored.topic_id);
    } finally {
      router.close();
    }

    // The dequantisation rule travels with the file.
    const metadata = await query(
      `SELECT key::VARCHAR AS key, value::VARCHAR AS value FROM parquet_kv_metadata('${chunks}');`,
    );
    const byKey = new Map(metadata.map((m) => [m.key, m.value]));
    expect(byKey.get('gezk_catalog_id')).toBe('fixture-en');
    expect(byKey.get('gezk_embedding_int8')).toContain('x = q / 127');
    expect(byKey.get('gezk_embedding_dimensions')).toBe(
      String(FIXTURE_EMBEDDING_PROFILE.dimensions),
    );
  }, 120_000);

  it('exports an extracted catalog directory the same way', async () => {
    if (!binaryPath) return;
    const fromArchive = JSON.parse(
      await readFile(join(dir, 'out-1', PARQUET_REPORT_PATH), 'utf8'),
    ) as { files: Array<{ sha256: string }> };
    const report = await exportCatalogParquet({
      source: { rootDir: join(dir, 'extracted') },
      outDir: join(dir, 'out-3'),
      duckdb: { binaryPath },
    });
    expect(report.files.map((f) => f.sha256)).toEqual(fromArchive.files.map((f) => f.sha256));
  }, 120_000);
});
