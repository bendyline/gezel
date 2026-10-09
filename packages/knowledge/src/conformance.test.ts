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
  type GezkFormatVersion,
  type KnowledgeCatalogManifest,
  type KnowledgeEmbeddingProfile,
  canonicalizeJson,
  formatAtLeast,
  formatKnowledgeUri,
  parseKnowledgeUri,
  profileUnitVector,
  quantizeBinary,
  quantizeBinaryForProfile,
  quantizeInt8,
} from '@bendyline/gezk';
import { chunkContentHash, chunkUid, verifyManifestSignature } from '@bendyline/gezk/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from './archive/read.js';
import { asymmetricTopK, hammingTopK } from './reader/bit-scan.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import { FIXTURE_EMBEDDING_PROFILE_08, fakeEmbed } from './test/fixture.js';

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
  asymmetric: {
    rows: number[];
    bytesPerRow: number;
    query: number[];
    k: number;
    expected: Array<{ chunkId: number; score: number }>;
  };
  truncation: Array<{
    dimensions: number;
    sourceDimensions: number;
    input: number[];
    expected: number[];
  }>;
  centeredBits: Array<{ input: number[]; center: number[]; bits: number[]; int8: number[] }>;
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
    sharedToc: { documentId: string; primaryTopicId: string; referenceTopicIds: string[] };
    nestedTopic: {
      id: string;
      parentId: string | null;
      directDocuments: number;
      parentDirectDocuments: number;
      parentTotalDocuments: number;
    };
    orderedListing: { topicId: string; firstDocumentIds: string[] };
    metaSample: { documentId: string; meta: Record<string, unknown> };
    assets: Array<{ path: string; contentType: string; sizeBytes: number; sha256: string }>;
    assetDocument: { documentId: string; path: string };
    /** 0.8: media rows by modality. */
    media?: { image: number; video: number; audio: number };
    /** 0.8: a media window the exact media scan must return first. */
    mediaProbe?: {
      modality: 'image' | 'video' | 'audio';
      assetPath: string;
      embedInput: string;
      documentId: string;
      startMs?: number;
      endMs?: number;
    };
  };
  legacy: Array<
    { formatVersion: string } & Pick<
      Vectors['fixture'],
      | 'path'
      | 'sha256'
      | 'sizeBytes'
      | 'catalogId'
      | 'version'
      | 'documents'
      | 'chunks'
      | 'shards'
      | 'ftsQueries'
      | 'documentRoundTrip'
    >
  >;
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

  it('selects the same asymmetric top-K', () => {
    const a = vectors.asymmetric;
    const hits = asymmetricTopK(
      {
        bits: Uint8Array.from(a.rows),
        bytesPerRow: a.bytesPerRow,
        rows: a.rows.length / a.bytesPerRow,
      },
      a.query,
      a.k,
    );
    expect(hits.map((hit) => hit.chunkId)).toEqual(a.expected.map((hit) => hit.chunkId));
    hits.forEach((hit, i) => expect(hit.score).toBeCloseTo(a.expected[i]?.score ?? Number.NaN, 5));
  });

  it('reproduces Matryoshka truncation', () => {
    for (const c of vectors.truncation) {
      const profile: KnowledgeEmbeddingProfile = {
        ...FIXTURE_EMBEDDING_PROFILE_08,
        dimensions: c.dimensions,
        truncation: { method: 'prefix', sourceDimensions: c.sourceDimensions },
        quantization: {
          int8: { method: 'symmetric-linear', scale: 127 },
          binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
        },
      };
      expect(Array.from(profileUnitVector(profile, c.input))).toEqual(c.expected);
    }
  });

  it('reproduces centered-sign bits and leaves int8 uncentered', () => {
    const { truncation: _truncation, ...untruncated } = FIXTURE_EMBEDDING_PROFILE_08;
    for (const c of vectors.centeredBits) {
      const profile: KnowledgeEmbeddingProfile = {
        ...untruncated,
        dimensions: c.center.length,
        quantization: {
          int8: { method: 'symmetric-linear', scale: 127 },
          binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center: c.center },
        },
      };
      expect(Array.from(quantizeBinaryForProfile(profile, c.input))).toEqual(c.bits);
      expect(Array.from(quantizeInt8(c.input))).toEqual(c.int8);
    }
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
      assets: vectors.fixture.assets.length,
      ...(vectors.fixture.media ? { media: vectors.fixture.media } : {}),
    });
  });

  it('reads shared TOC references with canonical identity and deduplicated counts', () => {
    const handle = CatalogHandle.open(extracted);
    try {
      const { documentId, primaryTopicId, referenceTopicIds } = vectors.fixture.sharedToc;
      expect(handle.getDocument(documentId)?.topicId).toBe(primaryTopicId);
      for (const topicId of [primaryTopicId, ...referenceTopicIds]) {
        expect(
          handle
            .documentsPage({ topicId, descendants: false, limit: 200 })
            .documents.filter((d) => d.id === documentId),
        ).toHaveLength(1);
      }
      expect(
        handle
          .documentsPage({ topicId: primaryTopicId, limit: 200 })
          .documents.filter((d) => d.id === documentId),
      ).toHaveLength(1);
      expect(handle.documentsPage().total).toBe(vectors.fixture.documents);
    } finally {
      handle.close();
    }
  });

  it('reads the 0.6 additions the kit records', () => {
    const handle = CatalogHandle.open(extracted);
    try {
      const nested = vectors.fixture.nestedTopic;
      const topics = handle.topics();
      const topic = topics.find((t) => t.id === nested.id);
      const parent = topics.find((t) => t.id === nested.parentId);
      expect(topic?.parentId).toBe(nested.parentId);
      expect(topic?.documentCount).toBe(nested.directDocuments);
      expect(parent?.documentCount).toBe(nested.parentDirectDocuments);
      expect(parent?.totalDocumentCount).toBe(nested.parentTotalDocuments);
      expect(handle.documentsPage({ topicId: nested.parentId ?? '' }).total).toBe(
        nested.parentTotalDocuments,
      );
      const listing = vectors.fixture.orderedListing;
      expect(
        handle
          .documentsPage({ topicId: listing.topicId, limit: listing.firstDocumentIds.length })
          .documents.map((d) => d.id),
      ).toEqual(listing.firstDocumentIds);
      expect(handle.getDocument(vectors.fixture.metaSample.documentId)?.meta).toEqual(
        vectors.fixture.metaSample.meta,
      );
      expect(handle.assets()).toEqual(vectors.fixture.assets);
      for (const asset of vectors.fixture.assets) {
        const read = handle.readAsset(asset.path);
        expect(read?.contentType).toBe(asset.contentType);
        expect(
          createHash('sha256')
            .update(read?.bytes ?? new Uint8Array())
            .digest('hex'),
        ).toBe(asset.sha256);
      }
      expect(handle.getDocument(vectors.fixture.assetDocument.documentId)?.markdown).toContain(
        `](${vectors.fixture.assetDocument.path})`,
      );
    } finally {
      handle.close();
    }
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
      // Project the raw embedding through the catalog's own profile (0.8 truncates).
      const [vector] = await fakeEmbed([vectors.fixture.semanticProbe.embedInput]);
      const query = profileUnitVector(manifest.embedding, vector as number[]);
      const hits = handle.searchSemantic(query, { finalK: 5 });
      expect(hits[0]?.chunkUid).toBe(vectors.fixture.semanticProbe.chunkUid);
      expect(hits[0]?.documentId).toBe(vectors.fixture.semanticProbe.documentId);
      const probe = vectors.fixture.mediaProbe;
      if (probe) {
        expect(handle.mediaCounts()).toEqual(vectors.fixture.media);
        const [raw] = await fakeEmbed([probe.embedInput]);
        const media = handle.searchMedia(profileUnitVector(manifest.embedding, raw as number[]), {
          perModality: 1,
        });
        const top = media.find((m) => m.media?.modality === probe.modality);
        expect(top?.documentId).toBe(probe.documentId);
        expect(top?.media).toMatchObject({
          assetPath: probe.assetPath,
          ...(probe.startMs !== undefined ? { startMs: probe.startMs } : {}),
          ...(probe.endMs !== undefined ? { endMs: probe.endMs } : {}),
        });
      }
    } finally {
      handle.close();
    }
  });
});

describe('legacy fixtures', () => {
  it('lists the generation this kit was upgraded from', () => {
    expect(vectors.legacy.map((entry) => entry.formatVersion)).toContain('0.5');
  });

  it('still opens, validates, and answers under a newer reader', async () => {
    for (const entry of vectors.legacy) {
      const path = join(KIT, entry.path);
      const bytes = await readFile(path);
      expect(bytes.length, entry.formatVersion).toBe(entry.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.formatVersion).toBe(
        entry.sha256,
      );
      const manifest = await readGezkManifest(path);
      expect(manifest.formatVersion).toBe(entry.formatVersion);
      expect(manifest.id).toBe(entry.catalogId);
      expect(manifest.version).toBe(entry.version);
      const extracted = join(dir, `legacy-${entry.formatVersion}`);
      await extractGezkVerified(path, extracted);
      const report = await validateExtractedCatalog(extracted, { deep: true });
      expect(
        report.checks.filter((c) => !c.ok),
        entry.formatVersion,
      ).toEqual([]);
      const handle = CatalogHandle.open(extracted);
      try {
        expect(handle.documentsPage({ limit: 1 }).total).toBe(entry.documents);
        // From 0.7 a topic's count includes shared TOC placements, so the
        // per-topic sum can exceed the distinct document count.
        const placements = handle.topics().reduce((sum, t) => sum + t.documentCount, 0);
        if (formatAtLeast(entry.formatVersion as GezkFormatVersion, '0.7')) {
          expect(placements).toBeGreaterThanOrEqual(entry.documents);
        } else {
          expect(placements).toBe(entry.documents);
        }
        for (const q of entry.ftsQueries) {
          const ids = handle.searchDocumentsFts(q.query, 5).map((h) => h.documentId);
          expect(ids, `${entry.formatVersion}: ${q.query}`).toContain(q.expectedDocumentId);
        }
        const doc = handle.getDocument(entry.documentRoundTrip.documentId);
        expect(
          createHash('sha256')
            .update(doc?.markdown ?? '', 'utf8')
            .digest('hex'),
        ).toBe(entry.documentRoundTrip.markdownSha256);
      } finally {
        handle.close();
      }
    }
  });
});
