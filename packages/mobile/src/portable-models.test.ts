import { describe, expect, it } from 'vitest';
import type { CatalogItemSummary } from '../../core/src/schemas/catalog.js';
import { portableCatalogModels } from '../scripts/portable-models.js';

const item = (source: Record<string, unknown> = {}): CatalogItemSummary =>
  ({
    sourceId: 'bundled',
    kind: 'chat-model',
    manifest: {
      schemaVersion: 1,
      tags: [],
      maintainer: { name: 'Test' },
      kind: 'chat-model',
      id: 'test-model',
      name: 'Test',
      version: '1.0.0',
      description: 'A test model',
      releasedAt: '2026-09-20',
      parameterSize: '1B',
      supportsTools: true,
      approxSizeBytes: 1000,
      availableVersions: [],
      llamaCpp: {
        huggingfaceRepo: 'publisher/model',
        revision: 'a'.repeat(40),
        filename: 'weights.gguf',
        sha256: 'b'.repeat(64),
        approxSizeBytes: 1000,
        ...source,
      },
    },
  }) as CatalogItemSummary;

describe('mobile catalog provenance', () => {
  it('excludes mutable, unhashed, sharded and oversized sources without inventing recipes', () => {
    const models = portableCatalogModels([
      item(),
      item({ revision: 'main' }),
      item({ sha256: undefined }),
      item({ shards: [{ filename: 'a.gguf' }, { filename: 'b.gguf' }] }),
      item({ approxSizeBytes: 5 * 1024 ** 3 }),
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]!.source).toEqual({
      catalogId: 'test-model',
      catalogVersion: '1.0.0',
      sourceId: 'bundled',
      huggingfaceRepo: 'publisher/model',
      revision: 'a'.repeat(40),
      filename: 'weights.gguf',
      sha256: 'b'.repeat(64),
    });
    expect(models[0]!.source).not.toHaveProperty('sizeBytes');
  });
});
