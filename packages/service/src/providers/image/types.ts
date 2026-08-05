/**
 * ImageProvider — the service-side abstraction for local image generation.
 *
 * Mirrors the role `LLMProvider` plays for text. Deliberately simpler:
 * image gen is one-shot rather than session-based, so there is no
 * `createSession`/`sendAndWait` stream — just a single `generate` call
 * that returns a PNG buffer plus metadata.
 *
 * Implementations today:
 *   - `MockImageProvider` — deterministic 1x1 PNG for tests and
 *     GEZEL_MOCK_PROVIDER=1 flows.
 *   - `StableDiffusionCppProvider` — talks to a `sd-server` binary over HTTP.
 */

/**
 * One source image for editing / reference-driven generation, after
 * the route has resolved any artifact paths to bytes. Provider sees
 * a uniform `{ data: Buffer; mimeType }` shape.
 */
export interface ImageInputBytes {
  data: Buffer;
  mimeType: string;
}

/**
 * Progress info reported mid-generate by providers that can observe
 * per-step advancement. Today only the local sd-cpp provider emits
 * these (parsed from sd-server's `|==> | 3/20 - 18.20s/it` stdout).
 * Cloud providers stay silent — their HTTP APIs are one-shot, with
 * no streaming step counter to surface.
 */
export interface ImageGenerationProgress {
  /** Sampling step the engine just completed (1-indexed). */
  step: number;
  /** Total sampling steps for this generation. */
  totalSteps: number;
  /** Wall-clock seconds for the most recent step, when reported. */
  secondsPerStep?: number;
}

export interface ImageGenerationInput {
  prompt: string;
  negativePrompt?: string;
  /** Manifest id of the model to use. Provider falls back to its default. */
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  /**
   * Source images for image editing / reference-driven generation.
   * Cloud providers accept multiple; sd-cpp's img2img path uses the
   * first only (the others are dropped with a warning).
   */
  inputImages?: ImageInputBytes[];
  /** Img2img strength (0 = keep source, 1 = ignore source). sd-cpp only. */
  strength?: number;
  /**
   * Optional callback fired as the engine advances through sampling
   * steps. Today only the local sd-cpp provider emits these; cloud
   * providers ignore the field. Errors thrown from the callback are
   * swallowed so a buggy listener can't take down a generation.
   */
  onProgress?: (progress: ImageGenerationProgress) => void;
}

export interface ImageGenerationMeta {
  model: string;
  seed: number;
  steps: number;
  widthPx: number;
  heightPx: number;
  durationMs: number;
  /**
   * Set when `inputImages` were supplied but the resolved model does not
   * support img2img — the provider dropped the sources and generated from
   * the prompt alone. Mirrors the core wire schema so the route can
   * forward it untouched.
   */
  img2imgSkippedReason?: string;
}

export interface ImageGenerationOutput {
  png: Buffer;
  meta: ImageGenerationMeta;
}

export interface InstalledImageModelInfo {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Loading shape recorded at pull time; absent on pre-capability installs. */
  weightsKind?: 'checkpoint' | 'diffusion-model';
  /** Explicit catalog capability recorded at pull time; absent → resolve via the ladder. */
  supportsImg2Img?: boolean;
}

export type ImageModelPullEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes?: number }
  /**
   * Surfaced when the shared `downloadWithRetry` helper hit a transient
   * network error and is about to try again. The UI can render
   * "Connection lost — retrying in 4s (attempt 3/5)…" instead of a
   * fatal error banner. `reason` is already a user-friendly sentence;
   * don't wrap it.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'error'; error: string }
  | { type: 'done'; id: string };

export type ImageModelAuxiliaryRole = 'vae' | 'clip_l' | 'clip_g' | 't5xxl' | 'llm';

export interface ImageModelAuxiliaryPullSpec {
  role: ImageModelAuxiliaryRole;
  downloadUrl: string;
  sha256: string;
  approxSizeBytes: number;
}

export interface ImageModelPullSpec {
  downloadUrl: string;
  sha256: string;
  approxSizeBytes: number;
  /** Human-readable name copied into the local metadata. */
  name: string;
  /**
   * `checkpoint` — single-file (SD 1.x / SDXL / SD3.5 safetensors). The
   * supervisor passes `--model <weights>` at sd-server launch.
   * `diffusion-model` — unet-only (FLUX / SD3 GGUF); supervisor passes
   * `--diffusion-model <weights>` plus one `--<role>` flag per aux file.
   */
  weightsKind: 'checkpoint' | 'diffusion-model';
  /**
   * Explicit img2img capability from the catalog manifest, persisted
   * into the installed metadata so local state stays self-describing
   * even if the catalog entry later disappears. Absent when the catalog
   * didn't declare it — resolution falls back to the assessment map +
   * weights-kind default.
   */
  supportsImg2Img?: boolean;
  /** Auxiliary files (VAE, text encoders) downloaded alongside the unet. */
  auxiliaryFiles: ImageModelAuxiliaryPullSpec[];
}

export interface ImageEngineHealth {
  /**
   * `ok` — the engine is reachable and ready to accept generation requests.
   * `unreachable` — the configured engine URL is not responding (no
   *   process listening, network error, etc).
   * `not-configured` — no engine binary or URL is wired up; the provider
   *   would fall back to a default loopback URL that nothing is going to
   *   answer. UI surfaces this distinctly so the user gets actionable
   *   guidance rather than a generic "unreachable" state.
   */
  status: 'ok' | 'unreachable' | 'not-configured';
  /** Resolved base URL the provider is pointed at, for diagnostic display. */
  baseUrl: string;
  /** Free-form reason when `status !== 'ok'`. */
  error?: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
  listInstalledModels(): Promise<InstalledImageModelInfo[]>;
  /**
   * Stream the install of one catalog model. When `signal` is supplied
   * and aborts mid-download, providers should leave any `.partial` file
   * in place so a follow-up pull resumes via Range requests — disconnect
   * ≠ delete. Cloud providers ignore the field.
   */
  pullModel(
    id: string,
    spec: ImageModelPullSpec,
    signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent>;
  deleteModel(id: string): Promise<void>;
  /**
   * Probe the underlying engine for reachability without doing real
   * work. Implementations should be fast (sub-second) and never throw
   * — return `unreachable` / `not-configured` instead. Called by the
   * Settings UI to render an honest readiness pill.
   */
  health(): Promise<ImageEngineHealth>;
  /** Best-effort shutdown of any backing engine. Called when the service stops. */
  shutdown?(): Promise<void>;
}
