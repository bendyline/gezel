/**
 * Wire shapes for adding a model the catalog does not carry: from a Hugging
 * Face repository (GGUF for llama.cpp, or an MLX build) or from GGUF files on
 * this computer. A review says what the model is, which files, where its
 * settings come from, and whether it passes the checks; confirming records it
 * so the ordinary installer can fetch it (or, for local files, publishes the
 * copy already received). Contract in docs/model-imports.md.
 */

import { z } from 'zod';

export const ModelImportCheckIdSchema = z.enum([
  'access',
  'platform',
  'integrity',
  'format',
  'kind',
  'customCode',
  'architecture',
  'tensorTypes',
  'chatTemplate',
  'toolCalls',
  'context',
  'memory',
  'disk',
]);
export type ModelImportCheckId = z.infer<typeof ModelImportCheckIdSchema>;

export const ModelImportCheckStatusSchema = z.enum(['pass', 'warn', 'fail']);
export type ModelImportCheckStatus = z.infer<typeof ModelImportCheckStatusSchema>;

export const ModelImportCheckSchema = z.object({
  id: ModelImportCheckIdSchema,
  status: ModelImportCheckStatusSchema,
  /** Short label ("Engine support"). */
  title: z.string(),
  /** One or two sentences a person can act on. */
  detail: z.string(),
});
export type ModelImportCheck = z.infer<typeof ModelImportCheckSchema>;

export const ModelImportEngineSchema = z.enum(['llama-cpp', 'mlx']);
export type ModelImportEngine = z.infer<typeof ModelImportEngineSchema>;

/** What the review was asked about: a pasted link, or the parts a `gezel://` link carried. */
export const ModelImportReviewRequestSchema = z
  .object({
    /** Text a person pasted: a Hub URL, `owner/name`, or `owner/name:QUANT`. */
    reference: z.string().min(1).max(1024).optional(),
    repo: z.string().min(3).max(200).optional(),
    /** A GGUF file, or an MLX build's directory (`''` for the repo root). */
    file: z.string().max(512).optional(),
    quant: z.string().min(1).max(32).optional(),
    revision: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Boolean(v.reference) !== Boolean(v.repo), {
    message: 'send either reference or repo',
  });
export type ModelImportReviewRequest = z.infer<typeof ModelImportReviewRequestSchema>;

export const ModelImportFitSchema = z.object({
  tier: z.enum(['fits', 'fits-offload', 'tight', 'too-big']),
  label: z.string(),
  detail: z.string(),
  runnable: z.boolean(),
});

/** One file (or split set, or MLX build) the person can choose. */
export const ModelImportFileChoiceSchema = z.object({
  /** First file's repo path, or an MLX build's directory; what a choice is selected by. */
  key: z.string(),
  /** Quant tag read from the filename or config, when there is one. */
  quant: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().positive(),
  /** Fit on this machine, weights plus projector plus KV at the launch floor. */
  fit: ModelImportFitSchema.optional(),
});
export type ModelImportFileChoice = z.infer<typeof ModelImportFileChoiceSchema>;

export const ModelImportSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('huggingface'),
    repo: z.string(),
    /** The commit every pin in this review refers to. */
    revision: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('local-file'),
    /** The upload this review describes; confirm and cancel name it. */
    importId: z.string(),
    files: z.array(z.object({ name: z.string(), sizeBytes: z.number().int().nonnegative() })),
  }),
]);
export type ModelImportSource = z.infer<typeof ModelImportSourceSchema>;

/**
 * Where an imported model's settings come from. `catalog`: a tested catalog
 * entry built from the same base model lends its settings, live. `author`:
 * the sampling the model's author recommends. `defaults`: neither was found,
 * so the runtime's defaults for the model's size apply.
 */
export const ModelImportTuningSchema = z.object({
  from: z.enum(['catalog', 'author', 'defaults']),
  catalogId: z.string().optional(),
  catalogName: z.string().optional(),
});
export type ModelImportTuning = z.infer<typeof ModelImportTuningSchema>;

export const ModelImportReviewSchema = z.object({
  source: ModelImportSourceSchema,
  engine: ModelImportEngineSchema,
  /** The id the model will have in Gezel. */
  id: z.string(),
  name: z.string(),
  /** Who made or uploaded it, from the Hub and the file. */
  author: z.string().optional(),
  license: z.string().optional(),
  /** The selected choice's key. */
  selectedFile: z.string(),
  choices: z.array(ModelImportFileChoiceSchema),
  /** Vision projector downloaded with a GGUF model, when the repo ships one. */
  projector: z.object({ path: z.string(), sizeBytes: z.number().int().nonnegative() }).optional(),
  details: z.object({
    architecture: z.string().optional(),
    parameterSize: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    quantization: z.string().optional(),
    supportsTools: z.boolean(),
    thinks: z.boolean(),
    mixtureOfExperts: z.boolean(),
    vision: z.boolean().optional(),
  }),
  tuning: ModelImportTuningSchema,
  /** Bytes to download (or copy in): the chosen weights plus any projector. */
  downloadBytes: z.number().int().nonnegative(),
  checks: z.array(ModelImportCheckSchema),
  /** True when any check failed; the review offers no download. */
  blocked: z.boolean(),
  /** This exact choice is already on this computer under `id`. */
  alreadyInstalled: z.boolean(),
  /**
   * The catalog already carries these exact bytes, tuned and tested. The
   * review offers that entry instead of an untested copy.
   */
  catalogMatch: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type ModelImportReview = z.infer<typeof ModelImportReviewSchema>;

/** Confirm one reviewed choice. The revision must be the commit the review pinned. */
export const ModelImportConfirmRequestSchema = z.object({
  repo: z.string().min(3).max(200),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  /** The reviewed GGUF file, or MLX build directory (`''` for the root). */
  file: z.string().max(512),
});
export type ModelImportConfirmRequest = z.infer<typeof ModelImportConfirmRequestSchema>;

export const ModelImportConfirmResponseSchema = z.object({
  engine: ModelImportEngineSchema,
  /**
   * Install this id through the engine's ordinary model install route. For
   * files from this computer it is already installed.
   */
  id: z.string(),
  name: z.string(),
  installed: z.boolean().optional(),
});
export type ModelImportConfirmResponse = z.infer<typeof ModelImportConfirmResponseSchema>;

/** One file of a local import as it is received. */
export const LocalModelImportStatusSchema = z.object({
  importId: z.string(),
  files: z.array(
    z.object({
      name: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      complete: z.boolean(),
    }),
  ),
  /** Bytes received so far across every file. */
  bytesReceived: z.number().int().nonnegative(),
});
export type LocalModelImportStatus = z.infer<typeof LocalModelImportStatusSchema>;
