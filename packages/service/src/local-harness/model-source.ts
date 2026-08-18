import type { ProviderName } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { resolveCatalogIdFromModelId } from '../providers/catalog-model-config.js';
import type { ModelInfo } from '../providers/types.js';

export type LocalHarnessNativeProvider = 'llama-cpp' | 'mlx' | 'ds4';

const LOCAL_HARNESS_NATIVE_PROVIDERS = new Set<ProviderName>(['llama-cpp', 'mlx', 'ds4']);
const DEFAULT_PROVIDER_DEADLINE_MS = 8_000;
const PROVIDER_DEADLINE_EXPIRED = Symbol('local-harness-provider-deadline-expired');

export interface LocalHarnessModelSourceOptions {
  catalog: CatalogService;
  /** Runtime inventory. This may be local disk metadata or machine-broker discovery. */
  listModels(provider: ProviderName, signal: AbortSignal): Promise<ModelInfo[]>;
  /**
   * Resolve the window the native engine can admit for this model on this
   * device. Implementations must remain non-binding: local daemons use
   * previewLocalEnginePlan; user daemons with a machine broker use its
   * `/v1/remote/admit` preflight.
   *
   * Price the model as the only resident engine. The result is written to a
   * durable harness config on disk, so it must describe the device rather than the
   * instant — a window that shrinks because another model happened to be warm
   * would be frozen into the file and read back long after that engine exited.
   */
  resolveNativeContextWindow(
    provider: LocalHarnessNativeProvider,
    modelId: string,
    signal: AbortSignal,
  ): Promise<number | undefined>;
  /** Per-provider inventory + admission deadline. Overridable for focused tests. */
  providerDeadlineMs?: number;
}

/**
 * Build the model callback consumed by every local-harness setup manager.
 *
 * ChatManager's general settings inventory intentionally favors cheap display
 * metadata: native entries currently carry a blanket supportsTools=true and
 * their model-max context. Neither is strong enough for a coding harness. This
 * source replaces both values before the setup manager sees them:
 *
 * - known native models must be explicitly tool-capable in the live catalog;
 * - Ollama/catalog aliases use catalog capability when known, then its runtime
 *   family probe for third-party tags;
 * - native context is the post-memory-admission value, never the raw model max;
 * - models whose capability or effective context cannot be proven are omitted.
 */
export function createLocalHarnessModelSource(
  opts: LocalHarnessModelSourceOptions,
): (provider: ProviderName) => Promise<ModelInfo[]> {
  return async (provider) => {
    const deadlineMs = positiveDeadline(opts.providerDeadlineMs);
    const result = await beforeDeadline(async (signal) => {
      const nativeProvider = isLocalHarnessNativeProvider(provider) ? provider : null;
      const models = await opts.listModels(provider, signal);
      const resolved = await Promise.all(
        models.map(async (model): Promise<ModelInfo | null> => {
          const catalogModel = await resolveCatalogModel(opts.catalog, model.id);
          const supportsTools = nativeProvider
            ? catalogModel?.supportsTools === true
            : (catalogModel?.supportsTools ?? model.supportsTools) === true;
          if (!supportsTools) return null;

          const contextWindow = nativeProvider
            ? await opts
                .resolveNativeContextWindow(nativeProvider, model.id, signal)
                .catch(() => undefined)
            : model.contextWindow;
          if (!isPositiveContextWindow(contextWindow)) return null;

          return {
            ...model,
            name: catalogModel?.name ?? model.name,
            supportsTools: true,
            contextWindow: Math.floor(contextWindow),
            ...(catalogModel?.emitsReasoning !== undefined
              ? { supportsReasoning: catalogModel.emitsReasoning }
              : {}),
          };
        }),
      );
      return resolved.filter((model): model is ModelInfo => model !== null);
    }, deadlineMs);
    // Setup/status/reconcile must not wedge daemon start or shutdown because a
    // local provider (notably Ollama's /api/tags) stopped responding. Fail the
    // entire provider closed rather than publishing a partially-proven list.
    return result === PROVIDER_DEADLINE_EXPIRED ? [] : result;
  };
}

function positiveDeadline(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PROVIDER_DEADLINE_MS;
}

async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T | typeof PROVIDER_DEADLINE_EXPIRED> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const guardedWork: Promise<T | typeof PROVIDER_DEADLINE_EXPIRED> = work(controller.signal).then(
      (value): T | typeof PROVIDER_DEADLINE_EXPIRED =>
        controller.signal.aborted ? PROVIDER_DEADLINE_EXPIRED : value,
      (error: unknown): T | typeof PROVIDER_DEADLINE_EXPIRED => {
        if (controller.signal.aborted) return PROVIDER_DEADLINE_EXPIRED;
        throw error;
      },
    );
    return await Promise.race<T | typeof PROVIDER_DEADLINE_EXPIRED>([
      guardedWork,
      new Promise<typeof PROVIDER_DEADLINE_EXPIRED>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(
            new DOMException('Local harness model discovery timed out', 'TimeoutError'),
          );
          resolve(PROVIDER_DEADLINE_EXPIRED);
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isLocalHarnessNativeProvider(
  provider: ProviderName,
): provider is LocalHarnessNativeProvider {
  return LOCAL_HARNESS_NATIVE_PROVIDERS.has(provider);
}

function isPositiveContextWindow(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function resolveCatalogModel(
  catalog: CatalogService,
  modelId: string,
): Promise<{ name: string; supportsTools: boolean; emitsReasoning?: boolean } | null> {
  const catalogId = await resolveCatalogIdFromModelId(catalog, modelId);
  if (!catalogId) return null;
  try {
    const detail = await catalog.get('chat-model', catalogId);
    if (!detail || detail.manifest.kind !== 'chat-model') return null;
    const reasoningFormat = detail.manifest.style?.reasoningFormat;
    return {
      name: detail.manifest.name,
      supportsTools: detail.manifest.supportsTools,
      // Native providers report no reasoning capability at all — their
      // `listModels` returns id/name/supportsTools and nothing else — so a
      // harness is told every local model is non-thinking and renders its
      // `<think>` block as answer text. The catalog has always known better:
      // `style.reasoningFormat` describes exactly how a model wraps
      // chain-of-thought, and `none` is the only value that means it does not.
      ...(reasoningFormat ? { emitsReasoning: reasoningFormat !== 'none' } : {}),
    };
  } catch {
    return null;
  }
}
