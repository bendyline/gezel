/**
 * Holds this implementation to the gezk conformance kit it generates
 * (`scripts/build-conformance.ts` → `conformance/`), the same kit other
 * implementations test against from the bendyline/gezk repository. If a
 * change here alters a vector, the kit must be regenerated deliberately and
 * the spec updated — silent drift between implementations is the failure
 * this file exists to catch.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type KnowledgeCatalogManifest,
  canonicalizeJson,
  formatKnowledgeUri,
  parseKnowledgeUri,
  quantizeBinary,
  quantizeInt8,
} from '@bendyline/gezk';
import { chunkContentHash, chunkUid, verifyManifestSignature } from '@bendyline/gezk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from './archive/read.js';
import { hammingTopK } from './reader/bit-scan.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import { fakeEmbed } from './test/fixture.js';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'conformance');

interface Vectors {
  formatVersion: string;
  chunkUid: Array<{ documentId: string; ordinal: number; text: string; expected: string }>;
  contentHash: Array<{ text: string; expected: string }>;
  quantization: Array<{ input: number[]; int8: number[]; bits: number[] }>;
  jcs: Array<{ input: unknown; canonical: string }>;
  uri: Array<{ uri: string; parsed: ReturnType<typeof parseKnowledgeUri> }>;
  uriFormat: { input: Parameters<typeof formatKnowledgeUri>[0]; expected: string };
  hamming: {
    rows: number[];
    bytesPerRow: number;
    query: number[];
    k: number;
    expected: Array<{ chunkId: number; distance: number }>;
  };
  signature: { publicKeyPem: string; keyId: string; tamperedField: string };
  fixture: {
    path: string;
    sha256: string;
    sizeBytes: number;
    catalogId: string;
    version: string;
    publisherId: string;
    documents: number;
    chunks: number;
    shards: number;
    ftsQueries: Array<{ query: string; expectedDocumentId: string }>;
    semanticProbe: { chunkUid: string; embedInput: string; documentId: string };
    documentRoundTrip: { documentId: string; markdownSha256: string };
  };
}

let vectors: Vectors;
let archivePath: string;
let dir: string;

beforeAll(async () => {
  vectors = JSON.parse(await readFile(join(KIT, 'vectors.json'), 'utf8')) as Vectors;
  archivePath = join(KIT, vectors.fixture.path);
  dir = await mkdtemp(join(tmpdir(), 'gezk-conformance-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('conformance vectors', () => {
  it('reproduces the content-derived ids', () => {
    for (const c of vectors.chunkUid) {
      expect(chunkUid(c.documentId, c.ordinal, c.text)).toBe(c.expected);
    }
    for (const c of vectors.contentHash) expect(chunkContentHash(c.text)).toBe(c.expected);
  });

  it('reproduces int8 and sign-bit quantization', () => {
    for (const c of vectors.quantization) {
      expect(Array.from(quantizeInt8(c.input))).toEqual(c.int8);
      expect(Array.from(quantizeBinary(c.input))).toEqual(c.bits);
    }
  });

  it('reproduces canonical JSON', () => {
    for (const c of vectors.jcs) expect(canonicalizeJson(c.input)).toBe(c.canonical);
  });

  it('parses and formats knowledge:// references identically', () => {
    for (const c of vectors.uri) expect(parseKnowledgeUri(c.uri)).toEqual(c.parsed);
    expect(formatKnowledgeUri(vectors.uriFormat.input)).toBe(vectors.uriFormat.expected);
  });

  it('selects the same hamming top-K', () => {
    const h = vectors.hamming;
    const hits = hammingTopK(
      {
        bits: Uint8Array.from(h.rows),
        bytesPerRow: h.bytesPerRow,
        rows: h.rows.length / h.bytesPerRow,
      },
      Uint8Array.from(h.query),
      h.k,
    );
    expect(hits).toEqual(h.expected);
  });
});

describe('conformance fixture', () => {
  let manifest: KnowledgeCatalogManifest;
  let extracted: string;

  beforeAll(async () => {
    const bytes = await readFile(archivePath);
    expect(bytes.length).toBe(vectors.fixture.sizeBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(vectors.fixture.sha256);
    manifest = await readGezkManifest(archivePath);
    extracted = join(dir, 'extracted');
    await extractGezkVerified(archivePath, extracted);
  });

  it('carries the expected identity and counts', () => {
    expect(manifest.formatVersion).toBe(vectors.formatVersion);
    expect(manifest.id).toBe(vectors.fixture.catalogId);
    expect(manifest.version).toBe(vectors.fixture.version);
    expect(manifest.publisher.id).toBe(vectors.fixture.publisherId);
    expect(manifest.counts).toEqual({
      documents: vectors.fixture.documents,
      chunks: vectors.fixture.chunks,
      shards: vectors.fixture.shards,
    });
  });

  it('verifies under the test key and fails when tampered', () => {
    const anchors = [
      { keyId: vectors.signature.keyId, publicKeyPem: vectors.signature.publicKeyPem },
    ];
    expect(verifyManifestSignature(manifest, anchors)).toEqual({
      ok: true,
      keyId: vectors.signature.keyId,
    });
    const tampered = { ...manifest, [vectors.signature.tamperedField]: 'tampered' };
    expect(verifyManifestSignature(tampered as KnowledgeCatalogManifest, anchors).ok).toBe(false);
  });

  it('passes deep validation and answers the recorded queries', async () => {
    const report = await validateExtractedCatalog(extracted, { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const handle = CatalogHandle.open(extracted);
    try {
      for (const q of vectors.fixture.ftsQueries) {
        const ids = handle.searchDocumentsFts(q.query, 5).map((h) => h.documentId);
        expect(ids, q.query).toContain(q.expectedDocumentId);
      }
      const doc = handle.getDocument(vectors.fixture.documentRoundTrip.documentId);
      expect(
        createHash('sha256')
          .update(doc?.markdown ?? '', 'utf8')
          .digest('hex'),
      ).toBe(vectors.fixture.documentRoundTrip.markdownSha256);
      const [vector] = await fakeEmbed([vectors.fixture.semanticProbe.embedInput]);
      const hits = handle.searchSemantic(Float32Array.from(vector as number[]), { finalK: 5 });
      expect(hits[0]?.chunkUid).toBe(vectors.fixture.semanticProbe.chunkUid);
      expect(hits[0]?.documentId).toBe(vectors.fixture.semanticProbe.documentId);
    } finally {
      handle.close();
    }
  });
});
