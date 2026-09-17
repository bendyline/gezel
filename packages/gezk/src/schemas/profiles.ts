import { z } from 'zod';

/**
 * Vector encodings a catalog may ship. `bit+int8` is the two-stage encoding:
 * sign bits for a hamming pre-filter plus int8 for the cosine rerank. A new
 * encoding is a new enum value; readers reject values they do not implement.
 */
export const KnowledgeVectorEncodingSchema = z.enum(['bit+int8']);
export type KnowledgeVectorEncoding = z.infer<typeof KnowledgeVectorEncodingSchema>;

/**
 * A model-artifact digest: `sha256:` plus 64 lowercase hex digits. The
 * algorithm travels with the value because, unlike the manifest's `sha256`
 * keys, the field names (`onnxDigest`, `digest`) do not name it. Hugging
 * Face's LFS object id for a file is exactly this sha256, so a pin can be
 * checked against the Hub's file metadata without downloading the file.
 */
export const ArtifactDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'artifact digest must be sha256:<64 lowercase hex>');

/** A path inside a model repository: forward slashes, no `..`, no leading `/`. */
export const RepoRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a repo-relative path',
  );

/** The ONNX graph a profile pins when `model.onnxFile` is absent (full precision). */
export const DEFAULT_EMBEDDING_ONNX_FILE = 'onnx/model.onnx';
/** The tokenizer definition a profile pins when `tokenizer.file` is absent. */
export const DEFAULT_EMBEDDING_TOKENIZER_FILE = 'tokenizer.json';

/**
 * The FULL vector-space identity of a catalog's embeddings, self-describing
 * so any reader can reproduce query vectors: the model by Hugging Face
 * coordinates, the tokenizer, pooling, normalization, dimensions, the
 * instruction prefixes, and the exact quantization. Matching only a model
 * name or a dimension is unsafe — two 384-dim models do not share a space,
 * and an instruction-prefix change silently changes vectors.
 */
const KnowledgeEmbeddingProfileObject = z.object({
  /** e.g. `multilingual-e5-small@1`. A new model, prefix or encoding is a new id. */
  id: z.string().min(1),
  model: z.object({
    /** Hugging Face repo id (`owner/name`). */
    repo: z.string().min(1),
    /** Commit sha or tag the vectors were produced with. */
    revision: z.string().min(1),
    /**
     * Repo-relative path of the ONNX graph the vectors were produced with;
     * defaults to `onnx/model.onnx`, the full-precision graph. The precision
     * variant is part of the vector space: fp16 or int8 weights move the
     * floats, and with them the sign bits and int8 codes at the margins.
     */
    onnxFile: RepoRelativePathSchema.optional(),
    /** sha256 of that file's bytes at `revision`. */
    onnxDigest: ArtifactDigestSchema.optional(),
  }),
  tokenizer: z.object({
    kind: z.string().min(1),
    /** Repo-relative path of the tokenizer definition; defaults to `tokenizer.json`. */
    file: RepoRelativePathSchema.optional(),
    /** sha256 of that file's bytes at `revision`. */
    digest: ArtifactDigestSchema.optional(),
  }),
  pooling: z.enum(['mean', 'cls', 'last']),
  normalized: z.boolean(),
  dimensions: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  queryInstruction: z.string(),
  passageInstruction: z.string(),
  vectorEncoding: KnowledgeVectorEncodingSchema,
  distance: z.object({
    stage1: z.literal('hamming'),
    stage2: z.literal('cosine'),
  }),
  quantization: z.object({
    int8: z.object({
      method: z.literal('symmetric-linear'),
      scale: z.literal(127),
    }),
    /**
     * The stage-1 sign bits. `sign` takes them straight from the unit
     * vector. `centered-sign` takes them from `vector − center`, where
     * `center` is a fixed vector the profile pins (length = `dimensions`).
     *
     * Why a center exists: some embedding models put most of every vector
     * on one shared direction (multilingual-e5-small: unrelated passages
     * sit at cosine ≈ 0.8 and the corpus mean has norm ≈ 0.87). The sign
     * of a dimension is then decided by that shared component rather than
     * by the passage, hamming distance stops tracking cosine, and stage 1
     * discards the true neighbours before the int8 rerank can see them.
     * Subtracting the center first restores the correlation. The int8
     * vectors are untouched either way, so query vectors stay comparable
     * across both methods; only how the bits are derived differs.
     */
    binary: z.object({
      method: z.enum(['sign', 'centered-sign']),
      threshold: z.literal(0),
      packing: z.literal('lsb-first'),
      /** Required by `centered-sign`, refused by `sign`; one entry per dimension. */
      center: z.array(z.number()).optional(),
    }),
  }),
});
export type KnowledgeEmbeddingProfile = z.infer<typeof KnowledgeEmbeddingProfileObject>;

/**
 * The cross-field rule the object schema cannot express on its own: a
 * `centered-sign` profile must carry a center of exactly `dimensions`
 * entries, and a `sign` profile must not carry one. Returns the problem, or
 * null when the profile is consistent.
 */
export function embeddingProfileCenterProblem(profile: KnowledgeEmbeddingProfile): string | null {
  const { method, center } = profile.quantization.binary;
  if (method === 'centered-sign') {
    if (!center) return 'centered-sign requires quantization.binary.center';
    if (center.length !== profile.dimensions) {
      return `quantization.binary.center has ${center.length} entries, dimensions is ${profile.dimensions}`;
    }
    return null;
  }
  return center ? 'quantization.binary.center is only valid with method centered-sign' : null;
}

/** The profile's binary center as a Float32Array, or null for a plain `sign` profile. */
export function embeddingProfileCenter(profile: KnowledgeEmbeddingProfile): Float32Array | null {
  const problem = embeddingProfileCenterProblem(profile);
  if (problem) throw new Error(`invalid embedding profile ${profile.id}: ${problem}`);
  const { center } = profile.quantization.binary;
  return center ? Float32Array.from(center) : null;
}

/** The profile schema proper: the object shape plus the center rule above. */
export const KnowledgeEmbeddingProfileSchema = KnowledgeEmbeddingProfileObject.superRefine(
  (profile, ctx) => {
    const problem = embeddingProfileCenterProblem(profile);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        message: problem,
        path: ['quantization', 'binary', 'center'],
      });
    }
  },
);

/** The exact repo files a profile pins, with the format defaults applied. */
export function embeddingProfileArtifacts(profile: KnowledgeEmbeddingProfile): {
  onnxFile: string;
  onnxDigest: string | null;
  tokenizerFile: string;
  tokenizerDigest: string | null;
} {
  return {
    onnxFile: profile.model.onnxFile ?? DEFAULT_EMBEDDING_ONNX_FILE,
    onnxDigest: profile.model.onnxDigest ?? null,
    tokenizerFile: profile.tokenizer.file ?? DEFAULT_EMBEDDING_TOKENIZER_FILE,
    tokenizerDigest: profile.tokenizer.digest ?? null,
  };
}

/**
 * Whether two profiles describe one vector space, so vectors from either
 * may be compared: same model files at the same revision, same tokenizer,
 * pooling, normalization, dimensions, instruction prefixes, encoding and
 * int8 quantization. The profile id and `maxTokens` are not compared — the
 * first is a label, the second a compile-time bound. A digest counts only
 * when both sides declare one: two pins at one revision that hash
 * differently name different artifacts, whatever the path says; an
 * undeclared digest is simply not a claim.
 *
 * The binary (stage-1) parameters are deliberately NOT compared. They
 * describe how a catalog derived its own pre-filter bits, and a reader
 * applies them from the catalog's profile echo; they never change what a
 * query vector is. A daemon that shares a model with a `sign` profile
 * therefore also shares it with the `centered-sign` revision of the same
 * model — same floats in, same int8 rerank, only the bit scan differs.
 */
export function sameVectorSpace(
  a: KnowledgeEmbeddingProfile,
  b: KnowledgeEmbeddingProfile,
): boolean {
  const aa = embeddingProfileArtifacts(a);
  const ab = embeddingProfileArtifacts(b);
  const digestsAgree = (x: string | null, y: string | null): boolean => !x || !y || x === y;
  return (
    a.model.repo === b.model.repo &&
    a.model.revision === b.model.revision &&
    aa.onnxFile === ab.onnxFile &&
    digestsAgree(aa.onnxDigest, ab.onnxDigest) &&
    a.tokenizer.kind === b.tokenizer.kind &&
    aa.tokenizerFile === ab.tokenizerFile &&
    digestsAgree(aa.tokenizerDigest, ab.tokenizerDigest) &&
    a.pooling === b.pooling &&
    a.normalized === b.normalized &&
    a.dimensions === b.dimensions &&
    a.queryInstruction === b.queryInstruction &&
    a.passageInstruction === b.passageInstruction &&
    a.vectorEncoding === b.vectorEncoding &&
    a.distance.stage1 === b.distance.stage1 &&
    a.distance.stage2 === b.distance.stage2 &&
    a.quantization.int8.method === b.quantization.int8.method &&
    a.quantization.int8.scale === b.quantization.int8.scale
  );
}

/**
 * How documents were split. `unit` names what `target`, `overlap` and the
 * context-header budget count: tokens of the embedding profile's tokenizer
 * (`tokenizer: 'profile'`) or characters (`tokenizer: 'none'`).
 */
export const KnowledgeChunkingProfileSchema = z.object({
  /** e.g. `markdown-chunks@2`. */
  id: z.string().min(1),
  unit: z.enum(['tokens', 'chars']),
  tokenizer: z.enum(['profile', 'none']),
  target: z.number().int().positive(),
  overlap: z.number().int().nonnegative(),
  contextHeader: z.object({ max: z.number().int().nonnegative() }),
});
export type KnowledgeChunkingProfile = z.infer<typeof KnowledgeChunkingProfileSchema>;
