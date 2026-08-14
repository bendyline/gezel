import { describe, expect, it } from 'vitest';
import { formatModelAttribution, modelAttribution } from './model-attribution.js';
import type { ChatModelManifest } from './schemas/catalog.js';

function model(overrides: Partial<ChatModelManifest> = {}): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'gemma4-31b-q4',
    name: 'Gemma 4 (31B)',
    description: '',
    tags: [],
    maintainer: {
      name: 'Google',
      url: 'https://huggingface.co/google/gemma-4-31B-it',
    },
    version: '1.0.0',
    releasedAt: '2026-01-01',
    parameterSize: '31B',
    approxSizeBytes: 1,
    supportsTools: true,
    upstream: 'https://huggingface.co/google/gemma-4-31B-it',
    llamaCpp: {
      huggingfaceRepo: 'unsloth/gemma-4-31B-it-qat-GGUF',
      filename: 'model.gguf',
      sha256: '0'.repeat(64),
      approxSizeBytes: 1,
    },
    mlx: {
      huggingfaceRepo: 'mlx-community/gemma-4-31B-it-qat-4bit',
      files: [{ name: 'model.safetensors', sha256: '0'.repeat(64), sizeBytes: 1 }],
      approxSizeBytes: 1,
    },
    availableVersions: [],
    ...overrides,
  };
}

describe('modelAttribution', () => {
  it('credits the core maker and deduplicates organizations that prepared variants', () => {
    expect(modelAttribution(model())).toEqual({
      maker: 'Google',
      customizers: ['unsloth', 'mlx-community'],
    });
    expect(formatModelAttribution(model())).toBe('Google, customized by unsloth, mlx-community');
  });

  it('does not call a maker-owned conversion a customization', () => {
    expect(
      modelAttribution(
        model({
          maintainer: { name: 'Bad Theory Labs' },
          upstream: 'https://huggingface.co/badtheorylabs/BTL-4-Compact',
          llamaCpp: {
            huggingfaceRepo: 'badtheorylabs/BTL-4-Compact',
            filename: 'model.gguf',
            sha256: '0'.repeat(64),
            approxSizeBytes: 1,
          },
          mlx: undefined,
        }),
      ),
    ).toEqual({ maker: 'Bad Theory Labs', customizers: [] });
  });

  it('separates the upstream maker from a conversion maintainer', () => {
    expect(
      modelAttribution(
        model({
          maker: {
            name: 'DeepSeek',
            url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash',
          },
          maintainer: {
            name: 'antirez',
            url: 'https://huggingface.co/antirez/deepseek-v4-gguf',
          },
          upstream: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash',
          llamaCpp: undefined,
          mlx: undefined,
          ds4: {
            huggingfaceRepo: 'antirez/deepseek-v4-gguf',
            filename: 'model.gguf',
            sha256: '0'.repeat(64),
            approxSizeBytes: 1,
          },
        }),
      ),
    ).toEqual({ maker: 'DeepSeek', customizers: ['antirez'] });
  });
});
