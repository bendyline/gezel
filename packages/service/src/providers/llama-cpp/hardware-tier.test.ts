import type { ChatModelManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { toRecoCandidate } from './hardware-tier.js';

const GB = 1024 ** 3;

/**
 * `detectModelTier` pulls live host memory + the catalog and delegates the
 * ranking to `pickRecommendedModel` (covered in
 * `packages/core/src/recommendation.test.ts`). The pure, host-independent
 * seam here is `toRecoCandidate` — mapping a manifest to the on-device
 * provider's working set.
 */
function chatModel(over: Partial<Record<string, unknown>>): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'x',
    name: 'X',
    description: '',
    tags: [],
    maintainer: { name: 'y' },
    version: '1.0.0',
    releasedAt: '2026-01-01',
    parameterSize: '7B',
    approxSizeBytes: 7 * GB,
    supportsTools: true,
    availableVersions: [],
    ...over,
  } as unknown as ChatModelManifest;
}

describe('toRecoCandidate', () => {
  it('uses the llama.cpp block off-Mac and prefers a pinned residentBytes', () => {
    const c = toRecoCandidate(
      chatModel({
        recoScore: 20,
        licenseClass: 'open',
        tags: ['moe'],
        llamaCpp: {
          huggingfaceRepo: 'r',
          filename: 'f',
          approxSizeBytes: 10 * GB,
          residentBytes: 12 * GB,
        },
        mlx: { huggingfaceRepo: 'm', approxSizeBytes: 8 * GB },
      }),
      'win32',
    );
    expect(c).not.toBeNull();
    expect(c?.residentBytes).toBe(12 * GB);
    expect(c?.recoScore).toBe(20);
    expect(c?.licenseClass).toBe('open');
    expect(c?.tags).toEqual(['moe']);
  });

  it('uses the MLX block on Mac, falling back to size × overhead when no residentBytes', () => {
    const c = toRecoCandidate(
      chatModel({
        llamaCpp: { huggingfaceRepo: 'r', filename: 'f', approxSizeBytes: 10 * GB },
        mlx: { huggingfaceRepo: 'm', approxSizeBytes: 8 * GB },
      }),
      'darwin',
    );
    expect(c?.residentBytes).toBe(Math.round(8 * GB * 1.2));
  });

  it('carries supportsTools through, so the picker can drop a tool-less model', () => {
    const c = toRecoCandidate(
      chatModel({
        recoScore: 20,
        licenseClass: 'open',
        supportsTools: false,
        llamaCpp: { huggingfaceRepo: 'r', filename: 'f', approxSizeBytes: 10 * GB },
      }),
      'win32',
    );
    expect(c?.supportsTools).toBe(false);
  });

  it('returns null when the model ships no block for that platform', () => {
    const noMlx = chatModel({
      llamaCpp: { huggingfaceRepo: 'r', filename: 'f', approxSizeBytes: 10 * GB },
    });
    expect(toRecoCandidate(noMlx, 'darwin')).toBeNull();
    const noLlama = chatModel({ mlx: { huggingfaceRepo: 'm', approxSizeBytes: 8 * GB } });
    expect(toRecoCandidate(noLlama, 'win32')).toBeNull();
  });
});
