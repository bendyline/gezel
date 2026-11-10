/**
 * SdCppVideoProvider renders video with stable-diffusion.cpp's sd-server,
 * the binary the image engine already ships, through its asynchronous job
 * API (`sd-cpp-video-jobs.ts`).
 *
 * sd-server holds one model per process and decides it renders video from
 * the weights it was started with, so a model switch is a relaunch, as with
 * the image engine and the diffusers server. This engine runs its own
 * sd-server process on its own port: an image render and a video render
 * never share one.
 *
 * Model management is {@link VideoModelManager}'s, shared with the diffusers
 * engine; this provider only ever binds models installed for `sd-cpp`.
 */

import {
  AwakeBudget,
  type MediaBackend,
  type MediaMemoryRequirement,
  type VideoModelComponentRole,
  type VideoPromptFormat,
  type VideoRenderSize,
  createLogger,
  sdCppVideoDecoder,
} from '@bendyline/gezel';
import type { GpuArbiter } from '@bendyline/gezel-inference/internal/providers/gpu-arbiter';
import {
  ENGINE_MEMORY_SHORTFALL,
  progressTracker,
  withoutEngineDirectives,
} from '@bendyline/gezel-inference/internal/providers/image/sd-cpp';
import type { NativeEngineSupervisor } from '@bendyline/gezel-inference/internal/providers/native/supervisor';
import {
  type InstalledVideoModel,
  type VideoModelManager,
  type VideoModelSelector,
  installedVideoModelInfo,
} from './models.js';
import {
  SdVideoJobCancelledError,
  SdVideoJobFailedError,
  runSdVideoJob,
} from './sd-cpp-video-jobs.js';
import {
  type InstalledVideoModelInfo,
  VideoCapacityError,
  type VideoEngineHealth,
  VideoGenerationCancelledError,
  type VideoGenerationInput,
  type VideoGenerationOutput,
  type VideoModelPullEvent,
  type VideoProvider,
  VideoRenderTimedOutError,
} from './types.js';

const log = createLogger('video');

/** Video and chat engines do not share memory until sd.cpp video is calibrated. */
export const SD_VIDEO_EXCLUSIVE = true;

/**
 * Awake time a render may take before it is stopped. A default Wan2.2
 * TI2V-5B clip (1280x704x121) took 72 minutes on an M5 Max (2026-11-09) and
 * runs several times longer on smaller Macs; the one-hour budget this
 * replaced stopped it at step 17 of 20. The bound is for a stuck engine, not
 * a slow one: a dead engine fails the next status poll on its own.
 */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RECENT_ENGINE_LINES = 40;

/** sd-server's flag for each model slot; the spellings mix hyphens and underscores. */
export const ROLE_FLAGS: Readonly<Record<VideoModelComponentRole, string>> = {
  diffusion_model: '--diffusion-model',
  high_noise_diffusion_model: '--high-noise-diffusion-model',
  vae: '--vae',
  tae: '--tae',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
  clip_vision: '--clip_vision',
  audio_vae: '--audio-vae',
  audio_encoder: '--audio-encoder',
  embeddings_connectors: '--embeddings-connectors',
};

/**
 * The sd-server argv for one installed sd.cpp video model.
 *
 * `maxVramGiB` is passed on a discrete card only: sd-server's auto-fit
 * otherwise fills whatever graphics memory is free, beyond what the device
 * ledger admitted it for. On unified memory there is no separate card to cap.
 */
export function buildSdVideoServerArgs(
  model: Pick<InstalledVideoModel, 'components'>,
  port: number,
  opts: { maxVramGiB?: number; verbose?: boolean } = {},
): string[] {
  const args: string[] = [];
  for (const { role, path } of model.components ?? []) {
    args.push(ROLE_FLAGS[role], path);
  }
  // Flash attention is forced on in the diffusion model: `auto` decides from
  // a 1024-token speed probe that ignores memory, and on Metal it chose off
  // on one launch of two, so a 1280x704x121 Wan clip (27k tokens) asked for
  // a 70 GB attention buffer where flash needs about 1 GB (2026-11-09).
  // sd.cpp falls back to plain attention per op where a backend lacks flash.
  // Off in the text encoder: ggml's Arm FP16 kernel overflows on Qwen-family
  // encoders (see the image engine's launch).
  args.push('--flash-attn', 'auto,te=off,diffusion=on');
  if (opts.maxVramGiB !== undefined) {
    args.push('--max-vram', String(Math.max(1, Math.floor(opts.maxVramGiB))));
  }
  if (opts.verbose) args.push('--log-level', 'verbose');
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port));
  return args;
}

/** The components an sd.cpp video model loads on this backend: all but the decoder it does not use. */
export function sdCppVideoLaunchComponents<T extends { role: string }>(
  components: readonly T[],
  backend: MediaBackend | undefined,
): T[] {
  const decoder = sdCppVideoDecoder(
    components.map((c) => c.role),
    backend,
  );
  const unused = decoder === 'tae' ? 'vae' : 'tae';
  return components.filter((c) => c.role !== unused);
}

/**
 * The prompt as the model was trained to read it. LingBot-Video takes a
 * structured caption; words a person typed become its description. A
 * prompt that already is a caption object passes through.
 */
export function shapeVideoPrompt(format: VideoPromptFormat | undefined, prompt: string): string {
  const text = withoutEngineDirectives(prompt).trim();
  if (format !== 'lingbot-caption') return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'caption' in parsed) return text;
  } catch {
    /* plain words */
  }
  return JSON.stringify({ caption: { comprehensive_description: text } });
}

export interface SdVideoRenderRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  numFrames: number;
  fps: number;
  steps: number;
  seed: number;
  guidanceScale?: number;
  /** Already checked: the model animates pictures. */
  initImage?: Buffer;
}

/** The `POST /sdcpp/v1/vid_gen` body for one render. */
export function buildSdVideoRequestBody(
  model: Pick<InstalledVideoModel, 'sdCpp' | 'promptFormat'>,
  req: SdVideoRenderRequest,
): Record<string, unknown> {
  const sd = model.sdCpp;
  const negative = req.negativePrompt ?? sd?.negativePrompt;
  const sample: Record<string, unknown> = {
    sample_steps: sd?.customSigmas ? sd.customSigmas.length - 1 : req.steps,
    ...(sd?.sampler ? { sample_method: sd.sampler } : {}),
    ...(sd?.scheduler ? { scheduler: sd.scheduler } : {}),
    ...(sd?.flowShift !== undefined ? { flow_shift: sd.flowShift } : {}),
    ...(sd?.customSigmas ? { custom_sigmas: sd.customSigmas } : {}),
    ...(req.guidanceScale !== undefined ? { guidance: { txt_cfg: req.guidanceScale } } : {}),
  };
  const tiling = sd?.vaeTiling;
  const extraTiling = [
    tiling?.temporalTileFrames !== undefined
      ? `temporal_tile_frames=${tiling.temporalTileFrames}`
      : '',
    tiling?.temporalDecodeFrames !== undefined
      ? `temporal_decode_frames=${tiling.temporalDecodeFrames}`
      : '',
  ]
    .filter(Boolean)
    .join(',');
  const body: Record<string, unknown> = {
    prompt: shapeVideoPrompt(model.promptFormat, req.prompt),
    ...(negative ? { negative_prompt: withoutEngineDirectives(negative) } : {}),
    width: req.width,
    height: req.height,
    seed: req.seed,
    video_frames: req.numFrames,
    fps: req.fps,
    sample_params: sample,
    vae_tiling_params: {
      enabled: tiling?.spatial ?? true,
      temporal_tiling: tiling?.temporal ?? false,
      ...(tiling?.tileSizePx
        ? { tile_size_w: tiling.tileSizePx, tile_size_h: tiling.tileSizePx }
        : {}),
      ...(extraTiling ? { extra_tiling_args: extraTiling } : {}),
    },
    lora: [],
    output_format: 'webm',
    output_compression: sd?.outputCompression ?? 90,
    preview: 'none',
  };
  if (sd?.highNoise) {
    body.high_noise_sample_params = {
      sample_steps: sd.highNoise.steps ?? -1,
      ...(sd.highNoise.sampler ? { sample_method: sd.highNoise.sampler } : {}),
      ...(sd.highNoise.scheduler ? { scheduler: sd.highNoise.scheduler } : {}),
      ...(sd.highNoise.flowShift !== undefined ? { flow_shift: sd.highNoise.flowShift } : {}),
      ...(sd.highNoise.cfg !== undefined || req.guidanceScale !== undefined
        ? { guidance: { txt_cfg: sd.highNoise.cfg ?? req.guidanceScale } }
        : {}),
    };
  }
  if (sd?.moeBoundary !== undefined) body.moe_boundary = sd.moeBoundary;
  if (sd?.cacheMode) body.cache_mode = sd.cacheMode;
  if (req.initImage) {
    body.init_image = req.initImage.toString('base64');
    // Default resampling is nearest-neighbour; a first frame deserves better.
    body.image_preprocess = 'target=init,mode=crop-resize,filter=lanczos,antialias=true';
  }
  return body;
}

/**
 * The clip the running engine's memory claim was priced for. A launch prices
 * the larger of the model's default clip and the one requested, so the
 * device ledger admits what the render will hold. A later request for a clip
 * that needs more relaunches the engine with room for it, rather than render
 * past what was admitted.
 */
export class SdVideoClaim {
  /** The clip the next launch prices; set by the provider before it starts the engine. */
  requestedSize: VideoRenderSize | undefined;
  /** The next launch's clip animates a picture, which holds more through sampling. */
  requestedAnimatesPicture = false;
  /** What the running engine claimed, for which model; stale once it stops. */
  launched: { modelId: string; bytes: number } | undefined;

  constructor(
    readonly price: (
      model: InstalledVideoModel,
      size: VideoRenderSize | undefined,
      animatesPicture?: boolean,
    ) => Promise<MediaMemoryRequirement>,
  ) {}

  /** What a launch of `model` claims: the larger of its default clip and the requested one. */
  async forLaunch(model: InstalledVideoModel): Promise<MediaMemoryRequirement> {
    const atDefault = await this.price(model, undefined);
    if (!this.requestedSize && !this.requestedAnimatesPicture) return atDefault;
    const atRequest = await this.price(model, this.requestedSize, this.requestedAnimatesPicture);
    return atRequest.bytes > atDefault.bytes ? atRequest : atDefault;
  }

  /** True when the engine was launched for this model with less room than the clip needs. */
  async outgrownBy(
    model: InstalledVideoModel,
    size: VideoRenderSize,
    animatesPicture = false,
  ): Promise<boolean> {
    if (this.launched?.modelId !== model.id) return false;
    return (await this.price(model, size, animatesPicture)).bytes > this.launched.bytes;
  }
}

export interface SdCppVideoProviderOptions {
  baseUrl: string;
  models: VideoModelManager;
  /** Binds sd.cpp models only; set by the provider, read at launch. */
  selector: VideoModelSelector;
  supervisor?: NativeEngineSupervisor;
  /** False when no sd-server binary or URL is wired up. */
  configured?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  arbiter?: GpuArbiter;
  /** The ggml backend the sd-server build computes on, for the Settings readout. */
  backend?: MediaBackend;
  /** Prices each launch for the clip it serves; see {@link SdVideoClaim}. */
  claim?: SdVideoClaim;
}

export class SdCppVideoProvider implements VideoProvider {
  readonly name = 'sd-cpp';
  private readonly baseUrl: string;
  private readonly models: VideoModelManager;
  private readonly selector: VideoModelSelector;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly configured: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly arbiter?: GpuArbiter;
  private readonly backend?: MediaBackend;
  private readonly claim?: SdVideoClaim;
  /** Renders run one at a time; each waits for the one before. */
  private renderTail: Promise<void> = Promise.resolve();
  /** The engine launch whose capabilities were checked. */
  private checkedBaseUrl: string | undefined;

  constructor(opts: SdCppVideoProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.models = opts.models;
    this.selector = opts.selector;
    if (opts.supervisor) this.supervisor = opts.supervisor;
    this.configured = opts.configured ?? true;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.backend) this.backend = opts.backend;
    if (opts.claim) this.claim = opts.claim;
    if (opts.arbiter && opts.supervisor) {
      this.arbiter = opts.arbiter;
      const supervisor = opts.supervisor;
      this.arbiter.registerEvictor('video', () => supervisor.stop(), 'sd-cpp');
    }
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const previous = this.renderTail;
    let release!: () => void;
    this.renderTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return this.supervisor
        ? await this.supervisor.withRequest(() => this.generateInner(input))
        : await this.generateInner(input);
    } finally {
      release();
    }
  }

  private async generateInner(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    if (!this.configured) {
      throw new Error(
        'The sd.cpp video engine is not available in this build. Update Gezel, or pick a model that runs on the other video engine.',
      );
    }
    const started = Date.now();
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

    this.selector.requestedId = input.model;
    const model = await this.selector.pick();
    if (!model || (input.model && model.id !== input.model)) {
      throw new Error(
        input.model
          ? `Video model '${input.model}' is not available locally. Download it in Settings → Video generation, or omit \`model\` to use the default.`
          : 'No video model is available locally. Download one from Settings → Video generation before generating.',
      );
    }

    const recentLines: string[] = [];
    let secondsPerStep = 0;
    let baseUrl = this.baseUrl;
    let unsubscribe: (() => void) | undefined;
    let releaseGpu: (() => void) | undefined;
    if (this.supervisor) {
      const track = progressTracker((progress) => {
        if (progress.phase === 'loading_model') {
          emitStatus(
            `Loading model weights… ${Math.round((progress.step / progress.totalSteps) * 100)}%`,
          );
          return;
        }
        if (progress.phase === 'decoding') {
          emitStatus('Decoding frames…');
          return;
        }
        if (progress.secondsPerStep) secondsPerStep = progress.secondsPerStep;
        try {
          input.onProgress?.({
            step: progress.step,
            totalSteps: progress.totalSteps,
            ...(progress.secondsPerStep !== undefined
              ? { secondsPerStep: progress.secondsPerStep }
              : {}),
          });
        } catch {
          /* listener errors are not load-bearing */
        }
      });
      unsubscribe = this.supervisor.subscribeLogLines((line) => {
        recentLines.push(line);
        if (recentLines.length > RECENT_ENGINE_LINES) recentLines.shift();
        track(line);
      });
      if (this.arbiter) releaseGpu = await this.arbiter.acquireLease('video');
    }

    try {
      const width = input.width ?? model.defaultWidth ?? 832;
      const height = input.height ?? model.defaultHeight ?? 480;
      const numFrames = input.numFrames ?? model.defaultNumFrames ?? 81;
      const animate = Boolean(input.inputImage) && model.supportsImageToVideo === true;
      if (this.supervisor) {
        const size = { width, height, numFrames };
        if (this.selector.launchedId && this.selector.launchedId !== model.id) {
          emitStatus(`Loading ${model.name} (switching models)…`);
          await this.supervisor.stop();
        } else if (
          this.claim &&
          this.supervisor.currentBaseUrl() &&
          (await this.claim.outgrownBy(model, size, animate))
        ) {
          emitStatus(
            animate
              ? 'Restarting the video engine with room to animate your picture…'
              : 'Restarting the video engine with room for a bigger clip…',
          );
          await this.supervisor.stop();
        }
        if (this.claim) {
          this.claim.requestedSize = size;
          this.claim.requestedAnimatesPicture = animate;
        }
        emitStatus('Starting the video engine…');
        baseUrl = (await this.supervisor.ensureRunning()).baseUrl.replace(/\/+$/, '');
      }
      await this.checkCapabilities(baseUrl);

      const fps = input.fps ?? model.defaultFps ?? 16;
      const steps = input.steps ?? model.recommendedSteps ?? 20;
      const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
      const guidanceScale = input.guidanceScale ?? model.guidanceScale;
      log.info(
        `[video] generate engine=sd-cpp model=${model.id} steps=${steps} frames=${numFrames} fps=${fps} size=${width}x${height} i2v=${animate}`,
      );
      const body = buildSdVideoRequestBody(model, {
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        width,
        height,
        numFrames,
        fps,
        steps,
        seed,
        ...(guidanceScale !== undefined ? { guidanceScale } : {}),
        ...(animate && input.inputImage ? { initImage: input.inputImage.data } : {}),
      });

      const out = await runSdVideoJob(body, {
        baseUrl,
        fetchImpl: this.fetchImpl,
        budget: new AwakeBudget(this.timeoutMs),
        ...(input.signal ? { signal: input.signal } : {}),
        cancelGraceMs: () => Math.max(60_000, 2_000 * secondsPerStep),
        onQueued: (position) => emitStatus(`Waiting for ${position} render(s) ahead…`),
      });
      return {
        video: out.video,
        meta: {
          model: model.id,
          seed,
          steps,
          widthPx: width,
          heightPx: height,
          numFrames: out.frameCount > 0 ? out.frameCount : numFrames,
          fps: out.fps > 0 ? out.fps : fps,
          durationMs: Date.now() - started,
          mimeType: out.mimeType,
          engine: 'sd-cpp',
          hasAudio: model.hasAudio,
        },
      };
    } catch (err) {
      throw await this.explainFailure(err, recentLines);
    } finally {
      this.supervisor?.markUsed();
      unsubscribe?.();
      releaseGpu?.();
    }
  }

  /** Once per launch: the loaded weights render video, and the build writes WebM. */
  private async checkCapabilities(baseUrl: string): Promise<void> {
    if (this.checkedBaseUrl === baseUrl) return;
    const res = await this.fetchImpl(`${baseUrl}/sdcpp/v1/capabilities`).catch(() => null);
    if (!res?.ok) return;
    const caps = (await res.json().catch(() => null)) as {
      supported_modes?: unknown;
      output_formats_by_mode?: { vid_gen?: unknown };
    } | null;
    const modes = Array.isArray(caps?.supported_modes) ? caps.supported_modes : [];
    if (!modes.includes('vid_gen')) {
      throw new Error('These model files did not load as a video model in sd.cpp.');
    }
    const formats = caps?.output_formats_by_mode?.vid_gen;
    if (Array.isArray(formats) && !formats.includes('webm')) {
      throw new Error('This sd.cpp build cannot write WebM video. Update Gezel.');
    }
    this.checkedBaseUrl = baseUrl;
  }

  private async explainFailure(err: unknown, recentLines: readonly string[]): Promise<Error> {
    if (err instanceof SdVideoJobCancelledError) {
      if (!err.stopped) await this.supervisor?.stop();
      if (err.timedOut) {
        const hours = Math.round(this.timeoutMs / 3_600_000);
        return new VideoRenderTimedOutError(
          `The clip was not finished after ${hours} hour${hours === 1 ? '' : 's'}, so the render was stopped. Try a shorter or smaller clip.`,
        );
      }
      return new VideoGenerationCancelledError('The video render was stopped.');
    }
    if (recentLines.some((line) => ENGINE_MEMORY_SHORTFALL.test(line))) {
      await this.supervisor?.stop();
      return new VideoCapacityError(
        'The video engine ran out of memory. Try a shorter or smaller clip, or close other models.',
      );
    }
    if (err instanceof SdVideoJobFailedError) {
      const last = recentLines.at(-1);
      return new Error(
        `sd.cpp could not render the clip: ${err.message}${last ? ` (${last})` : ''}`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async listInstalledModels(): Promise<InstalledVideoModelInfo[]> {
    const models = await this.models.listInstalled('sd-cpp');
    return models.map(installedVideoModelInfo);
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
        error: 'No sd.cpp engine is installed with this build.',
      };
    }
    return {
      status: 'ok',
      baseUrl: this.baseUrl,
      ...(this.backend ? { backend: this.backend } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await this.supervisor?.stop();
  }
}
