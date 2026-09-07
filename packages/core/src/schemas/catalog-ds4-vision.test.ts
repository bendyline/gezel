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
