/** Location round trips and retrieval constraints, including geographic edge cases. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CatalogDocument, locationDistanceMeters } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from './archive/read.js';
import { compileKnowledgeCatalog } from './compiler/compile.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  fakeCountTokens,
  fakeEmbed,
} from './test/fixture.js';

const point = (
  latitude: number,
  longitude: number,
  id = 'primary',
  role: 'subject' | 'associated' = 'subject',
) => ({ id, latitude, longitude, role });
const docs: CatalogDocument[] = Array.from({ length: 300 }, (_, i) => ({
  id: `doc-${String(i).padStart(3, '0')}`,
  title: `Museum ${i}`,
  slug: `museum-${i}`,
  language: 'en',
  topicPath: ['world'],
  markdown: `# Museum ${i}\n\nMuseum history and architecture.`,
  locations: [point(i === 299 ? 47.6062 : 0, i === 299 ? -122.3321 : 0)],
}));
docs.push(
  ...[
    { id: 'date-line', locations: [point(0, 180), point(0, 179.9, 'other')] },
    { id: 'pole', locations: [point(90, 180)] },
    { id: 'decimal', locations: [point(30.1, 50.2)] },
    { id: 'associated', locations: [point(47.6062, -122.3321, 'other', 'associated')] },
    { id: 'unknown', locations: [] },
  ].map((d) => ({
    ...d,
    title: d.id,
    slug: d.id,
    language: 'en',
    topicPath: ['world'],
    markdown: '# Article\n\nMuseum history.',
  })),
);
let dir: string;
let root: string;
let handle: CatalogHandle;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-spatial-'));
  root = join(dir, 'extracted');
  const outputPath = join(dir, 'spatial.gezk');
  await compileKnowledgeCatalog({
    catalog: {
      id: 'spatial',
      version: '1.0.0',
      name: 'Spatial',
      language: 'en',
      publisher: { id: 'test', name: 'Test' },
      createdAt: '2026-10-05T00:00:00Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: [{ id: 'world', name: 'World' }],
    documents: (async function* () {
      yield* docs;
    })(),
    outputPath,
    workDir: join(dir, 'build'),
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    shardTargetChunks: 50,
  });
  await extractGezkVerified(outputPath, root);
  handle = CatalogHandle.open(root);
}, 30_000);
afterAll(async () => {
  handle?.close();
  await rm(dir, { recursive: true, force: true });
});
describe('spatial catalogs', () => {
  it('round trips locations, normalizes 180, validates counts and coverage', async () => {
    expect(handle.getDocument('date-line')?.locations?.[0]?.longitude).toBe(179.9);
    expect(handle.documentLocations('date-line')[1]?.longitude).toBe(-180);
    expect((await validateExtractedCatalog(root, { deep: true })).ok).toBe(true);
  });
  it('deduplicates anchors, excludes associated and missing locations, counts before paging', () => {
    const result = handle.nearbyDocuments(
      { latitude: 47.6062, longitude: -122.3321, radiusMeters: 50_000 },
      { limit: 1 },
    );
    expect(result.total).toBe(1);
    expect(result.documents[0]?.id).toBe('doc-299');
    expect(result.documents[0]?.distanceMeters).toBe(0);
    expect(
      handle
        .nearbyDocuments({ latitude: 0, longitude: -180, radiusMeters: 50_000 })
        .documents.map((d) => d.id),
    ).toEqual(['date-line']);
    expect(handle.nearbyDocuments({ latitude: 90, longitude: 30, radiusMeters: 0 }).total).toBe(1);
    expect(
      handle.nearbyDocuments({ latitude: 30.1, longitude: 50.2, radiusMeters: 0 }).documents[0]?.id,
    ).toBe('decimal');
  });
  it('matches brute force over wrap, poles, zero and whole-world radii', () => {
    for (const radius of [
      { latitude: 0, longitude: 179.95, radiusMeters: 30_000 },
      { latitude: 90, longitude: -30, radiusMeters: 1_000 },
      { latitude: 0, longitude: 0, radiusMeters: 0 },
      { latitude: -90, longitude: 0, radiusMeters: 30_000_000 },
    ]) {
      const brute = docs
        .filter((d) =>
          d.locations?.some(
            (p) => p.role === 'subject' && locationDistanceMeters(radius, p) <= radius.radiusMeters,
          ),
        )
        .map((d) => d.id)
        .sort();
      expect([...handle.spatialMatches(radius).keys()].sort()).toEqual(brute);
    }
  });
  it('constrains title, chunk and semantic retrieval before all candidate limits', async () => {
    const allowed = new Set(
      handle
        .spatialMatches({ latitude: 47.6062, longitude: -122.3321, radiusMeters: 50_000 })
        .keys(),
    );
    expect(handle.searchDocumentsFts('Museum', 1, allowed).map((h) => h.documentId)).toEqual([
      'doc-299',
    ]);
    expect(
      handle
        .searchChunksFts(
          'Museum',
          handle.shards.map((s) => s.id),
          1,
          allowed,
        )
        .map((h) => h.documentId),
    ).toEqual(['doc-299']);
    const [vector] = await fakeEmbed(['Museum']);
    expect(
      handle
        .searchSemantic(Float32Array.from(vector!), {
          finalK: 1,
          shardBudget: 1,
          allowedDocumentIds: allowed,
        })
        .map((h) => h.documentId),
    ).toEqual(['doc-299']);
    expect(handle.searchDocumentsFts('Museum', 5, new Set())).toEqual([]);
  });
});
