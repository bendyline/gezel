/**
 * Title-assisted routing: the shard holding a page the query names by title
 * is scanned even when centroid routing spends the budget elsewhere.
 *
 * The fixture corpus is compiled into four shards. The query vector is one
 * shard's own route centroid with a budget of one, so centroid routing picks
 * that shard alone; a question naming a document stored elsewhere must add
 * that document's shard, and a question naming nothing must add none.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from '../archive/read.js';
import { compileKnowledgeCatalog } from '../compiler/compile.js';
import { DatabaseSync } from '../format/node-sqlite.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from '../test/fixture.js';
import { CatalogHandle } from './catalog-handle.js';

let dir: string;
let extracted: string;
const DOCS: CatalogDocument[] = generateFixtureCorpus(60, 5);

async function compile(name: string, shardTargetChunks: number) {
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
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, `work-${name}`),
    assets: FIXTURE_ASSETS,
    shardTargetChunks,
  });
  return { report, outputPath };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-title-route-'));
  const total = (await compile('probe', 1_000_000)).report.chunks;
  const { outputPath } = await compile('sharded', Math.ceil(total / 4));
  extracted = join(dir, 'x');
  await extractGezkVerified(outputPath, extracted);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function routerRows() {
  const router = new DatabaseSync(join(extracted, 'index', 'router.db'));
  const docs = router.prepare('SELECT id, title, shard_id FROM documents').all() as Array<{
    id: string;
    title: string;
    shard_id: number | bigint;
  }>;
  const centroids = router
    .prepare('SELECT shard_id, embedding FROM route_centroids ORDER BY shard_id, rowid')
    .all() as Array<{ shard_id: number | bigint; embedding: Uint8Array }>;
  router.close();
  return { docs, centroids };
}

describe('title-assisted routing', () => {
  it('adds the shard of the page a question names, and nothing for a question naming none', () => {
    const { docs, centroids } = routerRows();
    const handle = CatalogHandle.open(extracted);
    try {
      expect(handle.shards.length).toBeGreaterThanOrEqual(3);
      const first = centroids[0];
      if (!first) throw new Error('fixture has no route centroids');
      const vector = new Float32Array(Uint8Array.from(first.embedding).buffer);
      const base = handle.routeShards(vector, 1);
      expect(base).toHaveLength(1);

      const named = docs.find((d) => Number(d.shard_id) !== base[0]);
      if (!named) throw new Error('every fixture document landed in the routed shard');
      const question = `Who wrote ${named.title}?`;

      expect(handle.titleRouteShards(question, 1)).toEqual([
        { shardId: Number(named.shard_id), score: expect.any(Number) },
      ]);
      expect(handle.routeShards(vector, 1, question)).toEqual([...base, Number(named.shard_id)]);
      expect(handle.routeShards(vector, 1, 'Who wrote it?')).toEqual(base);

      const shardsOf = (hits: Array<{ shardId?: number }>) => new Set(hits.map((h) => h.shardId));
      expect(
        shardsOf(handle.searchSemantic(vector, { shardBudget: 1, finalK: 200 })).has(
          Number(named.shard_id),
        ),
      ).toBe(false);
      const assisted = handle.searchSemantic(vector, {
        shardBudget: 1,
        finalK: 200,
        query: question,
      });
      expect(shardsOf(assisted).has(Number(named.shard_id))).toBe(true);
      expect(assisted.some((h) => h.documentId === named.id)).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('never exceeds its limit and never repeats a shard', () => {
    const { docs } = routerRows();
    const handle = CatalogHandle.open(extracted);
    try {
      // Naming three documents at once can add at most `limit` distinct shards.
      const question = `Compare ${docs
        .slice(0, 3)
        .map((d) => d.title)
        .join(', ')}`;
      for (const limit of [0, 1, 2]) {
        const shards = handle.titleRouteShards(question, limit).map((s) => s.shardId);
        expect(shards.length).toBeLessThanOrEqual(limit);
        expect(new Set(shards).size).toBe(shards.length);
      }
    } finally {
      handle.close();
    }
  });
});
