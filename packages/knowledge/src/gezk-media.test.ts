/**
 * Format 0.8 media rows: a catalog whose documents reference an image, an
 * audio clip and a video gets one row per image and one per window, after the
 * text; text chunk ids are the ones a text-only build gives; the reader's
 * media lane finds the rows, FTS reaches their captions, and the validator
 * accepts the catalog deeply.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from './archive/read.js';
import { type CompileReport, compileKnowledgeCatalog } from './compiler/compile.js';
import { humanizeAssetName, mediaReferences } from './compiler/media-rows.js';
import { profileUnitVector } from './format/quantize.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_ASSET_DOCUMENT_ID,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE_08,
  FIXTURE_MP4,
  FIXTURE_TOPICS,
  FIXTURE_WAV,
  fakeCountTokens,
  fakeEmbed,
  fakeEmbedMedia,
  generateFixtureCorpus,
} from './test/fixture.js';

let dir: string;
let withMedia: CompileReport;
let textOnly: CompileReport;
let handle: CatalogHandle;
let plainHandle: CatalogHandle;

const MEDIA_DOCUMENT_ID = 'doc-0002';
const ASSETS = [
  ...FIXTURE_ASSETS,
  {
    path: 'assets/chime.wav',
    content: FIXTURE_WAV,
    attribution: { license: 'CC0-1.0', author: 'Gezel Tests' },
  },
  { path: 'assets/clip.mp4', content: FIXTURE_MP4 },
];

function documents(): CatalogDocument[] {
  const docs = generateFixtureCorpus(20, 11);
  const media = docs.find((d) => d.id === MEDIA_DOCUMENT_ID);
  if (!media) throw new Error('fixture corpus lacks the media document');
  media.markdown +=
    '\n\n## Sounds\n\nThe workshop bell. ![Brass chime ringing](assets/chime.wav)\n\n![](assets/clip.mp4)\n';
  return docs;
}

async function build(name: string, embedMedia?: typeof fakeEmbedMedia): Promise<CompileReport> {
  return compileKnowledgeCatalog({
    catalog: {
      id: name,
      version: '1.0.0',
      name,
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of documents()) yield doc;
    })(),
    outputPath: join(dir, `${name}.gezk`),
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE_08,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, `work-${name}`),
    assets: ASSETS,
    ...(embedMedia ? { embedMedia } : {}),
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-media-'));
  withMedia = await build('media', fakeEmbedMedia);
  textOnly = await build('plain');
  await extractGezkVerified(join(dir, 'media.gezk'), join(dir, 'media'));
  await extractGezkVerified(join(dir, 'plain.gezk'), join(dir, 'plain'));
  handle = CatalogHandle.open(join(dir, 'media'));
  plainHandle = CatalogHandle.open(join(dir, 'plain'));
}, 120_000);

afterAll(async () => {
  handle?.close();
  plainHandle?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('media references', () => {
  it('finds image-syntax references with their line and caption text', () => {
    const refs = mediaReferences(
      '# T\n\nA bell ![Chime](assets/chime.wav "title") rings.\n![](assets/a.png)',
    );
    expect(refs).toEqual([
      { alt: 'Chime', path: 'assets/chime.wav', line: 3, caption: 'A bell rings.' },
      { alt: '', path: 'assets/a.png', line: 4, caption: '' },
    ]);
    expect(humanizeAssetName('assets/diagrams/red-panda_habitat.png')).toBe('red panda habitat');
  });
});

describe('format 0.8 media rows', () => {
  it('counts one row per image and one per window, inside counts.chunks', async () => {
    expect(withMedia.media).toEqual({ image: 1, video: 2, audio: 2 });
    const manifest = await readGezkManifest(join(dir, 'media.gezk'));
    expect(manifest.counts.media).toEqual({ image: 1, video: 2, audio: 2 });
    expect(manifest.counts.chunks).toBe(textOnly.chunks + 5);
    expect(handle.mediaCounts()).toEqual({ image: 1, video: 2, audio: 2 });
  });

  it('passes deep validation', async () => {
    const report = await validateExtractedCatalog(join(dir, 'media'), { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('leaves every text chunk id as a text-only build has it', () => {
    const page = (h: CatalogHandle, id: string) =>
      h
        .searchChunksFts(id === MEDIA_DOCUMENT_ID ? 'workshop bell' : 'the', [0], 50)
        .map((c) => c.chunkUid);
    const plain = new Set(page(plainHandle, MEDIA_DOCUMENT_ID));
    const media = page(handle, MEDIA_DOCUMENT_ID).filter((uid) => plain.has(uid));
    expect(media.length).toBe(plain.size);
  });

  it('finds a media row through the media lane, with its asset, window and attribution', async () => {
    const [raw] = await fakeEmbedMedia({ modality: 'audio', bytes: FIXTURE_WAV });
    const query = profileUnitVector(FIXTURE_EMBEDDING_PROFILE_08, raw?.vector ?? []);
    const hits = handle.searchMedia(query, { perModality: 2 });
    const top = hits[0];
    expect(top?.documentId).toBe(MEDIA_DOCUMENT_ID);
    expect(top?.media).toMatchObject({
      modality: 'audio',
      assetPath: 'assets/chime.wav',
      mimeType: 'audio/wav',
      startMs: 0,
      endMs: 1000,
      attribution: { license: 'CC0-1.0', author: 'Gezel Tests' },
    });
    expect(top?.cosine).toBeGreaterThan(0.99);
    expect(top?.headingPath.at(-1)).toBe('Sounds');
    expect(new Set(hits.map((h) => h.media?.modality))).toEqual(
      new Set(['image', 'video', 'audio']),
    );
  });

  it('keeps media rows out of the text lane', async () => {
    const [raw] = await fakeEmbedMedia({ modality: 'audio', bytes: FIXTURE_WAV });
    const query = profileUnitVector(FIXTURE_EMBEDDING_PROFILE_08, raw?.vector ?? []);
    expect(handle.searchSemantic(query, { finalK: 24 }).some((h) => h.media)).toBe(false);
  });

  it('reaches a media row by its caption through chunk FTS', () => {
    const hits = handle.searchChunksFts('brass chime', [0], 10);
    expect(hits.some((h) => h.media?.assetPath === 'assets/chime.wav')).toBe(true);
    const image = handle
      .searchChunksFts('mark', [0], 20)
      .find((h) => h.media?.modality === 'image');
    expect(image?.documentId).toBe(FIXTURE_ASSET_DOCUMENT_ID);
  });
});
