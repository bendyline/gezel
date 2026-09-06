import { describe, expect, it } from 'vitest';
import {
  GEZK_FORMAT_GENERATIONS,
  GEZK_FORMAT_VERSION,
  GEZK_INDEX_SCHEMA_VERSION,
  GEZK_SUPPORTED_FORMAT_VERSIONS,
  GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS,
  isSupportedFormatVersion,
  isSupportedIndexSchemaVersion,
} from '../format/constants.js';
import {
  KNOWLEDGE_MANIFEST_INDEX_SCHEMA_VERSIONS,
  KnowledgeCatalogManifestSchema,
} from './manifest.js';
import { KnowledgeRegistryIndexSchema } from './registry.js';

const SHA = 'a'.repeat(64);

function manifestFor(formatVersion: '0.5' | '0.6', patch: Record<string, unknown> = {}) {
  return {
    kind: 'gezk-catalog',
    formatVersion,
    indexSchemaVersion: GEZK_FORMAT_GENERATIONS[formatVersion],
    id: 'notes',
    version: '1.0.0',
    name: 'Notes',
    language: 'en',
    publisher: { id: 'tests', name: 'Tests' },
    createdAt: '2026-01-01T00:00:00.000Z',
    license: { name: 'MIT', noticePath: 'LICENSES/catalog.txt', attributionRequired: false },
    embedding: {
      id: 'test-hash-embed@1',
      model: { repo: 'tests/hash', revision: 'none' },
      tokenizer: { kind: 'whitespace' },
      pooling: 'mean',
      normalized: true,
      dimensions: 384,
      maxTokens: 512,
      queryInstruction: '',
      passageInstruction: '',
      vectorEncoding: 'bit+int8',
      distance: { stage1: 'hamming', stage2: 'cosine' },
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    },
    chunking: {
      id: 'markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      target: 420,
      overlap: 64,
      contextHeader: { max: 64 },
    },
    topics: [{ id: 'general', name: 'General' }],
    router: {
      shardTargetChunks: 200000,
      shards: [
        { id: 0, path: 'index/router.db', chunks: 1, documents: 1, centroids: 1, sha256: SHA },
      ],
      totalCentroids: 1,
    },
    counts: { documents: 1, chunks: 1, shards: 1 },
    files: [{ path: 'index/router.db', sizeBytes: 1, sha256: SHA }],
    requires: { formatVersion, features: [] },
    ...patch,
  };
}

describe('format generations', () => {
  it('the writer emits the newest supported pair', () => {
    expect(GEZK_FORMAT_GENERATIONS[GEZK_FORMAT_VERSION]).toBe(GEZK_INDEX_SCHEMA_VERSION);
    expect(GEZK_SUPPORTED_FORMAT_VERSIONS).toEqual(['0.5', '0.6']);
    expect(GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS).toEqual([2, 3]);
    expect(KNOWLEDGE_MANIFEST_INDEX_SCHEMA_VERSIONS).toEqual(GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS);
  });

  it('answers membership for both axes', () => {
    expect(isSupportedFormatVersion('0.5')).toBe(true);
    expect(isSupportedFormatVersion('0.6')).toBe(true);
    expect(isSupportedFormatVersion('0.4')).toBe(false);
    expect(isSupportedFormatVersion(0.6)).toBe(false);
    expect(isSupportedIndexSchemaVersion(2)).toBe(true);
    expect(isSupportedIndexSchemaVersion(3)).toBe(true);
    expect(isSupportedIndexSchemaVersion(4)).toBe(false);
  });
});

describe('KnowledgeCatalogManifestSchema across generations', () => {
  it('parses a 0.5 manifest and a 0.6 manifest', () => {
    expect(KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.5')).success).toBe(true);
    expect(KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.6')).success).toBe(true);
  });

  it('rejects a mismatched format/index pairing', () => {
    const r05 = KnowledgeCatalogManifestSchema.safeParse(
      manifestFor('0.5', { indexSchemaVersion: 3 }),
    );
    const r06 = KnowledgeCatalogManifestSchema.safeParse(
      manifestFor('0.6', { indexSchemaVersion: 2 }),
    );
    expect(r05.success).toBe(false);
    expect(r06.success).toBe(false);
    expect(JSON.stringify(r06.error?.issues)).toContain('index schema 3');
  });

  it('rejects an unknown version and a requires mismatch', () => {
    expect(
      KnowledgeCatalogManifestSchema.safeParse(
        manifestFor('0.6', { formatVersion: '0.7', indexSchemaVersion: 3 }),
      ).success,
    ).toBe(false);
    expect(
      KnowledgeCatalogManifestSchema.safeParse(
        manifestFor('0.6', { requires: { formatVersion: '0.5' } }),
      ).success,
    ).toBe(false);
  });

  it('admits the 0.6 fields only where they belong', () => {
    const counts = { documents: 1, chunks: 1, shards: 1, assets: 2 };
    expect(KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.6', { counts })).success).toBe(
      true,
    );
    expect(KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.5', { counts })).success).toBe(
      false,
    );
  });

  it('carries the topic tree and refuses a dangling or duplicated topic', () => {
    const tree = [
      { id: 'craft', name: 'Craft', sortKey: '00' },
      { id: 'metals', name: 'Metals', parentId: 'craft', sortKey: '01', description: 'Alloys' },
    ];
    const ok = KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.6', { topics: tree }));
    expect(ok.success).toBe(true);
    expect(ok.data?.topics[1]?.parentId).toBe('craft');
    const dangling = [{ id: 'metals', name: 'Metals', parentId: 'craft' }];
    expect(
      KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.6', { topics: dangling })).success,
    ).toBe(false);
    const duplicated = [
      { id: 'craft', name: 'Craft' },
      { id: 'craft', name: 'Craft again' },
    ];
    expect(
      KnowledgeCatalogManifestSchema.safeParse(manifestFor('0.6', { topics: duplicated })).success,
    ).toBe(false);
  });
});

describe('KnowledgeRegistryIndexSchema', () => {
  it('accepts every supported format version', () => {
    for (const formatVersion of GEZK_SUPPORTED_FORMAT_VERSIONS) {
      const result = KnowledgeRegistryIndexSchema.safeParse({
        kind: 'gezk-registry',
        formatVersion,
        publisher: { id: 'tests', name: 'Tests' },
        generatedAt: '2026-01-01T00:00:00.000Z',
        catalogs: [],
      });
      expect(result.success, formatVersion).toBe(true);
    }
  });
});
