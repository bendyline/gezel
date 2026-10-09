import { describe, expect, it } from 'vitest';
import {
  ArtifactDigestSchema,
  type KnowledgeEmbeddingProfile,
  KnowledgeEmbeddingProfileSchema,
  RepoRelativePathSchema,
  embeddingProfileArtifacts,
  embeddingProfileCenter,
  embeddingProfileCenterProblem,
  embeddingProfileMinimumFormat,
  embeddingProfileSourceDimensions,
  sameVectorSpace,
} from './profiles.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

const BASE: KnowledgeEmbeddingProfile = {
  id: 'example@1',
  model: { repo: 'owner/model', revision: 'c'.repeat(40) },
  tokenizer: { kind: 'wordpiece-bert' },
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  queryInstruction: 'query: ',
  passageInstruction: 'passage: ',
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
};

function variant(patch: Partial<KnowledgeEmbeddingProfile>): KnowledgeEmbeddingProfile {
  return { ...BASE, ...patch };
}

describe('artifact pins', () => {
  it('accepts sha256:<hex> digests only', () => {
    expect(ArtifactDigestSchema.safeParse(DIGEST_A).success).toBe(true);
    expect(ArtifactDigestSchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(ArtifactDigestSchema.safeParse(`sha256:${'A'.repeat(64)}`).success).toBe(false);
    expect(ArtifactDigestSchema.safeParse(`sha1:${'a'.repeat(40)}`).success).toBe(false);
  });

  it('accepts repo-relative paths only', () => {
    for (const ok of ['onnx/model.onnx', 'tokenizer.json', 'onnx/model_fp16.onnx']) {
      expect(RepoRelativePathSchema.safeParse(ok).success).toBe(true);
    }
    const backslashed = ['onnx', 'model.onnx'].join('\\');
    for (const bad of ['/onnx/model.onnx', 'onnx/../model.onnx', backslashed, '', 'a//b']) {
      expect(RepoRelativePathSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses a fully pinned profile and applies the format defaults', () => {
    const pinned = variant({
      model: { ...BASE.model, onnxFile: 'onnx/model.onnx', onnxDigest: DIGEST_A },
      tokenizer: { kind: 'wordpiece-bert', file: 'tokenizer.json', digest: DIGEST_B },
    });
    expect(KnowledgeEmbeddingProfileSchema.parse(pinned)).toEqual(pinned);
    expect(embeddingProfileArtifacts(BASE)).toEqual({
      onnxFile: 'onnx/model.onnx',
      onnxDigest: null,
      tokenizerFile: 'tokenizer.json',
      tokenizerDigest: null,
      files: [],
    });
    expect(embeddingProfileArtifacts(pinned)).toEqual({
      onnxFile: 'onnx/model.onnx',
      onnxDigest: DIGEST_A,
      tokenizerFile: 'tokenizer.json',
      tokenizerDigest: DIGEST_B,
      files: [],
    });
  });

  it('rejects a malformed digest inside a profile', () => {
    const bad = variant({ model: { ...BASE.model, onnxDigest: 'a'.repeat(64) } });
    expect(KnowledgeEmbeddingProfileSchema.safeParse(bad).success).toBe(false);
  });
});

describe('sameVectorSpace', () => {
  it('ignores the label and the compile-time token bound', () => {
    expect(sameVectorSpace(BASE, variant({ id: 'other@9', maxTokens: 256 }))).toBe(true);
  });

  it('treats an absent onnx file as the default full-precision graph', () => {
    expect(
      sameVectorSpace(BASE, variant({ model: { ...BASE.model, onnxFile: 'onnx/model.onnx' } })),
    ).toBe(true);
    expect(
      sameVectorSpace(
        BASE,
        variant({ model: { ...BASE.model, onnxFile: 'onnx/model_fp16.onnx' } }),
      ),
    ).toBe(false);
  });

  it('compares digests only when both sides declare one', () => {
    const pinnedA = variant({ model: { ...BASE.model, onnxDigest: DIGEST_A } });
    const pinnedB = variant({ model: { ...BASE.model, onnxDigest: DIGEST_B } });
    expect(sameVectorSpace(BASE, pinnedA)).toBe(true);
    expect(sameVectorSpace(pinnedA, pinnedA)).toBe(true);
    expect(sameVectorSpace(pinnedA, pinnedB)).toBe(false);
    const tokA = variant({ tokenizer: { kind: 'wordpiece-bert', digest: DIGEST_A } });
    const tokB = variant({ tokenizer: { kind: 'wordpiece-bert', digest: DIGEST_B } });
    expect(sameVectorSpace(BASE, tokA)).toBe(true);
    expect(sameVectorSpace(tokA, tokB)).toBe(false);
  });

  it('separates spaces on every identity field', () => {
    const differing: Array<Partial<KnowledgeEmbeddingProfile>> = [
      { model: { ...BASE.model, repo: 'owner/other' } },
      { model: { ...BASE.model, revision: 'd'.repeat(40) } },
      { tokenizer: { kind: 'sentencepiece-xlmr' } },
      { tokenizer: { kind: 'wordpiece-bert', file: 'spm/tokenizer.json' } },
      { pooling: 'cls' },
      { normalized: false },
      { dimensions: 768 },
      { queryInstruction: '' },
      { passageInstruction: '' },
    ];
    for (const patch of differing) {
      expect(sameVectorSpace(BASE, variant(patch))).toBe(false);
    }
    // The same quantization block written out again is still the same space.
    const rewritten = variant({
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    });
    expect(sameVectorSpace(BASE, rewritten)).toBe(true);
  });
});

describe('centered-sign', () => {
  const CENTER = Array.from({ length: 384 }, (_, i) => (i % 2 ? 0.05 : -0.05));
  const centered = variant({
    id: 'example@2',
    quantization: {
      int8: { method: 'symmetric-linear', scale: 127 },
      binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center: CENTER },
    },
  });

  it('parses a centered-sign profile whose center matches the dimension', () => {
    expect(KnowledgeEmbeddingProfileSchema.safeParse(centered).success).toBe(true);
    expect(embeddingProfileCenterProblem(centered)).toBeNull();
    expect(embeddingProfileCenter(centered)).toEqual(Float32Array.from(CENTER));
  });

  it('a plain sign profile has no center', () => {
    expect(embeddingProfileCenter(BASE)).toBeNull();
    expect(embeddingProfileCenterProblem(BASE)).toBeNull();
  });

  it('refuses centered-sign without a center, or with the wrong length', () => {
    const missing = variant({
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first' },
      },
    });
    const short = variant({
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'centered-sign', threshold: 0, packing: 'lsb-first', center: [0.1, 0.2] },
      },
    });
    for (const bad of [missing, short]) {
      expect(KnowledgeEmbeddingProfileSchema.safeParse(bad).success).toBe(false);
      expect(embeddingProfileCenterProblem(bad)).not.toBeNull();
      expect(() => embeddingProfileCenter(bad)).toThrow(/center/);
    }
  });

  it('refuses a center on a plain sign profile and an unknown method', () => {
    const stray = variant({
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first', center: CENTER },
      },
    });
    expect(KnowledgeEmbeddingProfileSchema.safeParse(stray).success).toBe(false);
    const unknown = {
      ...BASE,
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'median-sign', threshold: 0, packing: 'lsb-first' },
      },
    };
    expect(KnowledgeEmbeddingProfileSchema.safeParse(unknown).success).toBe(false);
  });

  it('shares the vector space of the plain revision: only the bit scan differs', () => {
    expect(sameVectorSpace(BASE, centered)).toBe(true);
    expect(sameVectorSpace(centered, BASE)).toBe(true);
  });
});

describe('0.8 vocabulary', () => {
  const truncated = variant({
    dimensions: 256,
    truncation: { method: 'prefix', sourceDimensions: 384 },
  });
  const sidecar = { path: 'onnx/model_quantized.onnx_data', digest: DIGEST_A };
  const withFiles = variant({ model: { ...BASE.model, files: [sidecar] } });
  const encoder = { onnxFile: 'onnx/vision_encoder_quantized.onnx' };
  const image = {
    encoder,
    tokenBudget: 280,
    resample: 'bicubic',
    alpha: 'composite-white',
  } as const;

  it('parses truncation and reports the width the model emits', () => {
    expect(KnowledgeEmbeddingProfileSchema.safeParse(truncated).success).toBe(true);
    expect(embeddingProfileSourceDimensions(truncated)).toBe(384);
    expect(embeddingProfileSourceDimensions(BASE)).toBe(384);
  });

  it('refuses a truncation that does not narrow, or on an unnormalized profile', () => {
    for (const bad of [
      variant({ truncation: { method: 'prefix', sourceDimensions: 384 } }),
      variant({ dimensions: 512, truncation: { method: 'prefix', sourceDimensions: 384 } }),
      variant({
        dimensions: 256,
        normalized: false,
        truncation: { method: 'prefix', sourceDimensions: 384 },
      }),
    ]) {
      expect(KnowledgeEmbeddingProfileSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('lists pinned extra files as artifacts', () => {
    expect(embeddingProfileArtifacts(withFiles).files).toEqual([sidecar]);
    const undigested = variant({ model: { ...BASE.model, files: [{ path: 'config.json' }] } });
    expect(embeddingProfileArtifacts(undigested).files).toEqual([
      { path: 'config.json', digest: null },
    ]);
  });

  it('requires an image block before a video block, and at least one modality', () => {
    const ok = variant({
      media: { image, video: { framesPerSecond: 1, maxFrames: 32, tokenBudgetPerFrame: 140 } },
    });
    expect(KnowledgeEmbeddingProfileSchema.safeParse(ok).success).toBe(true);
    const videoOnly = variant({
      media: { video: { framesPerSecond: 1, maxFrames: 32, tokenBudgetPerFrame: 140 } },
    });
    expect(KnowledgeEmbeddingProfileSchema.safeParse(videoOnly).success).toBe(false);
    expect(KnowledgeEmbeddingProfileSchema.safeParse(variant({ media: {} })).success).toBe(false);
  });

  it('names 0.8 as the minimum format for any new field, and 0.5 otherwise', () => {
    expect(embeddingProfileMinimumFormat(BASE)).toBe('0.5');
    expect(embeddingProfileMinimumFormat(truncated)).toBe('0.8');
    expect(embeddingProfileMinimumFormat(withFiles)).toBe('0.8');
    expect(embeddingProfileMinimumFormat(variant({ media: { image } }))).toBe('0.8');
  });

  it('separates spaces on truncation and on disagreeing file digests, not on media', () => {
    expect(sameVectorSpace(BASE, truncated)).toBe(false);
    const wider = variant({
      dimensions: 256,
      truncation: { method: 'prefix', sourceDimensions: 512 },
    });
    expect(sameVectorSpace(truncated, wider)).toBe(false);
    expect(sameVectorSpace(truncated, { ...truncated, id: 'other@1' })).toBe(true);
    const otherWeights = variant({
      model: { ...BASE.model, files: [{ ...sidecar, digest: DIGEST_B }] },
    });
    expect(sameVectorSpace(withFiles, otherWeights)).toBe(false);
    expect(sameVectorSpace(withFiles, BASE)).toBe(true);
    expect(sameVectorSpace(BASE, variant({ media: { image } }))).toBe(true);
  });
});
