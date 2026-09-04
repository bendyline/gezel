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
export const KnowledgeEmbeddingProfileSchema = z.object({
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
    binary: z.object({
      method: z.literal('sign'),
      threshold: z.literal(0),
      packing: z.literal('lsb-first'),
    }),
  }),
});
export type KnowledgeEmbeddingProfile = z.infer<typeof KnowledgeEmbeddingProfileSchema>;

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
 * pooling, normalization, dimensions, instruction prefixes and encoding.
 * The profile id and `maxTokens` are not compared — the first is a label,
 * the second a compile-time bound. A digest counts only when both sides
 * declare one: two pins at one revision that hash differently name
 * different artifacts, whatever the path says; an undeclared digest is
 * simply not a claim.
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
    a.quantization.int8.scale === b.quantization.int8.scale &&
    a.quantization.binary.method === b.quantization.binary.method &&
    a.quantization.binary.threshold === b.quantization.binary.threshold &&
    a.quantization.binary.packing === b.quantization.binary.packing
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
