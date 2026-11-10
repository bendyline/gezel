/**
 * VideoProvider — the service-side abstraction for local (and, later,
 * cloud) text-to-video generation. The video sibling of `ImageProvider`.
 *
 * Like image generation it's one-shot: a single `generate` call returns
 * an encoded clip plus metadata — no session/stream. The defining
 * differences from images are the temporal axis (`numFrames` + `fps`)
 * and the multi-file model layout (video models are HF repos of many
 * files, like MLX chat models), so `pullModel` reports multi-file
 * progress rather than the single-file shape `ImageProvider` uses.
 *
 * Implementations:
 *   - `MockVideoProvider` — deterministic tiny clip for tests and
 *     GEZEL_MOCK_PROVIDER=1 flows.
 *   - `DiffusersVideoProvider` — talks to the bundled `gezel_video_server.py`
 *     (diffusers / PyTorch) over HTTP, lifecycle-managed by a
 *     `NativeEngineSupervisor`.
 */

import type { MediaBackend, VideoAccelerator } from '@bendyline/gezel';

/**
 * Source image for image-to-video, after the route has resolved any
 * artifact path to bytes. The provider sees a uniform shape.
 */
export interface VideoInputBytes {
  data: Buffer;
  mimeType: string;
}

/**
 * Progress reported mid-generate by providers that can observe
 * per-step advancement. The local diffusers engine emits these (parsed
 * from the Python server's `step N/M` stdout); a future cloud provider
 * would stay silent.
 */
export interface VideoGenerationProgress {
  /** Sampling step the engine just completed (1-indexed). */
  step: number;
  /** Total sampling steps for this generation. */
  totalSteps: number;
  /** Wall-clock seconds for the most recent step, when reported. */
  secondsPerStep?: number;
}

/** The engine could not fit the render in memory; it was stopped so the next one starts clean. */
export class VideoCapacityError extends Error {
  readonly code = 'video_capacity';
  constructor(message: string) {
    super(message);
    this.name = 'VideoCapacityError';
  }
}

/** The render ran past the time a clip is allowed and was stopped. */
export class VideoRenderTimedOutError extends Error {
  readonly code = 'video_render_timed_out';
  constructor(message: string) {
    super(message);
    this.name = 'VideoRenderTimedOutError';
  }
}

/** The caller stopped the render. */
export class VideoGenerationCancelledError extends Error {
  readonly code = 'video_generation_cancelled';
  constructor(message: string) {
    super(message);
    this.name = 'VideoGenerationCancelledError';
  }
}

export interface VideoGenerationInput {
  prompt: string;
  negativePrompt?: string;
  /** Manifest id of the model to use. Provider falls back to its default. */
  model?: string;
  width?: number;
  height?: number;
  /** Frame count. The provider clamps to the model's allowed window. */
  numFrames?: number;
  /** Frames per second of the encoded clip. */
  fps?: number;
  steps?: number;
  /** Classifier-free guidance scale. Provider falls back to the pipeline's. */
  guidanceScale?: number;
  seed?: number;
  /** Optional source image for image-to-video (I2V-capable models only). */
  inputImage?: VideoInputBytes;
  /** The caller gave up: the engine stops the render. */
  signal?: AbortSignal;
  /**
   * Fired as the engine advances through sampling steps. Errors thrown
   * from the callback are swallowed so a buggy listener can't take down
   * a generation.
   */
  onProgress?: (progress: VideoGenerationProgress) => void;
  /**
   * Fired with a short, user-facing message as the engine moves through
   * the non-sampling phases that precede generation — provisioning the
   * Python venv (slow on first run), then loading the model weights /
   * pipeline. Lets the chat surface show "Loading model weights…"
   * instead of a silent spinner during the multi-minute warm-up. Errors
   * thrown from the callback are swallowed.
   */
  onStatus?: (message: string) => void;
}

export interface VideoGenerationMeta {
  model: string;
  seed: number;
  steps: number;
  widthPx: number;
  heightPx: number;
  numFrames: number;
  fps: number;
  durationMs: number;
  /** Container of the encoded clip, e.g. `video/mp4`. */
  mimeType: string;
  /** The engine that rendered it. */
  engine?: string;
  /** The clip carries a soundtrack. */
  hasAudio?: boolean;
  /** Plain sentences about what was changed or left out. */
  settingsNotes?: string[];
}

export interface VideoGenerationOutput {
  /** Encoded clip bytes (mp4/webm per `meta.mimeType`). */
  video: Buffer;
  /**
   * First frame as a PNG, for the chat thumbnail / poster. Optional —
   * the mock provider may skip it; the diffusers engine always returns
   * one so the MCP tool has something to show.
   */
  poster?: Buffer;
  meta: VideoGenerationMeta;
}

export interface InstalledVideoModelInfo {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /**
   * True when the model lives in the read-only machine asset store, so
   * `deleteModel` would refuse it and the UI must not offer Delete.
   */
  readOnly?: boolean;
  /** The engine that renders it. Absent from an engine that predates the field. */
  engine?: string;
  family?: string;
  /** Animates a picture it is given. Absent: clips from words only. */
  supportsImageToVideo?: boolean;
  imageToVideoOnly?: boolean;
  hasAudio?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultNumFrames?: number;
  defaultFps?: number;
}

/**
 * Multi-file pull progress. Mirrors `MlxInstallEvent` (video models are
 * HF repos of many files) rather than `ImageModelPullEvent`'s single-file
 * shape. Kept in sync with the wire schema `VideoModelPullEventSchema`.
 */
export type VideoModelPullEvent =
  | {
      type: 'progress';
      fileIndex: number;
      fileCount: number;
      file: string;
      bytesWritten: number;
      totalBytes: number;
      bytesWrittenAll: number;
      totalBytesAll: number;
    }
  | {
      type: 'retrying';
      file: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'verifying'; file: string }
  | { type: 'error'; error: string }
  | { type: 'done'; id: string };

export interface VideoEngineHealth {
  /**
   * `ok` — reachable and ready.
   * `unreachable` — configured engine URL not responding.
   * `not-configured` — no engine wired up (the default-loopback fallback).
   */
  status: 'ok' | 'unreachable' | 'not-configured';
  baseUrl: string;
  error?: string;
  /**
   * Accelerator the local engine resolved on this host. `'cpu'` means
   * generation works but is very slow — the UI warns prominently.
   * Absent for cloud providers.
   */
  accelerator?: VideoAccelerator;
  /** sd.cpp: the ggml backend its sd-server build computes on. */
  backend?: MediaBackend;
}

export interface VideoProvider {
  readonly name: string;
  generate(input: VideoGenerationInput): Promise<VideoGenerationOutput>;
  listInstalledModels(): Promise<InstalledVideoModelInfo[]>;
  /**
   * Stream the install of one catalog model. When `signal` aborts
   * mid-download, providers leave `.partial` files in place so a
   * follow-up pull resumes via Range requests.
   */
  pullModel(id: string, signal?: AbortSignal): AsyncIterable<VideoModelPullEvent>;
  deleteModel(id: string): Promise<void>;
  /** Fast (sub-second), never-throws reachability probe for the Settings UI. */
  health(): Promise<VideoEngineHealth>;
  /** Best-effort shutdown of any backing engine. */
  shutdown?(): Promise<void>;
}
