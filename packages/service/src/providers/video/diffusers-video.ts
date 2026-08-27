/**
 * DiffusersVideoProvider — talks to the bundled `gezel_video_server.py`
 * (diffusers / PyTorch) over HTTP. The video sibling of
 * `StableDiffusionCppProvider`.
 *
 * The Python server's lifecycle is a `NativeEngineSupervisor`'s concern
 * (lazy-start / idle-stop / health-watch); this provider just hits
 * whichever URL `ensureRunning()` resolves. Generation is GPU-heavy and
 * long-running, so we take a `'video'` GPU lease around each call (which
 * evicts the LLM under the `swap` policy) and subscribe to the engine's
 * log stream to surface per-step progress.
 *
 * Model management (list / pull / delete) is delegated to
 * {@link VideoModelManager}; the server binds to the first installed
 * model at launch (same single-model simplification as sd-cpp).
 */

import { createLogger } from '@bendyline/gezel';
import type { VideoAccelerator } from '@bendyline/gezel';
import type { GpuArbiter } from '../gpu-arbiter.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import type { VideoModelManager, VideoModelSelector } from './models.js';
import type {
  InstalledVideoModelInfo,
  VideoEngineHealth,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoGenerationProgress,
  VideoModelPullEvent,
  VideoProvider,
} from './types.js';

const log = createLogger('video');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h — video + cold-start model load.
const DEFAULT_NUM_FRAMES = 97;
const DEFAULT_FPS = 24;
const DEFAULT_STEPS = 40;

export interface DiffusersVideoProviderOptions {
  /** Fallback base URL before the supervisor resolves a port. */
  baseUrl: string;
  /** Owns the catalog-backed multi-file model install + on-disk layout. */
  models: VideoModelManager;
  /** Detected accelerator, surfaced via `health()` so the UI can warn on CPU. */
  accelerator: VideoAccelerator;
  /** Per-request timeout in ms. Defaults to 1 hour. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Lifecycle manager. When supplied the provider calls `ensureRunning()`
   * before each generate and uses the returned baseUrl. Omit for the
   * external-URL ("user runs the server themselves") mode.
   */
  supervisor?: NativeEngineSupervisor;
  /**
   * Shared model selection. When supplied (bundled-engine path), a
   * per-request `model` override is honored by pointing the selector at it
   * and relaunching the engine if the currently-bound model differs.
   */
  selector?: VideoModelSelector;
  /** False when nothing was wired up (default-loopback fallback). */
  configured?: boolean;
  /**
   * Cross-engine GPU coordinator. When supplied alongside a supervisor
   * the provider acquires the `'video'` slot before each generate and
   * registers its supervisor's `stop()` as the `'video'` evictor.
   */
  arbiter?: GpuArbiter;
}

export class DiffusersVideoProvider implements VideoProvider {
  readonly name = 'diffusers';
  private readonly baseUrl: string;
  private readonly models: VideoModelManager;
  private readonly accelerator: VideoAccelerator;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly selector?: VideoModelSelector;
  private readonly configured: boolean;
  private readonly arbiter?: GpuArbiter;

  constructor(opts: DiffusersVideoProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.models = opts.models;
    this.accelerator = opts.accelerator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.supervisor = opts.supervisor;
    if (opts.selector) this.selector = opts.selector;
    this.configured = opts.configured ?? true;
    if (opts.arbiter && opts.supervisor) {
      this.arbiter = opts.arbiter;
      this.arbiter.registerEvictor('video', () => opts.supervisor!.stop());
    }
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const width = input.width ?? 704;
    const height = input.height ?? 480;
    const numFrames = input.numFrames ?? DEFAULT_NUM_FRAMES;
    const fps = input.fps ?? DEFAULT_FPS;
    const steps = input.steps ?? DEFAULT_STEPS;
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const modelId = input.model ?? (await this.models.resolveDefaultModel())?.id ?? 'default';
    const started = Date.now();
    log.info(
      `[video] generate model=${modelId} steps=${steps} frames=${numFrames} fps=${fps} size=${width}x${height} i2v=${Boolean(input.inputImage)}`,
    );

    // Dedup consecutive identical status lines — the diffusers loaders
    // emit the same phase across many rapid tqdm updates, and we don't
    // want to flood the chat event bus with a publish per line.
    let lastStatus = '';
    const emitStatus = (message: string) => {
      if (message === lastStatus) return;
      lastStatus = message;
      try {
        input.onStatus?.(message);
      } catch {
        /* listener errors are not load-bearing */
      }
    };

    let baseUrl = this.baseUrl;
    let unsubscribeLogs: (() => void) | undefined;
    if (this.supervisor && (input.onProgress || input.onStatus)) {
      const onProgress = input.onProgress;
      unsubscribeLogs = this.supervisor.subscribeLogLines((line) => {
        // Sampling progress (`step N/M`) → the step bar.
        const parsed = parseVideoProgress(line);
        if (parsed) {
          try {
            onProgress?.(parsed);
          } catch {
            /* listener errors are not load-bearing */
          }
          return;
        }
        // Warm-up phases printed by gezel_video_server.py before the
        // first sampling step — surface them as plain status text so the
        // chat bubble isn't a silent spinner for minutes.
        const status = parseVideoWarmupStatus(line);
        if (status) emitStatus(status);
      });
    }

    let releaseGpu: (() => void) | undefined;
    let launchedModelId: string | undefined;
    if (this.supervisor) {
      // Acquire the GPU slot BEFORE starting the engine so `swap` policy
      // evicts a running llama-server first. No-op under `coexist`. Holding
      // the lease also serializes the model-switch below against a
      // concurrent generation that wants a different model.
      if (this.arbiter) releaseGpu = await this.arbiter.acquireLease('video');
      try {
        if (this.selector) {
          // Point the shared selection at the requested model (falls back to
          // the configured default when `model` is absent). If the engine is
          // already bound to a different model, stop it so `ensureRunning`
          // relaunches with the requested weights — the server loads one
          // model at launch, so switching means a relaunch + cold load.
          this.selector.requestedId = input.model;
          const desired = await this.selector.pick();
          if (input.model && desired?.id !== input.model) {
            throw new Error(
              `Video model '${input.model}' is not available locally. Download it in Settings → Video generation, or omit \`model\` to use the default.`,
            );
          }
          if (this.selector.launchedId && desired && this.selector.launchedId !== desired.id) {
            emitStatus(`Loading ${desired.id} (switching models)…`);
            await this.supervisor.stop();
          }
          launchedModelId = desired?.id;
        }
        // `ensureRunning` provisions the Python venv on first use (a
        // multi-minute torch + diffusers install) and spawns the server.
        // Announce it so the wait isn't unexplained.
        emitStatus('Preparing the video engine (first run installs PyTorch + diffusers)…');
        const launch = await this.supervisor.ensureRunning();
        baseUrl = launch.baseUrl.replace(/\/+$/, '');
        launchedModelId = this.selector?.launchedId ?? launchedModelId;
      } catch (err) {
        releaseGpu?.();
        unsubscribeLogs?.();
        throw err;
      }
    }

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      numFrames,
      fps,
      width,
      height,
      steps,
      seed,
    };
    if (input.negativePrompt) body.negativePrompt = input.negativePrompt;
    if (input.guidanceScale !== undefined) body.guidanceScale = input.guidanceScale;
    if (input.inputImage) {
      body.inputImage = input.inputImage.data.toString('base64');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new Error(`video engine did not respond within ${this.timeoutMs / 1000}s`);
      }
      throw new Error(
        `video engine unreachable at ${baseUrl}. Is the video engine enabled in Settings? (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
      this.supervisor?.markUsed();
      unsubscribeLogs?.();
      releaseGpu?.();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `video engine returned ${res.status} ${res.statusText}: ${text.slice(0, 400)}`,
      );
    }

    const payload = (await res.json()) as {
      video?: string;
      poster?: string;
      meta?: { mimeType?: string };
    };
    if (!payload.video) throw new Error('video engine response missing `video`');
    const video = Buffer.from(payload.video, 'base64');
    const poster = payload.poster ? Buffer.from(payload.poster, 'base64') : undefined;

    return {
      video,
      ...(poster ? { poster } : {}),
      meta: {
        model: launchedModelId ?? modelId,
        seed,
        steps,
        widthPx: width,
        heightPx: height,
        numFrames,
        fps,
        durationMs: Date.now() - started,
        mimeType: payload.meta?.mimeType ?? 'video/mp4',
      },
    };
  }

  async listInstalledModels(): Promise<InstalledVideoModelInfo[]> {
    const models = await this.models.listInstalled();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      approxSizeBytes: m.approxSizeBytes,
      installedAt: m.installedAt,
      ...(m.readOnly ? { readOnly: true } : {}),
    }));
  }

  pullModel(id: string, signal?: AbortSignal): AsyncIterable<VideoModelPullEvent> {
    return this.models.install(id, signal);
  }

  async deleteModel(id: string): Promise<void> {
    await this.models.delete(id);
  }

  async health(): Promise<VideoEngineHealth> {
    if (!this.configured) {
      return {
        status: 'not-configured',
        baseUrl: this.baseUrl,
        accelerator: this.accelerator,
        error:
          'No video engine wired up. The bundled diffusers engine could not be provisioned — ' +
          'check the Python runtime in Settings.',
      };
    }
    // Supervised engine is "configured but lazy" — the server spawns on
    // first generate. Probing eagerly would cost a cold-start every time
    // Settings opens, so report ok and lean on the supervisor's health-watch.
    if (this.supervisor) {
      return { status: 'ok', baseUrl: this.baseUrl, accelerator: this.accelerator };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      void res.body?.cancel?.().catch(() => {});
      return { status: 'ok', baseUrl: this.baseUrl, accelerator: this.accelerator };
    } catch (err) {
      const message = ctrl.signal.aborted
        ? `video engine did not respond within 2s at ${this.baseUrl}`
        : err instanceof Error
          ? err.message
          : String(err);
      return {
        status: 'unreachable',
        baseUrl: this.baseUrl,
        accelerator: this.accelerator,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    await this.supervisor?.stop();
  }
}

/**
 * Parse a `step N/M` progress line printed by `gezel_video_server.py`
 * (optionally prefixed by the supervisor's `[video-server] ` tag).
 * Returns null for unrelated log noise. Anchored on the `step N/M`
 * shape so it can't false-match.
 */
export function parseVideoProgress(line: string): VideoGenerationProgress | null {
  const m = line.match(/\bstep\s+(\d+)\s*\/\s*(\d+)\b/i);
  if (!m) return null;
  const step = Number.parseInt(m[1]!, 10);
  const totalSteps = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(step) || !Number.isFinite(totalSteps) || totalSteps <= 0) return null;
  return { step, totalSteps };
}

/**
 * Map a warm-up log line from `gezel_video_server.py` (printed before the
 * first sampling step) to a short, user-facing status message — or null
 * for unrelated lines. Mirrors the `log(...)` calls in the server's
 * `_ensure_pipeline`. Surfaced to the chat bubble so the multi-minute
 * model-load isn't a silent spinner.
 */
export function parseVideoWarmupStatus(line: string): string | null {
  // `pipeline ready` is our own terminal marker — check it first.
  if (/pipeline ready/i.test(line)) {
    return 'Model loaded — starting generation…';
  }
  // Our own "loading <family> <kind> pipeline …" marker.
  if (/loading\s+\w+\s+(?:t2v|i2v)\s+pipeline/i.test(line)) {
    return 'Loading the model…';
  }
  // diffusers/transformers loader chatter (tqdm bars). These are the bulk
  // of the multi-minute warm-up, so surfacing them keeps the bubble alive
  // even if our own marker line is missed. Dedup upstream collapses the
  // repeated per-percentage updates into one status per phase.
  if (/loading (?:weights|checkpoint shards)/i.test(line)) {
    return 'Loading model weights…';
  }
  if (/loading pipeline components/i.test(line)) {
    return 'Loading pipeline components…';
  }
  return null;
}
