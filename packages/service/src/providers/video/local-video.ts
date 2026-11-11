/**
 * LocalVideoProvider is the video provider for this computer: one model
 * store, two engines. Each render goes to the engine its model was installed
 * for, and the other engine is stopped first, so only one video engine holds
 * memory at a time. Routes, the machine broker and paired servers call it as
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

const log = createLogger('video');

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
    const engine = this.engines[model.engine];
    for (const [name, other] of Object.entries(this.engines)) {
      if (name === model.engine) continue;
      await other.shutdown?.().catch((err: unknown) => {
        log.warn(
          `[video] could not stop the ${name} engine before a ${model.engine} render: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return engine.generate({ ...input, model: model.id });
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
