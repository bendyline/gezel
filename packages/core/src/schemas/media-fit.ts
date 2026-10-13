import { z } from 'zod';

/**
 * Wire shapes for "can this machine run that media model?" — the answer the
 * image and video download pages, the first-run media picker, the CLI
 * bootstrap and the pull routes all read. Computed by the daemon (it owns the
 * capacity budget the launch path admits against), priced by
 * `media-memory.ts`. Contract: docs/media-model-memory.md.
 */

/**
 * Where an engine keeps a model's weights on this machine.
 *
 * - `discrete` — a graphics card with its own memory (CUDA, Vulkan).
 * - `unified` — one pool shared by processor and accelerator (Apple Silicon,
 *   DGX Spark, integrated graphics).
 * - `cpu` — the engine runs on the processor; nothing lives on a GPU.
 */
export const MediaMemoryPoolSchema = z.enum(['discrete', 'unified', 'cpu']);
export type MediaMemoryPool = z.infer<typeof MediaMemoryPoolSchema>;

/**
 * - `fits` — the daemon admits it and nothing suggests it runs short.
 * - `tight` — the weights fit this card, but generation's working memory may
 *   not; a warning, never a block.
 * - `over-limit` — fits this machine but not the engine memory limit the
 *   person set in Settings. Raising the limit makes it fit.
 * - `may-not-run` — the catalog entry does not pin every weight file's
 *   precision, and the likely size does not fit. Warn, don't block: the
 *   smallest plausible size still fits.
 * - `wont-run` — the daemon's own admission check refuses it on this machine
 *   whatever else is running, or its weights exceed the physical memory of
 *   the pool they must sit in. Hidden from the download pages and refused by
 *   the pull routes.
 */
export const MediaFitVerdictSchema = z.enum([
  'fits',
  'tight',
  'over-limit',
  'may-not-run',
  'wont-run',
]);
export type MediaFitVerdict = z.infer<typeof MediaFitVerdictSchema>;

export const MediaFitAssessmentSchema = z.object({
  verdict: MediaFitVerdictSchema,
  pool: MediaMemoryPoolSchema,
  /** Weights at the precision the engine loads them in. */
  weightBytes: z.number().nonnegative(),
  /** Peak working set across every pool: weights plus working memory. */
  bytes: z.number().nonnegative(),
  /** What must sit in graphics memory at once (0 on the processor). */
  gpuBytes: z.number().nonnegative(),
  /** Every weight file's stored precision is known, from the catalog or from disk. */
  exact: z.boolean(),
  /** The binding requirement and what this machine offers against it — for copy. */
  neededBytes: z.number().nonnegative(),
  availableBytes: z.number().nonnegative(),
  /** One sentence a person can act on; empty for a plain `fits`. */
  reason: z.string(),
});
export type MediaFitAssessment = z.infer<typeof MediaFitAssessmentSchema>;

export const MediaModelFitSchema = MediaFitAssessmentSchema.extend({
  /** Catalog id of the model. */
  id: z.string(),
});
export type MediaModelFit = z.infer<typeof MediaModelFitSchema>;

/** `GET /api/image-gen/models/fit` and `GET /api/video-gen/models/fit`. */
export const MediaModelFitResponseSchema = z.object({
  pool: MediaMemoryPoolSchema,
  /** What the device ledger admits at most on this machine, before the person's own limit. */
  budgetBytes: z.number().nonnegative(),
  gpuBudgetBytes: z.number().nonnegative(),
  totalRamBytes: z.number().nonnegative(),
  models: z.array(MediaModelFitSchema),
});
export type MediaModelFitResponse = z.infer<typeof MediaModelFitResponseSchema>;

/**
 * Error code the pull routes answer (409) when the requested model is
 * `wont-run` on this machine.
 */
export const MEDIA_MODEL_WONT_RUN_CODE = 'media_model_wont_run';
