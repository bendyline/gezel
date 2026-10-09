/**
 * `shardFill: 'semantic'` — shards grouped by what documents are about,
 * not by where they sit in the table of contents.
 *
 * The corpus interleaves two groups (every other document is "ALPHA", the
 * rest "BETA") across the same topics, so topic-order slices mix them; an
 * embedder that points each group in its own direction makes the right
 * semantic answer unambiguous. Also checked: the build stays deterministic,
 * every shard stays within its capacity, and the archive validates.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from '../archive/read.js';
import { DatabaseSync } from '../format/node-sqlite.js';
import { validateExtractedCatalog } from '../reader/validate.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from '../test/fixture.js';
import { compileKnowledgeCatalog } from './compile.js';

let dir: string;
const DOCS: CatalogDocument[] = generateFixtureCorpus(80, 11).map((doc, i) => ({
  ...doc,
  title: `${i % 2 === 0 ? 'ALPHA' : 'BETA'} ${doc.title}`,
}));

/** Two orthogonal group directions plus the fixture's hash noise. */
async function groupEmbed(texts: string[]): Promise<number[][]> {
  const noise = await fakeEmbed(texts);
  return texts.map((text, t) => {
    const v = (noise[t] as number[]).map((x) => x * 0.05);
    v[text.includes('ALPHA') ? 0 : 1] = (v[text.includes('ALPHA') ? 0 : 1] as number) + 1;
    return v;
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-shard-fill-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function build(name: string, shardFill: 'topic' | 'semantic', shardTargetChunks: number) {
  const outputPath = join(dir, `${name}.gezk`);
  const report = await compileKnowledgeCatalog({
    catalog: {
      id: 'fixture-en',
      version: '1.0.0',
      name: 'Fixture Catalog',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of DOCS) yield doc;
    })(),
    outputPath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: groupEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, `work-${name}`),
    assets: FIXTURE_ASSETS,
    shardTargetChunks,
    shardFill,
  });
  const extracted = join(dir, `x-${name}`);
  await extractGezkVerified(outputPath, extracted);
  const router = new DatabaseSync(join(extracted, 'index', 'router.db'));
  const rows = router.prepare('SELECT id, title, shard_id FROM documents').all() as Array<{
    id: string;
    title: string;
    shard_id: number | bigint;
  }>;
  const shards = router.prepare('SELECT id, chunk_count FROM shards').all() as Array<{
    id: number | bigint;
    chunk_count: number | bigint;
  }>;
  router.close();
  return { report, outputPath, extracted, rows, shards };
}

/** Share of documents sharing a shard with the majority of their own group. */
function purity(rows: Array<{ title: string; shard_id: number | bigint }>): number {
  const byShard = new Map<number, { alpha: number; beta: number }>();
  for (const r of rows) {
    const s = byShard.get(Number(r.shard_id)) ?? { alpha: 0, beta: 0 };
    if (r.title.startsWith('ALPHA')) s.alpha++;
    else s.beta++;
    byShard.set(Number(r.shard_id), s);
  }
  let majority = 0;
  for (const s of byShard.values()) majority += Math.max(s.alpha, s.beta);
  return majority / rows.length;
}

describe("shardFill: 'semantic'", () => {
  it('groups documents by meaning where topic order mixes them', async () => {
    const total = (await build('probe', 'topic', 1_000_000)).report.chunks;
    const target = Math.ceil(total / 2);
    const topic = await build('topic', 'topic', target);
    const semantic = await build('semantic', 'semantic', target);
    expect(topic.shards.length).toBe(2);
    expect(semantic.shards.length).toBe(2);
    expect(purity(topic.rows)).toBeLessThan(0.7);
    expect(purity(semantic.rows)).toBeGreaterThan(0.9);
    // Balanced: no shard over its capacity (2% slack over an even split).
    for (const s of semantic.shards) {
      expect(Number(s.chunk_count)).toBeLessThanOrEqual(Math.ceil((total / 2) * 1.02));
    }
    const report = await validateExtractedCatalog(semantic.extracted, { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('files a document that chunks to nothing instead of failing the build', async () => {
    const empty: CatalogDocument = {
      ...(DOCS[0] as CatalogDocument),
      id: 'empty-doc',
      slug: 'empty-doc',
      title: 'ALPHA Empty',
      markdown: '',
    };
    const outputPath = join(dir, 'empty.gezk');
    await compileKnowledgeCatalog({
      catalog: {
        id: 'fixture-en',
        version: '1.0.0',
        name: 'Fixture Catalog',
        language: 'en',
        publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
        createdAt: '2026-01-01T00:00:00.000Z',
        license: { name: 'MIT', attributionRequired: false },
      },
      topics: FIXTURE_TOPICS,
      documents: (async function* () {
        for (const doc of [...DOCS, empty]) yield doc;
      })(),
      outputPath,
      embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
      chunkingProfile: FIXTURE_CHUNKING_PROFILE,
      embed: groupEmbed,
      countTokens: fakeCountTokens,
      workDir: join(dir, 'work-empty'),
      assets: FIXTURE_ASSETS,
      shardTargetChunks: 40,
      shardFill: 'semantic',
    });
    const extracted = join(dir, 'x-empty');
    await extractGezkVerified(outputPath, extracted);
    const router = new DatabaseSync(join(extracted, 'index', 'router.db'));
    const row = router
      .prepare('SELECT shard_id, chunk_count FROM documents WHERE id = ?')
      .get('empty-doc') as { shard_id: number | bigint; chunk_count: number | bigint } | undefined;
    router.close();
    expect(row && Number(row.chunk_count)).toBe(0);
  });

  it('builds byte-identical archives from identical inputs, and leaves no staging file', async () => {
    const total = (await build('probe2', 'topic', 1_000_000)).report.chunks;
    const target = Math.ceil(total / 3);
    const a = await build('det-a', 'semantic', target);
    const b = await build('det-b', 'semantic', target);
    expect(readFileSync(a.outputPath).equals(readFileSync(b.outputPath))).toBe(true);
    const work = await readdir(join(dir, 'work-det-a')).catch(() => [] as string[]);
    expect(work).not.toContain('staged-vectors.f32');
  });
});
