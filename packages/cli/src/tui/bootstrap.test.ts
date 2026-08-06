import type { CatalogItemSummary, RecoDevice } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { NATIVE_TOOLKIT, pickAccessoryModels, rankChatModels } from './bootstrap.js';

const GB = 1024 ** 3;
const DEVICE: RecoDevice = {
  platform: 'win32',
  gpuVramBytes: 12 * GB,
  totalRamBytes: 32 * GB,
  usableBytes: 10 * GB,
};

function chatModel(input: {
  id: string;
  name?: string;
  score?: number;
  bytes: number;
  mlx?: boolean;
  licenseClass?: string;
  supportsTools?: boolean;
  tags?: string[];
}): CatalogItemSummary {
  const source = {
    huggingfaceRepo: 'test/model',
    filename: 'model.gguf',
    sha256: '0'.repeat(64),
    approxSizeBytes: input.bytes,
    residentBytes: input.bytes,
  };
  return {
    sourceId: 'test',
    kind: 'chat-model',
    manifest: {
      schemaVersion: 1,
      kind: 'chat-model',
      id: input.id,
      name: input.name ?? input.id,
      description: '',
      tags: input.tags ?? [],
      maintainer: { name: 'test' },
      licenseClass: input.licenseClass ?? 'open',
      recoScore: input.score,
      version: '1.0.0',
      releasedAt: '2026-01-01',
      parameterSize: '1B',
      approxSizeBytes: input.bytes,
      supportsTools: input.supportsTools ?? true,
      llamaCpp: source,
      ...(input.mlx
        ? {
            mlx: {
              huggingfaceRepo: 'test/model',
              files: [{ name: 'weights', sha256: '0'.repeat(64), sizeBytes: input.bytes }],
              approxSizeBytes: input.bytes,
              residentBytes: input.bytes,
            },
          }
        : {}),
      availableVersions: [],
    },
  } as unknown as CatalogItemSummary;
}

function mediaModel(
  kind: 'image-model' | 'video-model',
  id: string,
  score: number,
  bytes: number,
  min: number,
): CatalogItemSummary {
  return {
    sourceId: 'test',
    kind,
    manifest: {
      kind,
      id,
      name: id,
      recoScore: score,
      licenseClass: 'open',
      approxSizeBytes: bytes,
      ...(kind === 'image-model' ? { minRamGB: min } : { minVramGB: min }),
    },
  } as unknown as CatalogItemSummary;
}

describe('rankChatModels', () => {
  it('puts the daemon-style recommendation first and keeps only comfortable alternatives', () => {
    const ranked = rankChatModels(
      [
        chatModel({ id: 'too-large', score: 100, bytes: 40 * GB }),
        chatModel({ id: 'recommended', score: 90, bytes: 8 * GB }),
        chatModel({ id: 'alternative', score: 40, bytes: 5 * GB }),
        chatModel({
          id: 'restricted',
          score: 999,
          bytes: 2 * GB,
          licenseClass: 'restricted',
        }),
      ],
      DEVICE,
      'llama-cpp',
    );

    expect(ranked.map((model) => model.id)).toEqual(['recommended', 'alternative']);
  });

  it('never leads with a tool-less model, though it stays offerable', () => {
    const ranked = rankChatModels(
      [
        chatModel({ id: 'tool-less', score: 999, bytes: 2 * GB, supportsTools: false }),
        chatModel({ id: 'recommended', score: 90, bytes: 8 * GB }),
      ],
      DEVICE,
      'llama-cpp',
    );

    expect(ranked[0]?.id).toBe('recommended');
    expect(ranked.map((model) => model.id)).toContain('tool-less');
  });

  it('leads with the small safe model on a sub-8-GiB GPU even when a large MoE technically offloads', () => {
    const ranked = rankChatModels(
      [
        chatModel({ id: 'gemma4-e2b-q4', score: 15, bytes: 6 * GB }),
        chatModel({ id: 'gemma4-26b-q4', score: 15, bytes: 17 * GB, tags: ['moe'] }),
      ],
      {
        platform: 'win32',
        gpuVramBytes: 4 * GB,
        gpuMemoryKind: 'discrete',
        totalRamBytes: 32 * GB,
        usableBytes: 3.8 * GB,
        budgetBytes: 23 * GB,
      },
      'llama-cpp',
    );

    expect(ranked[0]?.id).toBe('gemma4-e2b-q4');
  });

  it('only offers MLX choices that actually ship an enabled MLX source', () => {
    const ranked = rankChatModels(
      [
        chatModel({ id: 'gguf-only', score: 100, bytes: 2 * GB }),
        chatModel({ id: 'mlx-ready', score: 80, bytes: 3 * GB, mlx: true }),
      ],
      { ...DEVICE, platform: 'darwin', gpuVramBytes: null },
      'mlx',
    );

    expect(ranked.map((model) => model.id)).toEqual(['mlx-ready']);
  });
});

describe('pickAccessoryModels', () => {
  it('picks the best fitting open helper in every modality and skips installed ones', () => {
    const picked = pickAccessoryModels(
      {
        imageItems: [
          mediaModel('image-model', 'image-too-big', 100, 8 * GB, 64),
          mediaModel('image-model', 'image-fit', 80, 3 * GB, 16),
        ],
        videoItems: [mediaModel('video-model', 'video-fit', 90, 5 * GB, 8)],
        audio: {
          stt: [
            {
              id: 'stt',
              name: 'STT',
              approxSizeBytes: 100,
              recoScore: 20,
              licenseClass: 'open',
            },
          ],
          tts: [
            {
              id: 'tts',
              name: 'TTS',
              approxSizeBytes: 100,
              recoScore: 20,
              licenseClass: 'open',
            },
          ],
        },
        recognition: [
          {
            id: 'reader',
            name: 'Reader',
            approxSizeBytes: 100,
            recoScore: 90,
          },
        ],
        installed: { tts: new Set(['tts']) },
      },
      DEVICE,
    );

    expect(picked.map((model) => model.id)).toEqual(['image-fit', 'reader', 'stt', 'video-fit']);
    expect(picked.map((model) => model.requiredEngine)).toEqual([
      'sd-server',
      'llama-server',
      'whisper-server',
      'uv',
    ]);
  });
});

it('installs the shared native archive before the variant-specific llama archive', () => {
  expect(NATIVE_TOOLKIT).toEqual(['uv', 'sd-server', 'whisper-server', 'llama-server']);
});
