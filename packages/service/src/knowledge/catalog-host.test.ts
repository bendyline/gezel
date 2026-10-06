/**
 * The catalog host's title-assisted routing: with the centroid budget spent
 * (here: zero), the vector arm still scans the shard of a page the question
 * names by title, and the extra shards stay within `titleRouteShards` across
 * every mounted catalog.
 *
 * Two single-shard fixture catalogs: "notes-a" holds Dovetail Joints and
 * Shellac; "notes-b" adds Dovetail Variant 1–3.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractGezkVerified } from '@bendyline/gezel-knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type KnowledgeCatalogHost, createInProcessCatalogHost } from './catalog-host.js';
import { buildTestCatalog, testHashVector } from './test-catalog-fixture.js';

let dir: string;
let host: KnowledgeCatalogHost;

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Float32Array.from(values.map((x) => x / norm));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-host-title-route-'));
  host = await createInProcessCatalogHost();
  for (const [id, variants] of [
    ['notes-a', 0],
    ['notes-b', 3],
  ] as const) {
    const outputPath = join(dir, `${id}.gezk`);
    await buildTestCatalog({
      outputPath,
      workDir: join(dir, `work-${id}`),
      id,
      dovetailVariants: variants,
    });
    const rootDir = join(dir, id);
    await extractGezkVerified(outputPath, rootDir);
    await host.mount({ key: `gezel-tests/${id}`, rootDir, catalogId: id, version: '1.0.0' });
  }
});

afterAll(async () => {
  await host?.dispose();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('catalog host — title-assisted routing', () => {
  const vector = unit(testHashVector('an unrelated question'));
  const search = (query: string, titleRouteShards?: number) =>
    host.search({
      vector,
      query,
      shardBudget: 0,
      finalK: 10,
      includeChunkFts: false,
      ...(titleRouteShards === undefined ? {} : { titleRouteShards }),
    });

  it('scans the shard of the page a question names, even with no centroid budget', async () => {
    const question = 'Who laid out Dovetail Variant 2?';
    expect((await search(question)).chunks).toEqual([]); // off by default
    const { chunks } = await search(question, 2);
    expect(chunks.map((c) => c.catalogId)).toContain('notes-b');
    expect(chunks.some((c) => c.title === 'Dovetail Variant 2')).toBe(true);
    expect(chunks.every((c) => c.catalogId === 'notes-b')).toBe(true);
  });

  it('adds nothing for a question that names no page', async () => {
    expect((await search('How do you keep a finish from cracking?', 2)).chunks).toEqual([]);
  });

  it('caps the extra shards across catalogs', async () => {
    // Both catalogs hold "Shellac", so each names a page; one extra shard only.
    const { chunks } = await search('Does Shellac suit Dovetail Variant 2?', 1);
    expect(new Set(chunks.map((c) => c.catalogId)).size).toBe(1);
    const both = await search('Does Shellac suit Dovetail Variant 2?', 2);
    expect(new Set(both.chunks.map((c) => c.catalogId))).toEqual(new Set(['notes-a', 'notes-b']));
  });
});
