/**
 * LocalVideoProvider is the video provider for this computer: one model
 * store, two engines. Each render goes to the engine its model was installed
 * for. Renders take turns across both engines, and the other engine is
 * stopped when a render's turn comes, so only one video engine holds memory
 * at a time and none is stopped mid-render. Routes, the machine broker and paired servers call it as
 * they called the diffusers provider before it.
 */

import { type VideoEngine, type VideoEngineEntry, createLogger } from '@bendyline/gezel';
import {
  type InstalledVideoModel,
  type VideoModelManager,
  installedVideoModelInfo,
} from './models.js';
import type {
  InstalledVideoModelInfo,
  VideoEngineHealth,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoModelPullEvent,
  VideoProvider,
} from './types.js';
import { VideoGenerationCancelledError } from './types.js';

const log = createLogger('video');

function notifyStatus(input: VideoGenerationInput, message: string): void {
  try {
    input.onStatus?.(message);
  } catch {
    /* a listener's error never stops a render */
  }
}

/** Resolves when `turn` settles; rejects as cancelled the moment `signal` aborts. */
function untilSettledOrAborted(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  const cancelled = () => new VideoGenerationCancelledError('The video render was stopped.');
  if (!signal) return turn;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export interface LocalVideoProviderOptions {
  models: VideoModelManager;
  engines: Readonly<Record<VideoEngine, VideoProvider>>;
  /** The person's chosen default (Settings → Video generation), read per render. */
  defaultModelId: () => string | undefined;
}

export class LocalVideoProvider implements VideoProvider {
  readonly name = 'local';
  private readonly models: VideoModelManager;
  private readonly engines: Readonly<Record<VideoEngine, VideoProvider>>;
  private readonly defaultModelId: () => string | undefined;
  /**
   * Renders run one at a time across both engines. Stopping the other engine
   * is only safe once its render has finished: stop() does not wait for work
   * in flight, so a picture-to-video request on sd.cpp used to end an
   * hour-long diffusers render that was still running.
   */
  private renderTail: Promise<void> = Promise.resolve();
  private rendersInFlight = 0;

  constructor(opts: LocalVideoProviderOptions) {
    this.models = opts.models;
    this.engines = opts.engines;
    this.defaultModelId = opts.defaultModelId;
  }

  /** The model a render uses: the one asked for, else the configured default, else the first installed. */
  async resolveRenderModel(requested: string | undefined): Promise<InstalledVideoModel | null> {
    if (requested) return this.models.resolveModel(requested);
    const configured = this.defaultModelId();
    return (
      (configured ? await this.models.resolveModel(configured) : null) ??
      (await this.models.resolveDefaultModel())
    );
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const model = await this.resolveRenderModel(input.model);
    if (!model) {
      throw new Error(
        input.model
          ? `Video model '${input.model}' is not available locally. Download it in Settings → Video generation, or omit \`model\` to use the default.`
          : 'No video model is available locally. Download one from Settings → Video generation before generating.',
      );
    }
    const previous = this.renderTail;
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => {
      finished = resolve;
    });
    // The next render waits for this one AND everything before it, so a
    // render cancelled while queued never lets a later one start early.
    this.renderTail = previous.then(() => mine);
    const waits = this.rendersInFlight > 0;
    this.rendersInFlight += 1;
    try {
      if (waits) notifyStatus(input, 'Waiting for another video to finish…');
      await untilSettledOrAborted(previous, input.signal);
      const engine = this.engines[model.engine];
      for (const [name, other] of Object.entries(this.engines)) {
        if (name === model.engine) continue;
        await other.shutdown?.().catch((err: unknown) => {
          log.warn(
            `[video] could not stop the ${name} engine before a ${model.engine} render: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return await engine.generate({ ...input, model: model.id });
    } finally {
      this.rendersInFlight -= 1;
      finished();
    }
  }

  async listInstalledModels(): Promise<InstalledVideoModelInfo[]> {
    const models = await this.models.listInstalled();
    return models.map(installedVideoModelInfo);
  }

  pullModel(id: string, signal?: AbortSignal): AsyncIterable<VideoModelPullEvent> {
    return this.models.install(id, signal);
  }

  async deleteModel(id: string): Promise<void> {
    await this.models.delete(id);
  }

  /** The diffusers engine's health, which carries the accelerator the Settings page explains. */
  async health(): Promise<VideoEngineHealth> {
    const diffusers = await this.engines.diffusers.health();
    if (diffusers.status === 'ok') return diffusers;
    const sdCpp = await this.engines['sd-cpp'].health();
    return sdCpp.status === 'ok'
      ? { ...sdCpp, ...(diffusers.accelerator ? { accelerator: diffusers.accelerator } : {}) }
      : diffusers;
  }

  /** Every engine, for the Settings page's per-engine readout. */
  async engineHealth(): Promise<VideoEngineEntry[]> {
    const installed = await this.models.listInstalled();
    return Promise.all(
      (Object.keys(this.engines) as VideoEngine[]).map(async (engine) => {
        const health = await this.engines[engine].health();
        const backend = health.backend ?? health.accelerator;
        return {
          engine,
          status: health.status,
          ...(backend ? { backend } : {}),
          ...(health.error ? { error: health.error } : {}),
          modelCount: installed.filter((m) => m.engine === engine).length,
        };
      }),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(Object.values(this.engines).map((e) => e.shutdown?.()));
  }
}
