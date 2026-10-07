/**
 * build-conformance — produce the gezk conformance kit from this
 * implementation: a small deterministic `.gezk` (signed with a TEST key)
 * plus `vectors.json`, the test vectors every implementation must
 * reproduce (chunk ids, quantization, canonical JSON, references,
 * signatures, the hamming scan, and an end-to-end retrieval probe).
 *
 * Written twice, byte-identical: into the sibling bendyline/gezk checkout
 * (what other implementations test against) and into this package's
 * `conformance/` directory (what `src/conformance.test.ts` holds this
 * implementation to). One generator, so the two copies cannot drift.
 *
 * Usage: pnpm --filter @bendyline/gezel-knowledge build-conformance
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEZK_FORMAT_VERSION,
  type KnowledgeEmbeddingProfile,
  canonicalizeJson,
  formatKnowledgeUri,
  locationDistanceMeters,
  parseKnowledgeUri,
  profileUnitVector,
  quantizeBinary,
  quantizeBinaryForProfile,
  quantizeInt8,
} from '@bendyline/gezk';
import { chunkContentHash, chunkUid, knowledgeKeyId, signManifest } from '@bendyline/gezk/node';
import { requireGezkCheckout } from '../../gezk/scripts/gezk-checkout.js';
import { extractGezkVerified } from '../src/archive/read.js';
import { compileKnowledgeCatalog } from '../src/compiler/compile.js';
import { type ShardBitIndex, asymmetricTopK, hammingTopK } from '../src/reader/bit-scan.js';
import { CatalogHandle } from '../src/reader/catalog-handle.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_ASSET_DOCUMENT_ID,
  FIXTURE_ASSET_PATH,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE_08,
  FIXTURE_MP4,
  FIXTURE_TOPICS,
  FIXTURE_WAV,
  fakeCountTokens,
  fakeEmbed,
  fakeEmbedMedia,
  fixtureMeta,
  generateFixtureCorpus,
} from '../src/test/fixture.js';

/** TEST-ONLY signing key: committed so the signed fixture is reproducible. Never sign a release with it. */
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIO/e3tleMhtvZagRG8vQI63BwnQU4BClrWi2dHwWvesM
-----END PRIVATE KEY-----
`;
const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjEGBSH8XNNyYVwtWJ8NaHPkmQ0tlJdpl8BwgtIlxsc4=
-----END PUBLIC KEY-----
`;

const FIXTURE_NAME = `conformance-${GEZK_FORMAT_VERSION}.gezk`;
const DOCS = generateFixtureCorpus(40, 7);
DOCS[0]!.locations = [
  {
    id: 'seattle',
    latitude: 47.6062,
    longitude: -122.3321,
    role: 'subject',
    provenance: { source: 'synthetic' },
  },
];
DOCS[1]!.locations = [
  { id: 'date-line', latitude: 0, longitude: 180, role: 'subject' },
  { id: 'neighbor', latitude: 0, longitude: 179.9, role: 'subject' },
];
DOCS[2]!.locations = [{ id: 'pole', latitude: 90, longitude: 0, role: 'subject' }];
DOCS[3]!.locations = [
  { id: 'mentioned-seattle', latitude: 47.6062, longitude: -122.3321, role: 'associated' },
];
DOCS[4]!.locations = [{ id: 'decimal', latitude: 30.1, longitude: 50.2, role: 'subject' }];
// 0.8 media rows: doc-0004 references an audio clip and a video; doc-0001
// already references the image asset.
const MEDIA_DOCUMENT_ID = 'doc-0004';
const mediaDocument = DOCS.find((doc) => doc.id === MEDIA_DOCUMENT_ID);
if (!mediaDocument) throw new Error('Missing media fixture document');
mediaDocument.markdown +=
  '\n\n## Sounds\n\nThe workshop bell. ![Brass chime ringing](assets/chime.wav)\n\n![Lathe at speed](assets/clip.mp4)\n';
const CONFORMANCE_ASSETS = [
  ...FIXTURE_ASSETS,
  { path: 'assets/chime.wav', content: FIXTURE_WAV, attribution: { license: 'CC0-1.0' } },
  { path: 'assets/clip.mp4', content: FIXTURE_MP4 },
];
const SHARED_DOCUMENT_ID = 'doc-0000';
const sharedDocument = DOCS.find((doc) => doc.id === SHARED_DOCUMENT_ID);
if (!sharedDocument) throw new Error('Missing shared fixture document');
sharedDocument.tocReferences = [
  { topicPath: ['nature'], ordinal: -5 },
  { topicPath: ['craft', 'metals'], ordinal: -4 },
];

interface LegacyFixture {
  formatVersion: string;
  [key: string]: unknown;
}

/**
 * The previous kit's fixture block becomes a legacy entry when the format
 * version moved; entries already carried stay as they are. Without this,
 * regenerating the kit would erase the only proof that older catalogs open.
 */
function carryLegacy(previousVectorsPath: string): LegacyFixture[] {
  if (!existsSync(previousVectorsPath)) return [];
  const previous = JSON.parse(readFileSync(previousVectorsPath, 'utf8')) as {
    formatVersion?: string;
    fixture?: Record<string, unknown>;
    legacy?: LegacyFixture[];
  };
  const carried = [...(previous.legacy ?? [])];
  if (
    previous.formatVersion &&
    previous.formatVersion !== GEZK_FORMAT_VERSION &&
    previous.fixture &&
    !carried.some((entry) => entry.formatVersion === previous.formatVersion)
  ) {
    carried.push({ formatVersion: previous.formatVersion, ...previous.fixture });
  }
  return carried.sort((a, b) => (a.formatVersion < b.formatVersion ? -1 : 1));
}

async function main(): Promise<void> {
  const gezkRoot = process.argv.includes('--local') ? null : requireGezkCheckout();
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const work = mkdtempSync(join(tmpdir(), 'gezk-conformance-'));
  try {
    const archivePath = join(work, FIXTURE_NAME);
    const report = await compileKnowledgeCatalog({
      catalog: {
        id: 'conformance',
        version: `${GEZK_FORMAT_VERSION}.0`,
        name: 'gezk conformance fixture',
        description: 'A tiny synthetic corpus every gezk implementation must read identically.',
        language: 'en',
        publisher: { id: 'bendyline', name: 'Bendyline', url: 'https://github.com/bendyline/gezk' },
        createdAt: '2026-09-01T00:00:00.000Z',
        license: { name: 'MIT', spdx: 'MIT', attributionRequired: false },
      },
      topics: FIXTURE_TOPICS,
      documents: (async function* () {
        for (const doc of DOCS) yield doc;
      })(),
      outputPath: archivePath,
      // The 0.8 profile (truncation + centered sign bits) is what makes the
      // writer emit the 0.8 generation this kit describes.
      embeddingProfile: FIXTURE_EMBEDDING_PROFILE_08,
      chunkingProfile: FIXTURE_CHUNKING_PROFILE,
      embed: fakeEmbed,
      embedMedia: fakeEmbedMedia,
      countTokens: fakeCountTokens,
      workDir: join(work, 'build'),
      assets: CONFORMANCE_ASSETS,
      smokeQueries: DOCS.slice(0, 6).map((doc) => ({
        query: doc.title,
        expectedDocumentIds: [doc.id],
      })),
      smokeQueryPolicy: 'select',
      finalizeManifest: (manifest) => signManifest(manifest, TEST_PRIVATE_KEY_PEM),
    });

    const extracted = join(work, 'extracted');
    await extractGezkVerified(archivePath, extracted);
    const handle = CatalogHandle.open(extracted);
    let probe: { chunkUid: string; embedInput: string; documentId: string };
    let topicsSnapshot: ReturnType<CatalogHandle['topics']> = [];
    let orderedListing: string[] = [];
    let assetsSnapshot: ReturnType<CatalogHandle['assets']> = [];
    try {
      const doc = DOCS[3];
      if (!doc) throw new Error('fixture corpus too small');
      const hit = handle.searchChunksFts(doc.title, [0], 3)[0];
      if (!hit) throw new Error('no chunk hit for the probe document');
      const header =
        hit.headingPath.length > 0
          ? `${hit.title}\n${hit.headingPath.join(' > ')}\n`
          : `${hit.title}\n`;
      probe = { chunkUid: hit.chunkUid, embedInput: `${header}${hit.text}`, documentId: doc.id };
      topicsSnapshot = handle.topics();
      orderedListing = handle
        .documentsPage({ topicId: 'nature', limit: 5 })
        .documents.map((d) => d.id);
      assetsSnapshot = handle.assets();
    } finally {
      handle.close();
    }

    const archiveBytes = readFileSync(archivePath);
    const bits: ShardBitIndex = {
      bits: Uint8Array.from([
        0b00000000, 0b11111111, 0b10101010, 0b00001111, 0b11110000, 0b00000001, 0b10000000,
        0b01010101,
      ]),
      bytesPerRow: 2,
      rows: 4,
    };
    const hammingQuery = Uint8Array.from([0b00000001, 0b11111111]);
    const truncationProfile = (dimensions: number, sourceDimensions: number) =>
      ({
        ...FIXTURE_EMBEDDING_PROFILE_08,
        dimensions,
        truncation: { method: 'prefix', sourceDimensions },
        quantization: {
          int8: { method: 'symmetric-linear', scale: 127 },
          binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
        },
      }) satisfies KnowledgeEmbeddingProfile;
    const { truncation: _truncation, ...untruncated } = FIXTURE_EMBEDDING_PROFILE_08;
    const centeredProfile = (center: number[]) =>
      ({
        ...untruncated,
        dimensions: center.length,
        quantization: {
          int8: { method: 'symmetric-linear', scale: 127 },
          binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center },
        },
      }) satisfies KnowledgeEmbeddingProfile;
    const asymmetricQuery = [
      0.5, -0.25, 0.125, 0, -0.5, 0.75, -0.125, 0.25, 0.1, -0.2, 0.3, -0.4, 0, 0, 0.05, -0.05,
    ];

    const vectors = {
      formatVersion: GEZK_FORMAT_VERSION,
      spatial: {
        distance: [
          { from: { latitude: 0, longitude: 0 }, to: { latitude: 0, longitude: 1 } },
          { from: { latitude: 90, longitude: 0 }, to: { latitude: 90, longitude: 180 } },
          { from: { latitude: 0, longitude: 180 }, to: { latitude: 0, longitude: -180 } },
        ].map((v) => ({ ...v, expectedMeters: locationDistanceMeters(v.from, v.to) })),
        nearby: [
          {
            radius: { latitude: 47.6062, longitude: -122.3321, radiusMeters: 50_000 },
            expectedDocumentIds: ['doc-0000'],
          },
          {
            radius: { latitude: 0, longitude: -180, radiusMeters: 50_000 },
            expectedDocumentIds: ['doc-0001'],
          },
          {
            radius: { latitude: 90, longitude: 170, radiusMeters: 0 },
            expectedDocumentIds: ['doc-0002'],
          },
          {
            radius: { latitude: 30.1, longitude: 50.2, radiusMeters: 0 },
            expectedDocumentIds: ['doc-0004'],
          },
        ],
      },
      hashEmbedder: {
        id: FIXTURE_EMBEDDING_PROFILE_08.id,
        description:
          'A deterministic stand-in for a model: SHA-256 of the UTF-8 text, extended by re-hashing the previous digest, each byte read as a signed int8 and mapped to (b + 0.5) / 128, giving 384 values. The fixture profile truncates: keep the first 256, then L2-normalize.',
        dimensions: 384,
        storedDimensions: FIXTURE_EMBEDDING_PROFILE_08.dimensions,
        sample: {
          text: probe.embedInput,
          unitVector: Array.from(
            profileUnitVector(
              FIXTURE_EMBEDDING_PROFILE_08,
              (await fakeEmbed([probe.embedInput]))[0] as number[],
            ),
          ).slice(0, 8),
        },
      },
      // 0.8: Matryoshka truncation — keep the prefix, normalize again.
      truncation: [
        { dimensions: 2, sourceDimensions: 4, input: [3, 4, 12, 84] },
        { dimensions: 3, sourceDimensions: 6, input: [1, 2, 2, 9, -9, 9] },
      ].map((c) => ({
        ...c,
        expected: Array.from(
          profileUnitVector(truncationProfile(c.dimensions, c.sourceDimensions), c.input),
        ),
      })),
      // centered-sign: bits of (unit vector − center); int8 is never centered.
      centeredBits: [
        {
          input: [0.5, -0.5, 0.1, -0.1, 0.3, 0.2, -0.2, 0.05],
          center: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
        },
      ].map((c) => ({
        ...c,
        bits: Array.from(quantizeBinaryForProfile(centeredProfile(c.center), c.input)),
        int8: Array.from(quantizeInt8(c.input)),
      })),
      // The stage-1 scan readers run: score = sum of query[d] * (bit ? +1 : -1).
      asymmetric: {
        rows: Array.from(bits.bits),
        bytesPerRow: bits.bytesPerRow,
        query: asymmetricQuery,
        k: 3,
        expected: asymmetricTopK(bits, asymmetricQuery, 3),
      },
      chunkUid: [
        {
          documentId: 'doc-0001',
          ordinal: 0,
          text: 'Hello, world.',
          expected: chunkUid('doc-0001', 0, 'Hello, world.'),
        },
        {
          documentId: 'Mechanics/Newton laws',
          ordinal: 12,
          text: 'Force equals mass times acceleration.',
          expected: chunkUid('Mechanics/Newton laws', 12, 'Force equals mass times acceleration.'),
        },
        {
          documentId: 'ünïcode',
          ordinal: 3,
          text: 'Zwölf Boxkämpfer',
          expected: chunkUid('ünïcode', 3, 'Zwölf Boxkämpfer'),
        },
      ],
      contentHash: [{ text: 'Hello, world.', expected: chunkContentHash('Hello, world.') }],
      quantization: [
        { input: [1, -1, 0.5, -0.5, 0, 0.0039, -0.0039, 2] },
        { input: [0.1, 0, -0.1, 0.2, 0, 0, 0, 0.3, 0.4] },
      ].map((c) => ({
        ...c,
        int8: Array.from(quantizeInt8(c.input)),
        bits: Array.from(quantizeBinary(c.input)),
      })),
      jcs: [
        {
          input: { b: 1, a: [true, null, 'x'], ä: 2 },
          canonical: canonicalizeJson({ b: 1, a: [true, null, 'x'], ä: 2 }),
        },
        {
          input: { n: 1e21, m: 0.000001, k: 10, s: 'quo"te\\n' },
          canonical: canonicalizeJson({ n: 1e21, m: 0.000001, k: 10, s: 'quo"te\\n' }),
        },
        {
          input: { a: 0, A: 0, '1': 0, '<': 0 },
          canonical: canonicalizeJson({ a: 0, A: 0, '1': 0, '<': 0 }),
        },
      ],
      uri: [
        `knowledge://bendyline/wikipedia-physics/Mechanics/Newton%20laws#chunk=${'a'.repeat(32)}`,
        'knowledge://me/notes/readme#line=12-40',
        'knowledge://me/notes/readme',
        'knowledge://notes/doc',
        'knowledge://Bad_Publisher/notes/doc',
        'knowledge://me/notes/doc#page=3',
      ].map((raw) => ({ uri: raw, parsed: parseKnowledgeUri(raw) })),
      uriFormat: {
        input: {
          publisherId: 'bendyline',
          catalogId: 'wikipedia-physics',
          documentId: 'Mechanics/Newton laws',
          fragment: { chunk: 'b'.repeat(32) },
        },
        expected: formatKnowledgeUri({
          publisherId: 'bendyline',
          catalogId: 'wikipedia-physics',
          documentId: 'Mechanics/Newton laws',
          fragment: { chunk: 'b'.repeat(32) },
        }),
      },
      hamming: {
        rows: Array.from(bits.bits),
        bytesPerRow: bits.bytesPerRow,
        query: Array.from(hammingQuery),
        k: 3,
        expected: hammingTopK(bits, hammingQuery, 3),
      },
      signature: {
        publicKeyPem: TEST_PUBLIC_KEY_PEM,
        keyId: knowledgeKeyId(TEST_PUBLIC_KEY_PEM),
        manifestSignatureKeyId: report.manifest.signature?.keyId,
        tamperedField: 'name',
      },
      fixture: {
        path: `fixtures/${FIXTURE_NAME}`,
        sha256: createHash('sha256').update(archiveBytes).digest('hex'),
        sizeBytes: archiveBytes.length,
        catalogId: report.manifest.id,
        version: report.manifest.version,
        publisherId: report.manifest.publisher.id,
        documents: report.documents,
        chunks: report.chunks,
        shards: report.shards,
        ftsQueries: DOCS.slice(0, 3).map((doc) => ({
          query: doc.title,
          expectedDocumentId: doc.id,
        })),
        semanticProbe: probe,
        documentRoundTrip: {
          documentId: 'doc-0001',
          markdownSha256: createHash('sha256')
            .update(
              (DOCS.find((d) => d.id === 'doc-0001')?.markdown ?? '')
                .replace(/\r\n/g, '\n')
                .normalize('NFC'),
              'utf8',
            )
            .digest('hex'),
        },
        // 0.7: one canonical document shared across topics and an ancestor.
        sharedToc: {
          documentId: SHARED_DOCUMENT_ID,
          primaryTopicId: 'craft',
          referenceTopicIds: ['nature', 'metals'],
        },
        // 0.6: leaf filing with reader rollup, ordinals, metadata, assets.
        nestedTopic: (() => {
          const metals = topicsSnapshot.find((t) => t.id === 'metals');
          const craft = topicsSnapshot.find((t) => t.id === 'craft');
          if (!metals || !craft) throw new Error('fixture topics missing');
          return {
            id: metals.id,
            parentId: metals.parentId,
            directDocuments: metals.documentCount,
            parentDirectDocuments: craft.documentCount,
            parentTotalDocuments: craft.totalDocumentCount,
          };
        })(),
        orderedListing: { topicId: 'nature', firstDocumentIds: orderedListing },
        metaSample: { documentId: 'doc-0007', meta: fixtureMeta(7) },
        assets: assetsSnapshot.map((a) => ({
          path: a.path,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          sha256: a.sha256,
        })),
        assetDocument: { documentId: FIXTURE_ASSET_DOCUMENT_ID, path: FIXTURE_ASSET_PATH },
        // 0.8: media rows by modality, and one probe the media lane must
        // answer: the audio clip's first window, embedded with `fakeEmbedMedia`.
        media: report.manifest.counts.media,
        mediaProbe: {
          modality: 'audio',
          assetPath: 'assets/chime.wav',
          embedInput: `media:audio:${createHash('sha256').update(FIXTURE_WAV).digest('hex')}:0`,
          documentId: MEDIA_DOCUMENT_ID,
          startMs: 0,
          endMs: 1000,
        },
      },
      // Earlier generations' fixtures and their expectations, carried forward
      // from the previous kit so a reader proves it still opens them.
      legacy: carryLegacy(join(packageRoot, 'conformance', 'vectors.json')),
    };

    const readme = `# gezk ${GEZK_FORMAT_VERSION} conformance kit

Generated by \`pnpm --filter @bendyline/gezel-knowledge build-conformance\` in
the gezel repository from the reference TypeScript implementation — do not
edit by hand. An implementation conforms when it reproduces every entry in
\`vectors.json\` and reads \`fixtures/${FIXTURE_NAME}\` as described there:

- \`chunkUid\` / \`contentHash\` — the content-derived ids.
- \`quantization\` — int8 and sign-bit encodings, including the rounding rule
  (round half toward positive infinity).
- \`jcs\` — RFC 8785 canonical JSON, the signature input.
- \`uri\` / \`uriFormat\` — \`knowledge://\` parsing and formatting.
- \`hamming\` — the stage-1 top-K selection over sign-bit rows.
- \`asymmetric\` — the stage-1 scan readers run: a float query scored against
  sign bits (+1 / −1 per dimension).
- \`truncation\` (0.8) — Matryoshka truncation: keep the first \`dimensions\`
  values of the model output, then L2-normalize.
- \`centeredBits\` — \`centered-sign\` bits, taken from \`vector − center\`;
  the int8 encoding of the same vector is never centered.
- \`fixture.media\` / \`fixture.mediaProbe\` (0.8) — media rows: an image, an
  audio clip and a video, two one-second windows each for the latter, embedded
  with the hash embedder over \`media:<modality>:<asset sha256>[:<startMs>]\`.
  The probe's vector must find its window first by an exact media scan.
- \`signature\` — the fixture manifest verifies under the TEST public key and
  fails once the named field is tampered with.
- \`fixture\` — archive digest, counts, full-text queries, a document body
  round trip, a two-stage semantic probe embedded with the documented hash
  embedder, and (0.6) the nested topic's rollup, an ordinal-first listing,
  a metadata sample, and the shipped asset; (0.7) shared TOC placements without\n  duplicated canonical documents; (0.8) a truncating profile (384 → 256) with\n  centered sign bits, so the probe must be projected before it is searched.
- \`spatial\` — spherical-distance probes and radius results for multiple subject\n  anchors, associated places, date-line and pole coordinates.\n- \`legacy\` — the same fixture facts for every earlier generation whose
  archive still ships under \`fixtures/\`; a reader for this version reads
  those too.

The fixture is signed with a TEST key whose private half is published in
the generator; it proves signature handling, never provenance.
`;

    const outputs = [
      ...(gezkRoot ? [join(gezkRoot, 'conformance')] : []),
      join(packageRoot, 'conformance'),
    ];
    for (const out of outputs) {
      // Never wipe: earlier generations' fixtures stay beside the current one.
      mkdirSync(join(out, 'fixtures'), { recursive: true });
      cpSync(archivePath, join(out, 'fixtures', FIXTURE_NAME));
      writeFileSync(join(out, 'vectors.json'), `${JSON.stringify(vectors, null, 2)}\n`);
      writeFileSync(join(out, 'README.md'), readme);
      console.log(`[conformance] wrote ${out}`);
    }
    console.log(
      `[conformance] fixture ${FIXTURE_NAME}: ${report.documents} documents, ${report.chunks} chunks, ${archiveBytes.length} bytes`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
