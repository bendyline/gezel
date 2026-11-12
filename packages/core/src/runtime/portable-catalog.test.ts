import { describe, expect, it } from 'vitest';
import type { CatalogItemSummary } from '../schemas/catalog.js';
import { portableCatalogModels } from './portable-catalog.js';

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

  it('carries a fresh llama.cpp docbench score and the license class phones rank by', () => {
    const measured = (catalogVersion: string) => {
      const scored = item();
      Object.assign(scored.manifest, {
        licenseClass: 'open',
        benchmarks: {
          docbench: {
            'llama-cpp': {
              version: '0.2.1',
              score: 70.7,
              ci: [68, 73],
              band: 3,
              families: { review: 53 },
              usableRate: 0.97,
              catalogVersion,
              runId: 'docbench-round',
              measuredAt: '2026-11-11T00:00:00Z',
              judge: 'claude-opus-5-5',
            },
          },
        },
      });
      return scored;
    };
    const [fresh] = portableCatalogModels([measured('1.0.0')]);
    expect(fresh).toMatchObject({
      licenseClass: 'open',
      docbench: { score: 70.7, band: 3, version: '0.2.1', families: { review: 53 } },
    });
    // Measured on weights the catalog has since replaced: no score.
    const [stale] = portableCatalogModels([measured('0.9.0')]);
    expect(stale).not.toHaveProperty('docbench');
    expect(stale?.licenseClass).toBe('open');
  });

  it('carries the tuning phones resolve sampling from', () => {
    const tuned = item();
    Object.assign(tuned.manifest, {
      tuning: { sampling: { temperature: 0.6, topK: 20 } },
      style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'function-call' },
    });
    const [model] = portableCatalogModels([tuned]);
    expect(model!.tuning).toEqual({ sampling: { temperature: 0.6, topK: 20 } });
    expect(model!.reasoningFormat).toBe('think');
    expect(portableCatalogModels([item()])[0]).not.toHaveProperty('tuning');
  });
});
