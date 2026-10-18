import { describe, expect, it } from 'vitest';
import { llamaCppBackendExclusion } from './llama-cpp-backend-exclusion.js';
import { ChatModelManifestSchema } from './schemas/catalog.js';

describe('llamaCppBackendExclusion', () => {
  const source = { excludeBackends: ['metal'], excludeReason: 'No NVFP4 kernels on Metal.' };

  it('returns the authored reason on an excluded backend', () => {
    expect(llamaCppBackendExclusion(source, 'metal')).toBe('No NVFP4 kernels on Metal.');
  });

  it('allows every other backend, and an unknown one', () => {
    expect(llamaCppBackendExclusion(source, 'cuda')).toBeNull();
    expect(llamaCppBackendExclusion(source, 'vulkan')).toBeNull();
    expect(llamaCppBackendExclusion(source, undefined)).toBeNull();
    expect(llamaCppBackendExclusion(undefined, 'metal')).toBeNull();
  });

  it('names the backend when the source gives no reason', () => {
    expect(llamaCppBackendExclusion({ excludeBackends: ['cpu'] }, 'cpu')).toBe(
      'This model is not built for the CPU-only llama.cpp engine.',
    );
  });

  it('round-trips through the catalog schema', () => {
    const parsed = ChatModelManifestSchema.parse({
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'nvfp4',
      name: 'NVFP4',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'Test' },
      version: '1.0.0',
      releasedAt: '2026-10-17T00:00:00Z',
      availableVersions: ['1.0.0'],
      parameterSize: '2B',
      approxSizeBytes: 1,
      supportsTools: false,
      llamaCpp: {
        huggingfaceRepo: 'test/nvfp4',
        filename: 'model.gguf',
        sha256: 'a'.repeat(64),
        approxSizeBytes: 1,
        ...source,
      },
    });
    expect(llamaCppBackendExclusion(parsed.llamaCpp, 'metal')).toBe(source.excludeReason);
  });
});
