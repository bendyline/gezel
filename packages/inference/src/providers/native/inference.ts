import type { ModelInfo } from '@bendyline/gezel';
import type { LLMProvider, ProviderName } from '../types.js';
import { isLocalProvider } from './engine-key.js';
import { LocalEngineRuntime } from './local-engine-runtime.js';

/** The HTTP inference surface has no product chat/session or tool methods. */
export interface NativeInference extends Pick<LocalEngineRuntime, keyof LocalEngineRuntime> {
  getProviderForModel(
    name: ProviderName,
    modelId?: string,
    opts?: { engineDrainWaitMs?: number },
  ): Promise<LLMProvider>;
  listModelsForProvider(name: ProviderName, signal?: AbortSignal): Promise<ModelInfo[]>;
  resetClient(opts?: { deferBusy?: boolean }): Promise<void>;
}

/** Machine-only consumer of the same admission, provider pool and cache owner as product chat. */
export class EngineInference extends LocalEngineRuntime implements NativeInference {
  private closing = false;
  beginShutdown(): void {
    this.closing = true;
  }

  private readonly pending = new Set<Promise<LLMProvider>>();

  getProviderForModel(
    name: ProviderName,
    modelId?: string,
    opts: { engineDrainWaitMs?: number } = {},
  ): Promise<LLMProvider> {
    if (!isLocalProvider(name))
      return Promise.reject(new Error(`The machine engine cannot serve provider ${name}`));
    if (this.closing) return Promise.reject(new Error('Engine inference is shutting down'));
    const request = this.getLocalProviderForModel(name, modelId, opts, async () => {
      throw new Error(`No installed ${name} model is selected`);
    });
    this.pending.add(request);
    void request.then(
      () => this.pending.delete(request),
      () => this.pending.delete(request),
    );
    return request;
  }

  async listModelsForProvider(name: ProviderName): Promise<ModelInfo[]> {
    if (!isLocalProvider(name)) return [];
    const manager =
      name === 'mlx' ? this.mlxModels : name === 'ds4' ? this.ds4Models : this.llamaCppModels;
    return installedModelInfos((await manager?.listInstalled()) ?? []);
  }

  async resetClient(opts?: { deferBusy?: boolean }): Promise<void> {
    await this.releaseIdleOwnedEngines();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    await this.shutdownOwnedEngineRouter();
  }
}

export function installedModelInfos(
  models: Array<{ id: string; name: string; approxSizeBytes: number; contextWindow?: number }>,
): ModelInfo[] {
  return models.map((model) => {
    const sizeGb = model.approxSizeBytes / 1024 ** 3;
    const sizeLabel = sizeGb >= 0.1 ? ` · ${sizeGb.toFixed(1)} GB` : '';
    const ctxLabel = model.contextWindow ? ` · ${Math.round(model.contextWindow / 1024)}k ctx` : '';
    return {
      id: model.id,
      name: `${model.name}${sizeLabel}${ctxLabel}`,
      supportsTools: true,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    };
  });
}
