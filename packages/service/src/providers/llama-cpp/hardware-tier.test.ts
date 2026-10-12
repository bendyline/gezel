import type { ChatModelManifest } from '@bendyline/gezel';
import { estimateLlamaCppResidentBytes, estimateMlxResidentBytes } from '@bendyline/gezel';
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

  it('uses the MLX block on Mac, and MLX’s own estimator with it', () => {
    // The two estimators differ in shape (MLX carries a flat sidecar cost;
    // llama.cpp a bigger proportional term), so pricing a Mac candidate with
    // llama.cpp's multiplier over-reserved every first-run pick on Apple
    // Silicon and could shrink the model the installer offered.
    const c = toRecoCandidate(
      chatModel({
        llamaCpp: { huggingfaceRepo: 'r', filename: 'f', approxSizeBytes: 10 * GB },
        mlx: { huggingfaceRepo: 'm', approxSizeBytes: 8 * GB },
      }),
      'darwin',
    );
    expect(c?.residentBytes).toBe(estimateMlxResidentBytes(8 * GB));
    expect(c?.residentBytes).not.toBe(estimateLlamaCppResidentBytes(8 * GB));
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

  it('prices the launch at the host context floor, inside the compute headroom', () => {
    const model = chatModel({
      recoScore: 20,
      licenseClass: 'open',
      kvBytesPerTokenF16: 100_000,
      llamaCpp: {
        huggingfaceRepo: 'r',
        filename: 'f',
        approxSizeBytes: 10 * GB,
        residentBytes: 12 * GB,
      },
    });
    const roomy = toRecoCandidate(model, 'win32', {
      totalRamBytes: 32 * GB,
      gpuVramBytes: 12 * GB,
    });
    // 64K window at q8_0 (0.55 of f16), with llama.cpp's 20% compute headroom.
    expect(roomy?.launchBytes).toBeCloseTo(12 * GB + (100_000 * 65_536 * 0.55) / 0.8, -3);
    const tight = toRecoCandidate(model, 'win32', { totalRamBytes: 32 * GB, gpuVramBytes: 8 * GB });
    // An 8 GB card launches at the 32K floor.
    expect(tight?.launchBytes).toBeCloseTo(12 * GB + (100_000 * 32_768 * 0.55) / 0.8, -3);
    expect(toRecoCandidate(model, 'win32')?.launchBytes).toBeUndefined();
  });

  // A 26B Gemma whose manifest carries no KV geometry was priced without its
  // f16 cache, suggested as a model that would start, and refused (2026-10-12).
  it('prices a model without KV geometry with the engine estimate, at f16 for Gemma', () => {
    const machine = { totalRamBytes: 32 * GB, gpuVramBytes: 12 * GB };
    const llamaCpp = { huggingfaceRepo: 'r', filename: 'f', approxSizeBytes: 15.6 * GB };
    const gemma = toRecoCandidate(chatModel({ id: 'gemma4-26b-q4', llamaCpp }), 'win32', machine);
    const other = toRecoCandidate(chatModel({ id: 'qwen-moe', llamaCpp }), 'win32', machine);
    const resident = estimateLlamaCppResidentBytes(15.6 * GB);
    const gemmaKv = gemma!.launchBytes! - resident;
    const otherKv = other!.launchBytes! - resident;
    expect(gemmaKv).toBeGreaterThan(GB);
    // q8_0 carries 0.55 of the f16 cache.
    expect(otherKv / gemmaKv).toBeCloseTo(0.55, 2);
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
