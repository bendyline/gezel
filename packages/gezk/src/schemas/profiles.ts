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
 * One more file the runtime loads beside the graph and the tokenizer (0.8).
 * Large graphs keep their weights in an external-data sidecar
 * (`onnx/model.onnx_data`), so a digest of the graph file alone pins a
 * header and none of the weights; configs that steer loading belong here too.
 */
export const EmbeddingModelFileSchema = z.object({
  path: RepoRelativePathSchema,
  digest: ArtifactDigestSchema.optional(),
});
export type EmbeddingModelFile = z.infer<typeof EmbeddingModelFileSchema>;

/** A media encoder graph in the profile's model repository, pinned like the text graph. */
const EmbeddingMediaEncoderSchema = z.object({
  onnxFile: RepoRelativePathSchema,
  onnxDigest: ArtifactDigestSchema.optional(),
  files: z.array(EmbeddingModelFileSchema).optional(),
});

/**
 * How a multimodal profile turned media into vectors (0.8). Query vectors
 * depend only on the text side, so none of this enters `sameVectorSpace`;
 * it is the provenance a builder needs to reproduce a catalog's media rows,
 * and the settings media floors are calibrated against.
 */
export const EmbeddingMediaSchema = z
  .object({
    image: z
      .object({
        encoder: EmbeddingMediaEncoderSchema,
        /** Vision tokens per image; changing it moves every image vector. */
        tokenBudget: z.number().int().positive(),
        resample: z.enum(['bilinear', 'bicubic']),
        /** Transparent pixels are composited onto white before encoding. */
        alpha: z.literal('composite-white'),
      })
      .optional(),
    /** Video frames go through the image encoder, so `video` requires `image`. */
    video: z
      .object({
        framesPerSecond: z.number().positive(),
        maxFrames: z.number().int().positive(),
        tokenBudgetPerFrame: z.number().int().positive(),
      })
      .optional(),
    audio: z
      .object({
        encoder: EmbeddingMediaEncoderSchema,
        sampleRate: z.number().int().positive(),
        channels: z.literal(1),
        /** Longest window one audio row may cover. */
        maxWindowMs: z.number().int().positive(),
      })
      .optional(),
  })
  .refine((media) => Boolean(media.image || media.video || media.audio), {
    message: 'media must describe at least one modality',
  })
  .refine((media) => !media.video || Boolean(media.image), {
    message: 'media.video requires media.image (frames go through the image encoder)',
    path: ['video'],
  });
export type EmbeddingMedia = z.infer<typeof EmbeddingMediaSchema>;

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
    /** Every further file the runtime loads: weight sidecars, configs (0.8). */
    files: z.array(EmbeddingModelFileSchema).optional(),
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
  /** The stored vector width — after truncation, when the profile truncates. */
  dimensions: z.number().int().positive(),
  /**
   * Matryoshka truncation (0.8): the model emits `sourceDimensions` values,
   * the first `dimensions` are kept, and the result is L2-normalized again.
   * One rule for passages, queries and media; `profileUnitVector` owns it.
   */
  truncation: z
    .object({
      method: z.literal('prefix'),
      sourceDimensions: z.number().int().positive(),
    })
    .optional(),
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
  media: EmbeddingMediaSchema.optional(),
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

/**
 * Truncation keeps a strict prefix of a unit vector and re-normalizes, so it
 * needs a source wider than the stored width and a normalized profile.
 */
export function embeddingProfileTruncationProblem(
  profile: KnowledgeEmbeddingProfile,
): string | null {
  if (!profile.truncation) return null;
  if (profile.truncation.sourceDimensions <= profile.dimensions) {
    return `truncation.sourceDimensions (${profile.truncation.sourceDimensions}) must exceed dimensions (${profile.dimensions})`;
  }
  return profile.normalized ? null : 'truncation requires a normalized profile';
}

/** The width the model itself emits: `truncation.sourceDimensions`, else `dimensions`. */
export function embeddingProfileSourceDimensions(profile: KnowledgeEmbeddingProfile): number {
  return profile.truncation?.sourceDimensions ?? profile.dimensions;
}

/**
 * The oldest format version that can describe this profile. Truncation,
 * pinned extra files and a media block are 0.8 vocabulary: an older reader's
 * strip-mode schema would drop them without a word and then embed queries the
 * wrong way, so a catalog using any of them must refuse to open there instead.
 */
export function embeddingProfileMinimumFormat(profile: KnowledgeEmbeddingProfile): '0.5' | '0.8' {
  return profile.truncation || profile.model.files || profile.media ? '0.8' : '0.5';
}

/** The profile schema proper: the object shape plus the cross-field rules above. */
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
    const truncation = embeddingProfileTruncationProblem(profile);
    if (truncation) {
      ctx.addIssue({ code: 'custom', message: truncation, path: ['truncation'] });
    }
  },
);

/** The exact repo files a profile pins, with the format defaults applied. */
export function embeddingProfileArtifacts(profile: KnowledgeEmbeddingProfile): {
  onnxFile: string;
  onnxDigest: string | null;
  tokenizerFile: string;
  tokenizerDigest: string | null;
  /** Further text-model files (sidecars, configs), in the profile's order. */
  files: Array<{ path: string; digest: string | null }>;
} {
  return {
    onnxFile: profile.model.onnxFile ?? DEFAULT_EMBEDDING_ONNX_FILE,
    onnxDigest: profile.model.onnxDigest ?? null,
    tokenizerFile: profile.tokenizer.file ?? DEFAULT_EMBEDDING_TOKENIZER_FILE,
    tokenizerDigest: profile.tokenizer.digest ?? null,
    files: (profile.model.files ?? []).map((f) => ({ path: f.path, digest: f.digest ?? null })),
  };
}

/**
 * Whether two profiles describe one vector space, so vectors from either
 * may be compared: same model files at the same revision, same tokenizer,
 * pooling, normalization, dimensions, instruction prefixes, encoding and
 * int8 quantization, and the same truncation from the same source width. The
 * profile id and `maxTokens` are not compared — the first is a label, the
 * second a compile-time bound. A digest counts only when both sides declare
 * one: two pins at one revision that hash differently name different
 * artifacts, whatever the path says; an undeclared digest is simply not a
 * claim. Extra `model.files` follow the same rule, path by path.
 *
 * The `media` block is not compared either: a text query vector is valid
 * against a catalog's media rows however their pixels or samples were
 * encoded.
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
  const bFiles = new Map(ab.files.map((f) => [f.path, f.digest]));
  const filesAgree = aa.files.every(
    (f) => !bFiles.has(f.path) || digestsAgree(f.digest, bFiles.get(f.path) ?? null),
  );
  return (
    filesAgree &&
    a.truncation?.method === b.truncation?.method &&
    embeddingProfileSourceDimensions(a) === embeddingProfileSourceDimensions(b) &&
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
