import { describe, expect, it } from 'vitest';
import {
  AppEnsureEventSchema,
  AppEnsureResultSchema,
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
});
