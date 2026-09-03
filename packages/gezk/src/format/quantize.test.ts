import { describe, expect, it } from 'vitest';
import { l2Normalize, quantizeBinary, quantizeInt8, rerankScore } from './quantize.js';

describe('vector quantization', () => {
  it('int8 is symmetric-linear with scale 127, rounds half toward +inf, never produces -128', () => {
    const q = quantizeInt8([1, -1, 0.5, -0.5, 0, 0.0039, -0.0039, 2]);
    expect(Array.from(q)).toEqual([127, -127, 64, -63, 0, 0, 0, 127]);
  });

  it('binary packs sign bits LSB-first and treats exact zero as 0', () => {
    const bits = quantizeBinary([0.1, 0, -0.1, 0.2, 0, 0, 0, 0.3, 0.4]);
    expect(Array.from(bits)).toEqual([0b10001001, 0b00000001]);
  });

  it('rerank score of a vector against its own int8 image approaches 1', () => {
    const unit = l2Normalize([3, 4, 12, -1, 0.5]);
    expect(rerankScore(unit, quantizeInt8(unit))).toBeGreaterThan(0.99);
  });

  it('refuses to normalize a zero vector', () => {
    expect(() => l2Normalize([0, 0, 0])).toThrow(/degenerate/);
  });
});
