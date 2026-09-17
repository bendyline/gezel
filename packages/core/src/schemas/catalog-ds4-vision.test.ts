import { describe, expect, it } from 'vitest';
import { ChatModelDs4SourceSchema } from './catalog.js';

const SHA = 'a'.repeat(64);

describe('ChatModelDs4SourceSchema visionEncoder', () => {
  it('accepts a pinned model-matched encoder', () => {
    const parsed = ChatModelDs4SourceSchema.parse({
      huggingfaceRepo: 'antirez/glm-5.3-flash-gguf',
      revision: 'b'.repeat(40),
      filename: 'GLM-5.3-Flash-Q2.gguf',
      sha256: SHA,
      approxSizeBytes: 96_505_816_384,
      residentBytes: 100_000_000_000,
      visionEncoder: {
        filename: 'GLM-5.3-Flash-Vision-Encoder.gguf',
        sha256: 'c'.repeat(64),
        sizeBytes: 1_127_280_960,
      },
    });

    expect(parsed.visionEncoder?.filename).toBe('GLM-5.3-Flash-Vision-Encoder.gguf');
  });

  it('accepts a model-matched encoder pinned in a different repository', () => {
    const parsed = ChatModelDs4SourceSchema.parse({
      huggingfaceRepo: 'antirez/qwen3.8-flash-next-gguf',
      revision: 'b'.repeat(40),
      filename: 'Qwen3.8-Flash-Next-Q2.gguf',
      sha256: SHA,
      approxSizeBytes: 147_207_127_040,
      visionEncoder: {
        huggingfaceRepo: 'ggml-org/Qwen3.8-Flash-Next-GGUF',
        revision: 'd'.repeat(40),
        filename: 'mmproj-Qwen3.8-Flash-Next-Q8_0.gguf',
        sha256: 'c'.repeat(64),
        sizeBytes: 616_703_104,
      },
      mtp: { exactSampling: true },
    });

    expect(parsed.visionEncoder?.huggingfaceRepo).toBe('ggml-org/Qwen3.8-Flash-Next-GGUF');
    expect(parsed.visionEncoder?.revision).toBe('d'.repeat(40));
    expect(parsed.mtp?.exactSampling).toBe(true);
  });

  it('accepts disk-only-table residency metadata', () => {
    const parsed = ChatModelDs4SourceSchema.parse({
      huggingfaceRepo: 'antirez/qwen3.8-flash-next-gguf',
      filename: 'Qwen3.8-Flash-Next-Q2.gguf',
      sha256: SHA,
      approxSizeBytes: 147_207_127_040,
      residentBytes: 55_000_000_000,
      residentWeightBytes: 44_807_246_316,
      ssdStreamingSupported: false,
      prefillChunk: 1024,
    });

    expect(parsed.residentWeightBytes).toBe(44_807_246_316);
    expect(parsed.ssdStreamingSupported).toBe(false);
    expect(parsed.prefillChunk).toBe(1024);
  });

  it('rejects an encoder without a verified lowercase sha256', () => {
    const result = ChatModelDs4SourceSchema.safeParse({
      huggingfaceRepo: 'antirez/glm-5.3-flash-gguf',
      filename: 'GLM-5.3-Flash-Q2.gguf',
      sha256: SHA,
      approxSizeBytes: 96_505_816_384,
      visionEncoder: {
        filename: 'GLM-5.3-Flash-Vision-Encoder.gguf',
        sha256: 'unverified',
        sizeBytes: 1_127_280_960,
      },
    });

    expect(result.success).toBe(false);
  });
});
