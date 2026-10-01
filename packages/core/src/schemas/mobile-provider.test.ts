import { describe, expect, it } from 'vitest';
import {
  MobileModelDownloadSchema,
  MobileModelSchema,
  MobileModelSourceSchema,
  resolveMobileInferenceBudget,
} from './mobile-provider.js';

describe('portable inference budget admission', () => {
  const llama = { contextTokens: 16384, maxOutputTokens: 4096 };
  it('uses sustainable defaults while preserving explicit per-model choices', () => {
    expect(resolveMobileInferenceBudget(llama)).toEqual({ contextSize: 4096, maxTokens: 2048 });
    expect(resolveMobileInferenceBudget(llama, { contextSize: 8192, maxTokens: 4096 })).toEqual({
      contextSize: 8192,
      maxTokens: 4096,
    });
    // The window the device reported it fits for the model, 16K at most.
    expect(resolveMobileInferenceBudget(llama, { contextSize: 16384 })).toEqual({
      contextSize: 16384,
      maxTokens: 4096,
    });
    // A whole-file write needs thousands of tokens; the 8K window a mid-range
    // phone fits gets the bridge's full reply ceiling.
    expect(resolveMobileInferenceBudget(llama, { contextSize: 8192 }).maxTokens).toBe(4096);
    expect(() =>
      resolveMobileInferenceBudget(
        { contextTokens: 32768, maxOutputTokens: 4096 },
        { contextSize: 32768 },
      ),
    ).toThrow();
    expect(resolveMobileInferenceBudget({ contextTokens: 2048, maxOutputTokens: 256 })).toEqual({
      contextSize: 2048,
      maxTokens: 256,
    });
  });
  it('respects provider limits without silently reducing explicit settings', () => {
    const apple = { contextTokens: 4096, maxOutputTokens: 1024 };
    expect(resolveMobileInferenceBudget(apple)).toEqual({ contextSize: 4096, maxTokens: 1024 });
    expect(() => resolveMobileInferenceBudget(apple, { contextSize: 8192 })).toThrow('exceed');
    expect(() => resolveMobileInferenceBudget(apple, { maxTokens: 2048 })).toThrow('exceed');
    for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 4097])
      expect(() => resolveMobileInferenceBudget(llama, { maxTokens })).toThrow();
    expect(() =>
      resolveMobileInferenceBudget(llama, { contextSize: 1024, maxTokens: 1024 }),
    ).toThrow('Leave room');
  });
});

describe('verified mobile model source admission', () => {
  const source = {
    catalogId: 'model',
    catalogVersion: '1.2.3',
    sourceId: 'q4',
    huggingfaceRepo: 'owner/repository',
    revision: 'a'.repeat(40),
    filename: 'weights/model.gguf',
    sha256: 'b'.repeat(64),
    sizeBytes: 1024,
  };
  it('requires immutable identities and exact bounded sizes', () => {
    expect(MobileModelSourceSchema.parse(source)).toEqual(source);
    for (const invalid of [
      { ...source, revision: 'main' },
      { ...source, sha256: 'unknown' },
      { ...source, sizeBytes: undefined },
      { ...source, sizeBytes: 4 * 1024 * 1024 * 1024 + 1 },
      { ...source, filename: '../model.gguf' },
      { ...source, filename: '/model.gguf' },
      { ...source, huggingfaceRepo: 'https://example.test/repo' },
      { ...source, url: 'https://example.test/model.gguf' },
    ])
      expect(MobileModelSourceSchema.safeParse(invalid).success).toBe(false);
  });
  it('bounds progress by the exact source length and keeps provenance in inventory', () => {
    const id = '9f322034-741e-4d71-9f7f-960b505dcbdf';
    const download = { id, name: 'Model', source, state: 'paused', downloadedBytes: 512 };
    expect(MobileModelDownloadSchema.parse(download)).toEqual(download);
    expect(
      MobileModelDownloadSchema.safeParse({ ...download, downloadedBytes: 1025 }).success,
    ).toBe(false);
    expect(MobileModelSchema.parse({ id, name: 'Model', source, sizeBytes: 1024 }).source).toEqual(
      source,
    );
  });
  it('carries the window the device fits for a model, within token bounds', () => {
    const id = 'model';
    expect(
      MobileModelSchema.parse({ id, name: 'Model', sizeBytes: 1024, contextTokens: 8192 })
        .contextTokens,
    ).toBe(8192);
    for (const contextTokens of [0, 511, 4096.5, Number.NaN])
      expect(() =>
        MobileModelSchema.parse({ id, name: 'Model', sizeBytes: 1024, contextTokens }),
      ).toThrow();
  });
});
