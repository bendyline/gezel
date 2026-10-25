import { z } from 'zod';
import { ImageAspectRatioSchema, ImageQualitySchema } from './image.js';
import { MediaFitVerdictSchema } from './media-fit.js';

/**
 * Local image generation for apps: `/v1/images/*` on hosted inference and,
 * behind the `images` scope, on the user daemon. Image models are listed
 * apart from `/v1/models` so they never reach a chat model picker. Installs
 * reuse the chat ensure shapes (`AppEnsureResultSchema`,
 * `AppEnsureEventSchema`) with `sd-cpp:<catalogId>` ids.
 */

const id = z.string().min(1).max(512);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pixels = z.number().int().positive().max(16_384);
const range = z.object({ min: pixels, max: pixels });

/** v1 permits additive server fields, but validates every field used for decisions. */
export const AppImageModelSchema = z
  .object({
    /** `sd-cpp:<catalogId>`. */
    id,
    object: z.literal('image_model'),
    name: z.string().max(512),
    description: z.string().max(4096).optional(),
    availability: z.enum(['available', 'download-required', 'downloading']),
    /**
     * Installed in a store this host reads but does not own (for example the
     * machine's shared models, or a standalone Gezel's home). It cannot be
     * removed from here.
     */
    shared: z.boolean().optional(),
    download_bytes: bytes.optional(),
    license: z.string().max(256).optional(),
    /** False when the license forbids commercial use. */
    commercial_use: z.boolean().optional(),
    /** Draws legible text, which design graphics depend on. */
    renders_text: z.boolean().optional(),
    /** How the model reads prompts: `sentences` or `tags`. */
    prompt_style: z.string().max(64).optional(),
    /** `standard`, `high` or `workstation`. */
    hardware_tier: z.string().max(64).optional(),
    min_ram_gb: z.number().nonnegative().max(100_000).optional(),
    width_range: range.optional(),
    height_range: range.optional(),
    default_side_px: pixels.optional(),
    supports_img2img: z.boolean().optional(),
    /** Whether this machine can run it. `wont-run` models are refused at install. */
    fit: z
      .object({
        verdict: MediaFitVerdictSchema,
        reason: z.string().max(4096),
      })
      .optional(),
  })
  .passthrough();
export const AppImageModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(AppImageModelSchema).max(1000),
});
export type AppImageModel = z.infer<typeof AppImageModelSchema>;
export type AppImageModelList = z.infer<typeof AppImageModelListSchema>;

export const AppImageGenerationRequestSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    negative_prompt: z.string().max(8000).optional(),
    /** `sd-cpp:<catalogId>` or a bare catalog id; the host's default when absent. */
    model: id.optional(),
    /** The host picks pixels inside the model's range. Square when absent. */
    aspect_ratio: ImageAspectRatioSchema.optional(),
    quality: ImageQualitySchema.optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();
export type AppImageGenerationRequest = z.infer<typeof AppImageGenerationRequestSchema>;

/**
 * Where a render is. The engine loads weights inside the first render after
 * it starts, and decodes in tiles after sampling; `step`/`total_steps` count
 * within the phase (both 0 while `queued`).
 */
export const AppImagePhaseSchema = z.enum(['queued', 'loading_model', 'sampling', 'decoding']);
export type AppImagePhase = z.infer<typeof AppImagePhaseSchema>;

/** The largest PNG the stream carries, base64-encoded. A 2048px render is far below it. */
export const APP_IMAGE_MAX_BASE64_CHARS = 48 * 1024 * 1024;

/** Server-sent events from `POST /v1/images/generations`: progress, then one `done` or `error`. */
export const AppImageGenerationEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    phase: AppImagePhaseSchema,
    step: bytes,
    total_steps: bytes,
    seconds_per_step: z.number().positive().max(1_000_000).optional(),
  }),
  z.object({
    type: z.literal('done'),
    b64_png: z.string().min(1).max(APP_IMAGE_MAX_BASE64_CHARS),
    width: pixels,
    height: pixels,
    seed: z.number().int().nonnegative(),
    /** `sd-cpp:<catalogId>`. */
    model: id,
    steps: bytes,
    duration_ms: bytes,
  }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      code: z.string().max(128),
      message: z.string().max(4096),
    }),
  }),
]);
export type AppImageGenerationEvent = z.infer<typeof AppImageGenerationEventSchema>;
