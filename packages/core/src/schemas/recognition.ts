import { z } from 'zod';

/**
 * Wire schemas for image recognition — turning an image into text the model
 * can actually read.
 *
 * Two tiers, and the split is load-bearing:
 *
 *  - **Static metadata** is deterministic, zero-dependency header parsing that
 *    always runs, even with no model installed and no GPU free. Format, size,
 *    PNG text chunks, a small EXIF subset. A ComfyUI PNG's `parameters` chunk
 *    is often a *better* description than any small model would write.
 *  - **Model output** is the description / OCR / structured extraction from a
 *    local vision model.
 *
 * Because tier one always succeeds, `status: 'static-only'` is a first-class
 * result rather than a failure — it is what the user gets before the model has
 * downloaded, when the capacity broker refuses the memory, or when the image is
 * too large to tile. The chat turn never fails over an image.
 */

/**
 * EXIF subset worth surfacing. Deliberately flattened and tiny rather than a
 * raw IFD tree: this text is injected into a model prompt, so every field here
 * costs attention at depth and has to earn its place.
 */
export const ImageExifSchema = z.object({
  make: z.string().optional(),
  model: z.string().optional(),
  lensModel: z.string().optional(),
  dateTimeOriginal: z.string().optional(),
  orientation: z.number().int().min(1).max(8).optional(),
  software: z.string().optional(),
  imageDescription: z.string().optional(),
});
export type ImageExif = z.infer<typeof ImageExifSchema>;

/**
 * Deterministic, model-free facts about an image file.
 *
 * `gps` is deliberately NOT part of {@link ImageExifSchema}. Keeping it in its
 * own field means the prompt renderer cannot include it by accident — it has to
 * reach for a differently-named property to leak it. A pasted phone photo
 * carries the user's location; they pasted it to ask a question, not to
 * broadcast where they were, and the digest may be forwarded to a cloud
 * provider. Coordinates are reachable only through an explicit MCP tool call,
 * which lands in the history log as `tool.called`.
 */
export const ImageStaticMetaSchema = z.object({
  format: z.enum(['png', 'jpeg', 'gif', 'webp', 'svg', 'unknown']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * PNG `tEXt`/`iTXt`/`zTXt` keyword→value pairs. Generation provenance lives
   * here (A1111 writes `parameters`, ComfyUI writes `prompt`/`workflow`) and
   * screenshot tools stamp `Software`.
   *
   * Attacker-controlled: anyone can author a PNG whose `Description` chunk
   * reads "Ignore previous instructions". Renderers MUST fence and cap this.
   */
  pngText: z.record(z.string(), z.string()).optional(),
  exif: ImageExifSchema.optional(),
  /** Withheld from every prompt. See the schema doc above. */
  gps: z.object({ lat: z.number(), lon: z.number() }).optional(),
  /** True when the file carried location data we deliberately dropped. */
  gpsRedacted: z.boolean().optional(),
  /**
   * Heuristic from dimensions, format, and metadata — drives `auto` mode
   * selection without paying a classifier call.
   */
  likelyScreenshot: z.boolean().optional(),
});
export type ImageStaticMeta = z.infer<typeof ImageStaticMetaSchema>;

/**
 * What we asked the vision model to do.
 *
 * `auto` is a *selector*, not a result — it resolves to one of these before the
 * model runs, and the resolved value is what gets persisted.
 */
export const RecognitionModeSchema = z.enum(['describe', 'ocr', 'ui', 'extract']);
export type RecognitionMode = z.infer<typeof RecognitionModeSchema>;

export const RecognitionModeRequestSchema = z.enum(['auto', 'describe', 'ocr', 'ui', 'extract']);
export type RecognitionModeRequest = z.infer<typeof RecognitionModeRequestSchema>;

/**
 * A complete recognition record, keyed by the image's content hash.
 *
 * `modes` + `modelId` + `schemaVersion` together make the record
 * *invalidatable*: "we have a digest, but it came from `describe` on the 2B and
 * the user is now asking about text in the screenshot" is an answerable
 * question rather than a guess.
 */
export const ImageRecognitionSchema = z.object({
  schemaVersion: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  meta: ImageStaticMetaSchema,
  modes: z.array(RecognitionModeSchema).min(1),
  description: z.string().optional(),
  ocrText: z.string().optional(),
  structured: z
    .object({
      templateId: z.string().optional(),
      data: z.unknown(),
    })
    .optional(),
  engine: z.enum(['llama-cpp', 'mlx', 'mock', 'none']),
  modelId: z.string(),
  status: z.enum(['ok', 'partial', 'failed', 'static-only']),
  failureReason: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  at: z.string(),
});
export type ImageRecognition = z.infer<typeof ImageRecognitionSchema>;

/**
 * The bounded copy that rides on a persisted chat message.
 *
 * Why denormalize rather than look the full record up by hash at render time:
 * history replay is a synchronous, pure hot path that runs on every turn for
 * every stateless provider. Making it async and disk-reading would be a real
 * regression, and a session JSON that is meaningless without a separate cache
 * breaks both `ls`-ability and session export. The hash cache stays the system
 * of record for the rich modes; this is the copy that must never go missing.
 */
export const MessageImageDigestSchema = z.object({
  /** The markdown ref exactly as it appears in the message body. */
  ref: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Pre-rendered, already capped and fenced-safe. */
  digest: z.string(),
  modelId: z.string(),
  modes: z.array(RecognitionModeSchema),
  status: z.enum(['ok', 'partial', 'failed', 'static-only']),
  at: z.string(),
});
export type MessageImageDigest = z.infer<typeof MessageImageDigestSchema>;

export const RecognitionRequestSchema = z.object({
  /** Project-relative artifact path, e.g. `attachments/<uuid>.png`. */
  artifactPath: z.string().min(1).optional(),
  data: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  mode: RecognitionModeRequestSchema.default('auto'),
  /** JSON Schema for `extract` mode — fed to llama-server `response_format`. */
  schema: z.unknown().optional(),
  /** Overrides the configured recognition model for this call. */
  model: z.string().optional(),
});
export type RecognitionRequest = z.infer<typeof RecognitionRequestSchema>;

export const RecognitionResponseSchema = ImageRecognitionSchema;
export type RecognitionResponse = z.infer<typeof RecognitionResponseSchema>;

/**
 * Health without paying a cold start — mirrors the STT provider's contract so
 * Settings can render an honest state before anything is spawned.
 */
export const RecognitionHealthSchema = z.object({
  state: z.enum(['ok', 'no-model', 'not-configured', 'error']),
  modelId: z.string().optional(),
  detail: z.string().optional(),
});
export type RecognitionHealth = z.infer<typeof RecognitionHealthSchema>;
