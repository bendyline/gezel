import { describe, expect, it } from 'vitest';

import { normalizeGenerateImageToolArgs } from './generate-image-normalization.js';

describe('normalizeGenerateImageToolArgs', () => {
  it('preserves exact cloud dimensions for the provider to apply', () => {
    const args = { width: 1536, height: 1024, steps: 20 };
    expect(normalizeGenerateImageToolArgs(args, 'cloud')).toEqual({ args });
  });
  it('keeps modest requests unchanged', () => {
    const actual = normalizeGenerateImageToolArgs({ prompt: 'sunset', width: 512, steps: 4 });

    expect(actual).toEqual({ args: { prompt: 'sunset', width: 512, steps: 4 } });
  });

  it('caps oversized two-dimensional requests while preserving aspect ratio', () => {
    const actual = normalizeGenerateImageToolArgs({
      prompt: 'sunset',
      width: 1600,
      height: 900,
      steps: 30,
    });

    expect(actual.args).toMatchObject({ width: 1024, height: 576, steps: 30 });
    expect(actual.note).toBe(
      'Request normalized for agent image generation (size 1600x900 -> 1024x576).',
    );
  });

  it("leaves steps to the daemon, which holds them at the model's recommendation", () => {
    const actual = normalizeGenerateImageToolArgs({ prompt: 'poster', steps: 50 });

    expect(actual).toEqual({ args: { prompt: 'poster', steps: 50 } });
  });

  it('caps a single oversized dimension', () => {
    const actual = normalizeGenerateImageToolArgs({ prompt: 'banner', width: 2048 });

    expect(actual.args).toMatchObject({ width: 1024 });
    expect(actual.note).toBe('Request normalized for agent image generation (width 2048 -> 1024).');
  });
});
