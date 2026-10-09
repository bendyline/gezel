/**
 * Format 0.8: a truncating, centered-sign profile and an audio asset push the
 * writer to the 0.8 generation; the reader opens it, validates it deeply,
 * searches it at the stored width, and refuses a query of the model's raw width.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from './archive/read.js';
import {
  type CompileReport,
  catalogFormatVersion,
  compileKnowledgeCatalog,
} from './compiler/compile.js';
import { profileUnitVector } from './format/quantize.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { CatalogQueryError } from './reader/open.js';
import { validateExtractedCatalog } from './reader/validate.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE_08,
  FIXTURE_TOPICS,
  FIXTURE_WAV,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from './test/fixture.js';

let dir: string;
let archivePath: string;
let report: CompileReport;
let handle: CatalogHandle;
const DOCS = generateFixtureCorpus(40, 7);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-08-'));
  archivePath = join(dir, 'fixture-08.gezk');
  report = await compileKnowledgeCatalog({
    catalog: {
      id: 'fixture-08',
      version: '1.0.0',
      name: 'Fixture 0.8',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of DOCS) yield doc;
    })(),
    outputPath: archivePath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE_08,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, 'work'),
    assets: [...FIXTURE_ASSETS, { path: 'assets/chime.wav', content: FIXTURE_WAV }],
  });
  const extracted = join(dir, 'extracted');
  await extractGezkVerified(archivePath, extracted);
  handle = CatalogHandle.open(extracted);
}, 120_000);

afterAll(async () => {
  handle?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('format 0.8', () => {
  it('writes the 0.8 generation with media counts', async () => {
    const manifest = await readGezkManifest(archivePath);
    expect(manifest.formatVersion).toBe('0.8');
    expect(manifest.indexSchemaVersion).toBe(5);
    expect(manifest.requires.formatVersion).toBe('0.8');
    expect(manifest.counts.media).toEqual({ image: 0, video: 0, audio: 0 });
    expect(manifest.embedding.truncation).toEqual({ method: 'prefix', sourceDimensions: 384 });
    expect(handle.schemaVersion).toBe(5);
    expect(report.manifest.counts.assets).toBe(2);
  });

  it('passes deep validation', async () => {
    const validation = await validateExtractedCatalog(join(dir, 'extracted'), { deep: true });
    expect(validation.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('searches with a query projected to the stored width', async () => {
    const doc = DOCS[3];
    if (!doc) throw new Error('fixture corpus too small');
    const [raw] = await fakeEmbed([doc.markdown.slice(0, 400)]);
    const query = profileUnitVector(FIXTURE_EMBEDDING_PROFILE_08, raw as number[]);
    expect(query.length).toBe(256);
    const hits = handle.searchSemantic(query, { finalK: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('refuses a query of the raw model width with a typed error', async () => {
    const [raw] = await fakeEmbed(['anything at all']);
    const wrong = Float32Array.from(raw as number[]);
    expect(() => handle.searchSemantic(wrong, { finalK: 5 })).toThrow(CatalogQueryError);
    try {
      handle.searchSemantic(wrong, { finalK: 5 });
    } catch (error) {
      expect((error as CatalogQueryError).reason).toBe('dimension');
    }
  });

  it('chooses the oldest generation that can express a catalog', () => {
    expect(catalogFormatVersion(FIXTURE_EMBEDDING_PROFILE, FIXTURE_ASSETS)).toBe('0.7');
    expect(catalogFormatVersion(FIXTURE_EMBEDDING_PROFILE_08, FIXTURE_ASSETS)).toBe('0.8');
    expect(catalogFormatVersion(FIXTURE_EMBEDDING_PROFILE, [{ path: 'assets/clip.mp4' }])).toBe(
      '0.8',
    );
  });
});
