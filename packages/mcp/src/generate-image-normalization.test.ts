import { describe, expect, it } from 'vitest';

import { normalizeGenerateImageToolArgs } from './generate-image-normalization.js';

describe('normalizeGenerateImageToolArgs', () => {
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

    expect(actual.args).toMatchObject({ width: 768, height: 448, steps: 4 });
    expect(actual.note).toBe(
      'Request normalized for agent image generation (size 1600x900 -> 768x448, steps 30 -> 4).',
    );
  });

  it('caps a single oversized dimension', () => {
    const actual = normalizeGenerateImageToolArgs({ prompt: 'banner', width: 2048 });

    expect(actual.args).toMatchObject({ width: 768 });
    expect(actual.note).toBe('Request normalized for agent image generation (width 2048 -> 768).');
  });
});
