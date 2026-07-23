import { z } from 'zod';

/**
 * Wire schemas for the image-generation feature. The shape is intentionally
 * provider-agnostic — the service routes each request through whichever
 * `ImageProvider` is active (mock for tests, stable-diffusion.cpp in prod).
 */

/**
 * One source image fed alongside the prompt for image editing /
 * reference-driven generation. Either `data` (base64) or
 * `artifactPath` (project-relative path resolved server-side). Image
 * generation APIs are stateless one-shot calls — every input image is
 * carried in the same request as the prompt.
 *
 * Supported by all providers except the local sd-cpp engine in the
 * default configuration; cloud providers (Google Nano Banana 2,
 * OpenAI GPT Image 2) accept multiple input images for compositing
 * use cases.
 */
export const ImageInputSourceSchema = z.union([
  z.object({
    data: z.string().min(1),
    mimeType: z.string().default('image/png'),
  }),
  z.object({
    artifactPath: z.string().min(1),
  }),
]);
export type ImageInputSource = z.infer<typeof ImageInputSourceSchema>;

export const ImageGenerationRequestSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  /** Catalog/manifest id of the model to use. When absent, the provider
   *  falls back to the currently-selected default. */
  model: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  /**
   * Source images for editing / reference-driven generation. Each
   * entry is either base64 bytes + mime, OR an artifact path that the
   * service resolves to bytes (project-relative; e.g. a previous
   * `generate_image` output). Cloud providers accept multiple
   * references; sd-cpp uses the first (img2img is a single-image op).
   */
  inputImages: z.array(ImageInputSourceSchema).optional(),
  /**
   * Strength of edit when an input image is supplied — 0 keeps the
   * source intact, 1 effectively ignores it. Provider-specific:
   * sd-cpp passes through to img2img; cloud providers ignore it.
   */
  strength: z.number().min(0).max(1).optional(),
  /** Project the output artifact belongs to. Defaults to 'default'. */
  projectId: z.string().optional(),
  /**
   * The gezel + session originating this generation. Required for the
   * cloud-image cost-confirmation gate (synthesized question is pinned
   * to this scope). MCP `generate_image` populates these from
   * GEZEL_AGENT_ID / GEZEL_SESSION_ID; direct UI/CLI callers can omit
   * to skip the gate (the user is presumably on the page that issued
   * the call).
   */
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
  /**
   * Set to true to receive the generated PNG inline (base64) on the
   * response, in addition to the artifact write. Used by the MCP
   * `generate_image` tool so the bridge can attach the bytes as a
   * tool-call image content block — the chat thumbnail pipeline
   * handles persistence + rendering from there.
   */
  inline: z.boolean().optional(),
  /**
   * Optional workspace-relative path to write the workspace copy at,
   * e.g. `logo.png` or `assets/hero.png`. When set, the workspace copy
   * lands at exactly that path (instead of the default seed-keyed
   * `assets/generated/image-<seed>.png`) and the response's
   * `workspacePath` reflects it. The artifact copy still uses the
   * default timestamped name as the canonical audit trail.
   *
   * Why this exists: when one gezel generates an image and a second
   * writes HTML referencing it, the writer never sees the seed-keyed
   * filename and ends up guessing (`logo.png`, `hero.jpg`, …). The
   * qwen3.6 petshop trial wrote `<img src="logo.png">`
   * against an actual `image-547926527.png` — both pieces existed but
   * didn't link. `saveAs` lets the orchestrator pin the name up front
   * so both halves agree.
   *
   * Safety: must be a relative path with no `..` segments and an
   * image extension (`.png` / `.jpg` / `.jpeg` / `.webp`); rejected
   * otherwise. Existing files at the same path are overwritten — the
   * caller is asking for a specific name.
   */
  saveAs: z.string().optional(),
});
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;

export const ImageGenerationMetaSchema = z.object({
  model: z.string(),
  seed: z.number().int(),
  steps: z.number().int(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
});
export type ImageGenerationMeta = z.infer<typeof ImageGenerationMetaSchema>;

export const ImageGenerationResponseSchema = z.object({
  /** Relative path under the project's `artifacts/` tree. */
  artifactPath: z.string(),
  /**
   * Relative path under the project's `workspace/` tree of a duplicate
   * copy written for HTML/CSS to reference (e.g. `assets/generated/X.png`).
   * `null` when the workspace copy was skipped — typically because the
   * project has an external `workingDir` the user hasn't approved for
   * writes. Callers writing HTML should embed this path, not the
   * artifact path: `<img src="${workspacePath}">`. The artifact copy
   * remains as the canonical audit trail.
   */
  workspacePath: z.string().nullable(),
  meta: ImageGenerationMetaSchema,
  /**
   * The generated PNG, base64-encoded. Set when the caller asks for
   * inline bytes via `inline: true` (the MCP `generate_image` tool
   * does this so the bridge can attach the image as a tool-call
   * thumbnail in chat). Direct UI callers leave it undefined to keep
   * the JSON envelope small — they render from the artifact path
   * via the authenticated artifact-blob endpoint instead.
   */
  b64Png: z.string().optional(),
});
export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;

export const InstalledImageModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Bytes on disk for local models. Cloud-provider entries report `0`
   * — model weights are remote and not user-managed, so there's nothing
   * to size.
   */
  approxSizeBytes: z.number().int().nonnegative(),
  installedAt: z.string(),
  /** `'local'` for sd-cpp/mock, `'cloud'` for Google/OpenAI. Optional for
   *  back-compat with older responses. */
  kind: z.enum(['local', 'cloud']).optional(),
});
export type InstalledImageModel = z.infer<typeof InstalledImageModelSchema>;

export const ListInstalledImageModelsResponseSchema = z.object({
  models: z.array(InstalledImageModelSchema),
  defaultModel: z.string().optional(),
});
export type ListInstalledImageModelsResponse = z.infer<
  typeof ListInstalledImageModelsResponseSchema
>;

/**
 * Engine health envelope returned by `GET /api/image-gen/engine-status`.
 * Combines the live engine probe (reachable / unreachable / not-configured)
 * with the on-disk model count so the Settings UI can render an honest
 * readiness pill in one round-trip.
 */
export const ImageEngineStatusResponseSchema = z.object({
  engine: z.object({
    status: z.enum(['ok', 'unreachable', 'not-configured']),
    baseUrl: z.string(),
    error: z.string().optional(),
    /**
     * Provider taxonomy injected at the route layer so the UI can
     * branch (cloud → hide pull/delete, show static model list).
     * `'local'` covers sd-cpp + mock; `'cloud'` covers google-ai and
     * openai. Older clients ignore the field.
     */
    kind: z.enum(['local', 'cloud']).optional(),
    /** Provider name, e.g. 'sd-cpp', 'google-ai', 'openai', 'mock'. */
    provider: z.string().optional(),
  }),
  modelCount: z.number().int().nonnegative(),
});
export type ImageEngineStatusResponse = z.infer<typeof ImageEngineStatusResponseSchema>;

/**
 * Progress envelope streamed to the UI during `POST /api/image-gen/models/:id/pull`.
 * Terminal events are `error` (followed by `done`) or `done` alone.
 */
/**
 * Snapshot of one in-flight (or recently-finished) image-model pull.
 * Exposed by `GET /api/image-gen/pulls` so a UI that mounted after the
 * pull started can render a live progress bar without having to be the
 * client that kicked off the pull.
 */
export const ActiveImagePullSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  retrying: z
    .object({
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      delayMs: z.number().int().nonnegative(),
      reason: z.string(),
    })
    .optional(),
  finished: z.boolean(),
  error: z.string().optional(),
});
export type ActiveImagePull = z.infer<typeof ActiveImagePullSchema>;

export const ListActiveImagePullsResponseSchema = z.object({
  pulls: z.array(ActiveImagePullSchema),
});
export type ListActiveImagePullsResponse = z.infer<typeof ListActiveImagePullsResponseSchema>;

export const ImageModelPullEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    bytesWritten: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().optional(),
  }),
  /**
   * Surfaced when the shared `downloadWithRetry` helper hit a
   * transient network error and is about to try again. The UI
   * renders "Connection dropped — retrying in 4s (attempt 3/5)…"
   * instead of a fatal error banner. `reason` is already a
   * user-friendly sentence; don't wrap it.
   */
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    id: z.string(),
  }),
]);
export type ImageModelPullEvent = z.infer<typeof ImageModelPullEventSchema>;
