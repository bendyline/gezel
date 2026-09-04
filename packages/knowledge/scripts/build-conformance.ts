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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEZK_FORMAT_VERSION,
  canonicalizeJson,
  formatKnowledgeUri,
  l2Normalize,
  parseKnowledgeUri,
  quantizeBinary,
  quantizeInt8,
} from '@bendyline/gezk';
import { chunkContentHash, chunkUid, knowledgeKeyId, signManifest } from '@bendyline/gezk/node';
import { requireGezkCheckout } from '../../gezk/scripts/gezk-checkout.js';
import { extractGezkVerified } from '../src/archive/read.js';
import { compileKnowledgeCatalog } from '../src/compiler/compile.js';
import { type ShardBitIndex, hammingTopK } from '../src/reader/bit-scan.js';
import { CatalogHandle } from '../src/reader/catalog-handle.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
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

async function main(): Promise<void> {
  const gezkRoot = requireGezkCheckout();
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const work = mkdtempSync(join(tmpdir(), 'gezk-conformance-'));
  try {
    const archivePath = join(work, FIXTURE_NAME);
    const report = await compileKnowledgeCatalog({
      catalog: {
        id: 'conformance',
        version: '0.5.0',
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
      embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
      chunkingProfile: FIXTURE_CHUNKING_PROFILE,
      embed: fakeEmbed,
      countTokens: fakeCountTokens,
      workDir: join(work, 'build'),
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

    const vectors = {
      formatVersion: GEZK_FORMAT_VERSION,
      hashEmbedder: {
        id: FIXTURE_EMBEDDING_PROFILE.id,
        description:
          'A deterministic stand-in for a model: SHA-256 of the UTF-8 text, extended by re-hashing the previous digest, each byte read as a signed int8 and mapped to (b + 0.5) / 128; the compiler L2-normalizes the result.',
        dimensions: 384,
        sample: {
          text: probe.embedInput,
          unitVector: Array.from(
            l2Normalize((await fakeEmbed([probe.embedInput]))[0] as number[]),
          ).slice(0, 8),
        },
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
      },
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
- \`signature\` — the fixture manifest verifies under the TEST public key and
  fails once the named field is tampered with.
- \`fixture\` — archive digest, counts, full-text queries, a document body
  round trip, and a two-stage semantic probe embedded with the documented
  hash embedder.

The fixture is signed with a TEST key whose private half is published in
the generator; it proves signature handling, never provenance.
`;

    const outputs = [join(gezkRoot, 'conformance'), join(packageRoot, 'conformance')];
    for (const out of outputs) {
      rmSync(out, { recursive: true, force: true });
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
