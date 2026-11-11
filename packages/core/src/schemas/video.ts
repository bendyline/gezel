import { z } from 'zod';
import { ImageAspectRatioSchema } from './image.js';

/**
 * Wire schemas for the video-generation feature. Mirrors `image.ts` —
 * the shape is provider-agnostic and the service routes each request
 * through whichever `VideoProvider` is active (mock for tests, the
 * bundled diffusers/PyTorch sidecar — LTX / WAN — in prod).
 *
 * The defining difference from image generation is the temporal axis:
 * requests carry `numFrames` + `fps`, and the output is an encoded clip
 * (mp4/webm) rather than a single PNG. Chat surfaces can't embed video,
 * so the inline path returns a base64 *poster frame* (`b64Poster`)
 * instead of the clip bytes.
 */

/**
 * One source image conditioning an image-to-video generation. Either
 * `data` (base64) or `artifactPath` (project-relative, resolved
 * server-side — e.g. a previous `generate_image` output).
 */
export const VideoInputSourceSchema = z.union([
  z.object({
    data: z.string().min(1),
    mimeType: z.string().default('image/png'),
  }),
  z.object({
    artifactPath: z.string().min(1),
  }),
]);
export type VideoInputSource = z.infer<typeof VideoInputSourceSchema>;

export const VideoGenerationRequestSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  /** Catalog/manifest id of the model to use. When absent, the provider
   *  falls back to the currently-selected default. */
  model: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Number of frames to render. Model-specific constraints apply (LTX
   *  wants 8n+1); the provider clamps to the model's allowed window. */
  numFrames: z.number().int().positive().optional(),
  /** Frames per second of the encoded clip. */
  fps: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  /**
   * Optional source image for image-to-video. Either base64 bytes +
   * mime, OR an artifact path resolved server-side. Only honored by
   * models whose manifest sets `supportsImageToVideo`.
   */
  inputImage: VideoInputSourceSchema.optional(),
  /**
   * The caller means to animate `inputImage`: refuse (409
   * `video_i2v_unavailable`) rather than make a clip from the words alone
   * when no installed model can animate a picture, and refuse a request
   * without a picture (400 `video_source_required`).
   */
  requireImageToVideo: z.boolean().optional(),
  /** The clip's shape at the model's trained area. Absent: the picture's shape, else the model's default. */
  aspectRatio: ImageAspectRatioSchema.optional(),
  /** Project the output artifact belongs to. Defaults to 'default'. */
  projectId: z.string().optional(),
  /**
   * The gezel + session originating this generation. Used to pin the
   * cost/duration confirmation question to the right scope. MCP
   * `generate_video` populates these from GEZEL_AGENT_ID /
   * GEZEL_SESSION_ID; direct UI/CLI callers can omit to skip the gate.
   */
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
  /**
   * Set to true to receive a base64 poster frame on the response, in
   * addition to the artifact write. The MCP `generate_video` tool uses
   * this so the bridge can attach a thumbnail as a tool-call image
   * content block (chat can't render the clip itself).
   */
  inline: z.boolean().optional(),
  /**
   * Optional workspace-relative path to write the workspace copy at,
   * e.g. `assets/hero.mp4`. When set, the workspace copy lands at
   * exactly that path instead of the default seed-keyed
   * `assets/generated/video-<seed>.mp4`. Must be a relative path with
   * no `..` segments and a video extension (`.mp4` / `.webm`).
   */
  saveAs: z.string().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

export const VideoGenerationMetaSchema = z.object({
  model: z.string(),
  seed: z.number().int(),
  steps: z.number().int(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  numFrames: z.number().int().positive(),
  fps: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  /** Container of the encoded clip, e.g. `video/mp4`. */
  mimeType: z.string(),
  /** The engine that rendered it, e.g. `diffusers`, `sd-cpp`. */
  engine: z.string().optional(),
  /** The clip carries a soundtrack. */
  hasAudio: z.boolean().optional(),
  /** Plain sentences about what was changed or left out, e.g. a clip saved as WebM only. */
  settingsNotes: z.array(z.string()).optional(),
  /** Why the picture sent to animate was not used: the model makes clips from words only. */
  i2vSkippedReason: z.string().optional(),
});
export type VideoGenerationMeta = z.infer<typeof VideoGenerationMetaSchema>;

export const VideoGenerationResponseSchema = z.object({
  /** Relative path under the project's `artifacts/` tree. */
  artifactPath: z.string(),
  /**
   * Relative path under the project's `workspace/` tree of a duplicate
   * copy written for HTML to reference (e.g. `assets/generated/X.mp4`).
   * `null` when the workspace copy was skipped. Callers writing HTML
   * should embed this path: `<video src="${workspacePath}">`.
   */
  workspacePath: z.string().nullable(),
  meta: VideoGenerationMetaSchema,
  /**
   * A poster frame (first frame) of the generated clip, base64-encoded
   * PNG. Set when the caller asks for inline bytes via `inline: true`
   * (the MCP `generate_video` tool does this so the bridge can attach a
   * thumbnail in chat). The clip itself is fetched from the artifact
   * path via the authenticated artifact-blob endpoint.
   */
  b64Poster: z.string().optional(),
  /** The poster's artifact path and type (`image/png`, or `image/webp` lifted from a WebM). */
  posterPath: z.string().optional(),
  posterMimeType: z.string().optional(),
  /** The same clip in other containers, as artifact paths (the WebM beside an MP4). */
  alternates: z.array(z.object({ artifactPath: z.string(), mimeType: z.string() })).optional(),
});
export type VideoGenerationResponse = z.infer<typeof VideoGenerationResponseSchema>;

export const InstalledVideoModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  approxSizeBytes: z.number().int().nonnegative(),
  installedAt: z.string(),
  kind: z.enum(['local', 'cloud']).optional(),
  /**
   * True when the model is supplied machine-wide by the read-only asset
   * store — deleting it from a user-context daemon is refused (409), so the
   * UI labels it "Machine-wide" instead of offering Delete.
   */
  readOnly: z.boolean().optional(),
  /** The engine that renders it. Absent from an engine that predates the field: diffusers. */
  engine: z.string().optional(),
  family: z.string().optional(),
  /** Animates a picture it is given. Absent: it makes clips from words only. */
  supportsImageToVideo: z.boolean().optional(),
  /** Only animates pictures. */
  imageToVideoOnly: z.boolean().optional(),
  /** Its clips come with a soundtrack. */
  hasAudio: z.boolean().optional(),
  /** The clip it renders when asked for nothing in particular. */
  defaultWidth: z.number().int().positive().optional(),
  defaultHeight: z.number().int().positive().optional(),
  defaultNumFrames: z.number().int().positive().optional(),
  defaultFps: z.number().int().positive().optional(),
});
export type InstalledVideoModel = z.infer<typeof InstalledVideoModelSchema>;

export const ListInstalledVideoModelsResponseSchema = z.object({
  models: z.array(InstalledVideoModelSchema),
  defaultModel: z.string().optional(),
  /** The model that animates an attached picture (core `chooseVideoModel`); absent when none can. */
  defaultImageToVideoModel: z.string().optional(),
});
export type ListInstalledVideoModelsResponse = z.infer<
  typeof ListInstalledVideoModelsResponseSchema
>;

/** The hardware accelerator the local video engine resolved on this host. */
export const VideoAcceleratorSchema = z.enum(['cuda', 'mps', 'cpu']);
export type VideoAccelerator = z.infer<typeof VideoAcceleratorSchema>;

/** Where a media engine computes: PyTorch's device for diffusers, the ggml backend for sd.cpp. */
export const MediaBackendSchema = z.enum(['cuda', 'mps', 'metal', 'vulkan', 'cpu']);
export type MediaBackend = z.infer<typeof MediaBackendSchema>;

/** One video engine's health, for the Settings page's per-engine readout. */
export const VideoEngineEntrySchema = z.object({
  engine: z.string(),
  status: z.enum(['ok', 'unreachable', 'not-configured']),
  backend: MediaBackendSchema.optional(),
  error: z.string().optional(),
  modelCount: z.number().int().nonnegative(),
});
export type VideoEngineEntry = z.infer<typeof VideoEngineEntrySchema>;

/**
 * Engine health envelope returned by `GET /api/video-gen/engine-status`.
 * Adds `accelerator` over the image equivalent so the Settings UI can
 * warn prominently when generation will fall back to CPU (minutes-to-
 * hours per clip).
 */
export const VideoEngineStatusResponseSchema = z.object({
  engine: z.object({
    status: z.enum(['ok', 'unreachable', 'not-configured']),
    baseUrl: z.string(),
    error: z.string().optional(),
    kind: z.enum(['local', 'cloud']).optional(),
    /** Provider name, e.g. 'diffusers', 'mock'. */
    provider: z.string().optional(),
    /**
     * Detected accelerator. `'cpu'` means generation is supported but
     * very slow — the UI surfaces a strong warning. Absent for cloud
     * providers (no local accelerator involved).
     */
    accelerator: VideoAcceleratorSchema.optional(),
    /**
     * Why a local engine runs on the CPU when the platform itself is the
     * reason: `no-gpu-build` means PyTorch publishes no GPU build there
     * (Windows on ARM, even with an NVIDIA GPU), so no driver or setting
     * will change it. Absent otherwise.
     */
    cpuReason: z.enum(['no-gpu-build']).optional(),
    /** Each video engine on this computer. Absent from a daemon that predates sd.cpp video. */
    engines: z.array(VideoEngineEntrySchema).optional(),
  }),
  modelCount: z.number().int().nonnegative(),
});
export type VideoEngineStatusResponse = z.infer<typeof VideoEngineStatusResponseSchema>;

/**
 * Snapshot of one in-flight (or recently-finished) video-model pull.
 * Exposed by `GET /api/video-gen/pulls` so a UI mounted after the pull
 * started can render a live progress bar.
 */
export const ActiveVideoPullSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** The file currently downloading, for multi-file progress display. */
  file: z.string().optional(),
  fileIndex: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().positive().optional(),
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
export type ActiveVideoPull = z.infer<typeof ActiveVideoPullSchema>;

export const ListActiveVideoPullsResponseSchema = z.object({
  pulls: z.array(ActiveVideoPullSchema),
});
export type ListActiveVideoPullsResponse = z.infer<typeof ListActiveVideoPullsResponseSchema>;

/**
 * Progress envelope streamed during `POST /api/video-gen/models/:id/pull`.
 * Multi-file shaped (mirrors the MLX installer) since video models are
 * HF repos of many files: `progress` carries per-file and cumulative
 * byte counts. Terminal events are `error` or `done`.
 */
export const VideoModelPullEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    /** 0-based index of the file currently downloading. */
    fileIndex: z.number().int().nonnegative(),
    fileCount: z.number().int().positive(),
    file: z.string(),
    bytesWritten: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** Cumulative bytes across all files in the batch. */
    bytesWrittenAll: z.number().int().nonnegative(),
    totalBytesAll: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('retrying'),
    file: z.string(),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('verifying'),
    file: z.string(),
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
export type VideoModelPullEvent = z.infer<typeof VideoModelPullEventSchema>;
