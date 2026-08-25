import type { KnowledgeCatalogManifest, KnowledgeRegistryIndex } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from './jcs.js';
import {
  generateKnowledgeSigningKeyPair,
  knowledgeKeyId,
  signManifest,
  signRegistryIndex,
  verifyManifestSignature,
  verifyRegistryIndex,
} from './signing.js';

describe('canonicalizeJson (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code units', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // RFC 8785 §3.2.3 example ordering: literals sort by code units, so
    // '\r' (0x0D) < '1' (0x31) < '<' (0x3C) < 'A' (0x41) < 'a' (0x61).
    // Assert the serialized bytes directly: parsing and calling Object.keys
    // would move the integer-index key "1" ahead of the other properties.
    expect(canonicalizeJson({ a: 0, A: 0, '1': 0, '<': 0, '\r': 0 })).toBe(
      '{"\\r":0,"1":0,"<":0,"A":0,"a":0}',
    );
  });

  it('serializes numbers per ECMAScript rules', () => {
    expect(canonicalizeJson({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalizeJson({ n: 0.000001 })).toBe('{"n":0.000001}');
    expect(canonicalizeJson({ n: 10 })).toBe('{"n":10}');
  });

  it('drops undefined object members and rejects non-finite numbers', () => {
    expect(canonicalizeJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalizeJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalizeJson({ a: () => 0 })).toThrow(/no JSON identity/);
  });

  it('is stable across insertion order', () => {
    const a = canonicalizeJson({ x: [1, { z: 1, y: 2 }], w: 'ü' });
    const b = canonicalizeJson({ w: 'ü', x: [1, { y: 2, z: 1 }] });
    expect(a).toBe(b);
  });
});

function minimalManifest(): KnowledgeCatalogManifest {
  return {
    kind: 'gezel-knowledge-catalog',
    formatVersion: 1,
    indexSchemaVersion: 1,
    id: 'sig-test',
    version: '1.0.0',
    name: 'Sig Test',
    language: 'en',
    publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
    createdAt: '2026-01-01T00:00:00.000Z',
    license: { name: 'MIT', attributionRequired: false },
    embedding: {
      id: 'gezel-test-hash-embed@1',
      model: { repo: 'test/hash', revision: 'fixture' },
      tokenizer: { kind: 'whitespace' },
      pooling: 'mean',
      normalized: true,
      dimensions: 384,
      maxTokens: 512,
      queryInstruction: '',
      passageInstruction: '',
      vectorEncoding: 'bit384+int8',
      distance: { stage1: 'hamming', stage2: 'cosine' },
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    },
    chunking: {
      id: 'gezel-markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      targetTokens: 420,
      overlapTokens: 64,
      contextHeader: { maxTokens: 64 },
    },
    topics: [{ id: 'root', name: 'Root' }],
    router: { shardTargetChunks: 200_000, shards: [], totalCentroids: 0 },
    counts: { documents: 1, chunks: 1, shards: 1 },
    files: [{ path: 'index/router.db', sizeBytes: 1, sha256: 'a'.repeat(64) }],
    compatibility: { maximumIndexSchemaVersion: 1 },
  };
}

describe('manifest signing', () => {
  it('signs and verifies against a matching trust anchor', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const signed = signManifest(minimalManifest(), keys.privateKeyPem);
    expect(signed.signature?.keyId).toBe(keys.keyId);
    expect(signed.signature?.canonicalization).toBe('rfc8785');
    const verdict = verifyManifestSignature(signed, [
      { keyId: keys.keyId, publicKeyPem: keys.publicKeyPem },
    ]);
    expect(verdict).toEqual({ ok: true, keyId: keys.keyId });
  });

  it('rejects any content change after signing', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const signed = signManifest(minimalManifest(), keys.privateKeyPem);
    const tampered = { ...signed, name: 'Renamed' };
    const verdict = verifyManifestSignature(tampered, [
      { keyId: keys.keyId, publicKeyPem: keys.publicKeyPem },
    ]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad-signature');
  });

  it('rejects unsigned manifests and unknown keys — no anchor scan fallback', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const other = generateKnowledgeSigningKeyPair();
    expect(verifyManifestSignature(minimalManifest(), []).ok).toBe(false);
    const signed = signManifest(minimalManifest(), keys.privateKeyPem);
    const verdict = verifyManifestSignature(signed, [
      { keyId: other.keyId, publicKeyPem: other.publicKeyPem },
    ]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unknown-key');
  });

  it('supports rotation via overlapping anchors', () => {
    const oldKeys = generateKnowledgeSigningKeyPair();
    const newKeys = generateKnowledgeSigningKeyPair();
    const anchors = [
      { keyId: oldKeys.keyId, publicKeyPem: oldKeys.publicKeyPem },
      { keyId: newKeys.keyId, publicKeyPem: newKeys.publicKeyPem },
    ];
    expect(
      verifyManifestSignature(signManifest(minimalManifest(), oldKeys.privateKeyPem), anchors).ok,
    ).toBe(true);
    expect(
      verifyManifestSignature(signManifest(minimalManifest(), newKeys.privateKeyPem), anchors).ok,
    ).toBe(true);
  });

  it('rejects an anchor whose declared keyId does not match its key', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const other = generateKnowledgeSigningKeyPair();
    const signed = signManifest(minimalManifest(), keys.privateKeyPem);
    const verdict = verifyManifestSignature(signed, [
      { keyId: keys.keyId, publicKeyPem: other.publicKeyPem },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('keyId is a stable function of the public key', () => {
    const keys = generateKnowledgeSigningKeyPair();
    expect(knowledgeKeyId(keys.publicKeyPem)).toBe(keys.keyId);
    expect(keys.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('registry index signing', () => {
  const index = (): KnowledgeRegistryIndex => ({
    kind: 'gezel-knowledge-registry',
    formatVersion: 1,
    publisher: { id: 'qualla', name: 'Qualla' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    catalogs: [
      {
        catalogId: 'world-history',
        version: '2026.08.0',
        name: 'World History',
        language: 'en',
        documents: 100_000,
        archiveBytes: 1_234_567,
        contentDigest: 'a'.repeat(64),
        url: 'https://gezelgilde.com/_knowledge/catalogs/world-history/2026.08.0/world-history-2026.08.0.gezk',
        license: { name: 'CC BY-SA 4.0', attributionRequired: true },
        sourceSnapshot: { name: 'enwiki', date: '2026-08-01' },
      },
    ],
  });

  it('signs and verifies with the manifest discipline', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const signed = signRegistryIndex(index(), keys.privateKeyPem);
    expect(signed.signature?.keyId).toBe(keys.keyId);
    expect(
      verifyRegistryIndex(signed, [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
    ).toEqual({ ok: true, keyId: keys.keyId });
  });

  it('rejects an edited row, an unsigned index, and an unknown key', () => {
    const keys = generateKnowledgeSigningKeyPair();
    const other = generateKnowledgeSigningKeyPair();
    const anchors = [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }];
    const signed = signRegistryIndex(index(), keys.privateKeyPem);

    const edited = {
      ...signed,
      catalogs: [{ ...signed.catalogs[0]!, contentDigest: 'b'.repeat(64) }],
    };
    expect(verifyRegistryIndex(edited, anchors).ok).toBe(false);
    expect(verifyRegistryIndex(index(), anchors).ok).toBe(false);
    expect(
      verifyRegistryIndex(signed, [{ keyId: other.keyId, publicKeyPem: other.publicKeyPem }]).ok,
    ).toBe(false);
  });
});
