import { describe, expect, it } from 'vitest';
import type { KnowledgeEmbeddingProfile } from '../schemas/profiles.js';
import {
  centerVector,
  l2Normalize,
  quantizeBinary,
  quantizeBinaryForProfile,
  quantizeInt8,
  rerankScore,
} from './quantize.js';

const DIMS = 8;
const PLAIN: KnowledgeEmbeddingProfile = {
  id: 'plain@1',
  model: { repo: 'owner/model', revision: 'c'.repeat(40) },
  tokenizer: { kind: 'wordpiece-bert' },
  pooling: 'mean',
  normalized: true,
  dimensions: DIMS,
  maxTokens: 512,
  queryInstruction: '',
  passageInstruction: '',
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
};
const CENTER = [0.2, 0.2, -0.2, -0.2, 0, 0, 0.5, -0.5];
const CENTERED: KnowledgeEmbeddingProfile = {
  ...PLAIN,
  id: 'centered@2',
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center: CENTER },
  },
};

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

describe('profile-aware sign bits', () => {
  const vector = [0.1, 0.3, -0.1, -0.3, 0.05, -0.05, 0.4, -0.4];

  it('centerVector subtracts element-wise and refuses a length mismatch', () => {
    expect(Array.from(centerVector(vector, CENTER))).toEqual(
      vector.map((x, i) => x - (CENTER[i] as number)).map((x) => Math.fround(x)),
    );
    expect(() => centerVector(vector, [0.1, 0.2])).toThrow(/dimensions/);
  });

  it('a plain profile packs the raw signs; a centered one packs the signs of v − center', () => {
    expect(quantizeBinaryForProfile(PLAIN, vector)).toEqual(quantizeBinary(vector));
    // v − center = [-0.1, 0.1, 0.1, -0.1, 0.05, -0.05, -0.1, 0.1] → bits 0,1,1,0,1,0,0,1
    expect(Array.from(quantizeBinaryForProfile(CENTERED, vector))).toEqual([0b10010110]);
    expect(quantizeBinaryForProfile(CENTERED, vector)).not.toEqual(quantizeBinary(vector));
  });

  it('refuses a centered profile whose center does not fit the dimension', () => {
    const broken: KnowledgeEmbeddingProfile = {
      ...CENTERED,
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center: [0.1] },
      },
    };
    expect(() => quantizeBinaryForProfile(broken, vector)).toThrow(/center/);
  });
});
