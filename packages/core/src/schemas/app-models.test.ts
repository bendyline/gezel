import { describe, expect, it } from 'vitest';
import {
  AppEnsureEventSchema,
  AppEnsureResultSchema,
  AppKnowledgeQuerySchema,
  AppModelListSchema,
  EmbeddingPackageManifestSchema,
} from './app-models.js';
describe('public app model boundaries', () => {
  it('rejects a downloading response without a job and invalid progress counts', () => {
    expect(
      AppEnsureResultSchema.safeParse({ status: 'downloading', model_id: 'fixture' }).success,
    ).toBe(false);
    expect(
      AppEnsureEventSchema.safeParse({
        type: 'progress',
        jobId: 'job',
        modelId: 'fixture',
        bytesWritten: -1,
        totalBytes: 10,
      }).success,
    ).toBe(false);
  });
  it('keeps install-wide progress counters alongside per-file ones', () => {
    const event = {
      type: 'progress',
      jobId: 'job',
      modelId: 'mlx:fixture',
      bytesWritten: 60,
      totalBytes: 100,
      bytesWrittenAll: 70,
      totalBytesAll: 700,
    };
    expect(AppEnsureEventSchema.parse(event)).toEqual(event);
  });
  it('preserves additive server metadata while validating fields used for decisions', () => {
    const entry = {
      id: 'fixture',
      object: 'model',
      created: 0,
      owned_by: 'provider',
      future: { value: true },
    };
    expect(AppModelListSchema.parse({ object: 'list', data: [entry] }).data[0]).toEqual(entry);
    expect(
      AppModelListSchema.safeParse({
        object: 'list',
        data: [{ ...entry, availability: 'probably-ready' }],
      }).success,
    ).toBe(false);
  });
  it('rejects invalid package compatibility manifests', () => {
    expect(EmbeddingPackageManifestSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });
  it('accepts bounded local candidates beside a knowledge query', () => {
    const query = { query: 'garden pests', rerank: 'auto', maxResults: 4, maxCharacters: 8000 };
    const candidate = {
      uri: 'knowledge://local/ws-0123456789abcdef/garden/roses.md#line=3-9',
      title: 'Rose bed',
      text: 'Aphids cluster on new growth.',
    };
    expect(AppKnowledgeQuerySchema.safeParse(query).success).toBe(true);
    expect(AppKnowledgeQuerySchema.safeParse({ ...query, candidates: [candidate] }).success).toBe(
      true,
    );
    for (const candidates of [
      [{ ...candidate, uri: 'knowledge://bendyline/wiki/doc' }],
      [{ ...candidate, extra: true }],
      [{ ...candidate, text: '' }],
      Array.from({ length: 9 }, () => candidate),
      Array.from({ length: 5 }, () => ({ ...candidate, text: 'x'.repeat(5000) })),
    ])
      expect(AppKnowledgeQuerySchema.safeParse({ ...query, candidates }).success).toBe(false);
  });
});
