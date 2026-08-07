import { describe, expect, it } from 'vitest';
import { formatContextWindow } from './model-context.js';

describe('formatContextWindow', () => {
  it.each([
    [4_096, '4K'],
    [32_768, '32K'],
    [128_000, '128K'],
    [131_072, '128K'],
    [256_000, '256K'],
    [262_144, '256K'],
    [1_000_000, '1M'],
    [1_048_576, '1M'],
  ])('formats %i tokens as %s', (tokens, expected) => {
    expect(formatContextWindow(tokens)).toBe(expected);
  });

  it('uses a dash when context metadata is unavailable', () => {
    expect(formatContextWindow(undefined)).toBe('—');
  });
});
