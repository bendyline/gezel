import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { type GezelConfig, estimateLlamaCppResidentBytes } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { MlxRuntimeStatusBus } from '../../python/mlx-runtime-status-bus.js';
import { resolveCatalogLlamaCppEngineConfig } from '../catalog-model-config.js';
import { buildDs4Provider, resolveDs4LaunchCtx } from '../ds4/build-provider.js';
import { buildLlamaCppProvider, ensureLlamaEngineStatus } from '../llama-cpp/build-provider.js';
import { readGgufSummaryAsync } from '../llama-cpp/gguf-metadata-async.js';
import type { GgufSummary } from '../llama-cpp/gguf-metadata.js';
import {
  type LlamaCppKvCacheType,
  isGemmaModel,
  planLlamaCppKv,
  resolveLlamaCppKvCacheType,
} from '../llama-cpp/kv-cache-type.js';
import {
  estimateExactPerSlotKvBytesF16,
  estimateKvReserveBytes,
  estimateWindowedKvLinearization,
} from '../llama-cpp/offload-planner.js';
import { buildMlxProvider, resolveMlxEffectiveNumCtx } from '../mlx/build-provider.js';
import { readMlxModelGeometry } from '../mlx/model-geometry.js';
import { type LLMProvider, ModelNotInstalledError, type ProviderName } from '../types.js';
import { mmprojBudgetBytes, nativeVisionEnabledFor } from '../vision-capability.js';
import {
  type CapacityCommitted,
  CapacityDeniedError,
  availableSystemRamBytes,
  formatContextCapacityDenial,
  minViableLocalContextTokens,
  resolveLlamaCppContextRequirement,
} from './capacity-broker.js';
import { engineApiKey } from './engine-api-key.js';
import {
  type LocalProviderName,
  isLocalProvider,
  makeEngineKey,
  parseEngineKey,
} from './engine-key.js';

export interface EngineConfigStore {
  readonly homePath: string;
  readConfig(): Promise<GezelConfig>;
  writeConfig(config: Partial<Record<keyof GezelConfig, unknown>>): Promise<GezelConfig>;
}
export interface LocalEngineRuntimeOptions {
  home: string;
  store: EngineConfigStore;
  catalog: CatalogService;
  llamaCppModels?: import('../llama-cpp/index.js').LlamaCppModelManager;
  ds4Models?: import('../llama-cpp/index.js').LlamaCppModelManager;
  mlxModels?: import('../mlx/index.js').MlxModelManager;
  uvRuntime?: import('../../python/uv-runtime.js').UvRuntime;
  mlxRuntimeStatus?: MlxRuntimeStatusBus;
  cacheController?: import('../../cache/controller.js').SessionCacheController;
  gpuArbiter?: import('../gpu-arbiter.js').GpuArbiter;
  engineBinaries?: import('../../engines/registry.js').EngineBinaryRegistry;
  engineRouter?: import('./engine-router.js').EngineRouter;
}
const log = createLogger('engines');
/** Native engine lifetime, admission, and cache control. No product sessions or tools. */
export class LocalEngineRuntime {
  protected readonly store: EngineConfigStore;
  constructor(opts: LocalEngineRuntimeOptions) {
    this.store = opts.store;
    this.catalog = opts.catalog;
    this.llamaCppModels = opts.llamaCppModels;
    this.ds4Models = opts.ds4Models;
    this.mlxModels = opts.mlxModels;
    this.uvRuntime = opts.uvRuntime;
    this.mlxRuntimeStatus = opts.mlxRuntimeStatus;
    this.home = opts.home;
    this.cacheController = opts.cacheController;
    this.gpuArbiter = opts.gpuArbiter;
    this.engineBinaries = opts.engineBinaries;
    this.engineRouter = opts.engineRouter;
  }
  /** Product chat may prefill its own sessions; the engine runtime never resolves them. */
  protected async prefillCacheSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  /** Cached provider instances keyed by provider name. */
  protected readonly providers = new Map<ProviderName, LLMProvider>();

  protected readonly catalog: CatalogService;

  protected readonly llamaCppModels?: import('../llama-cpp/index.js').LlamaCppModelManager;

  protected readonly ds4Models?: import('../llama-cpp/index.js').LlamaCppModelManager;

  protected readonly mlxModels?: import('../mlx/index.js').MlxModelManager;

  protected readonly uvRuntime?: import('../../python/uv-runtime.js').UvRuntime;

  protected readonly mlxRuntimeStatus?: MlxRuntimeStatusBus;

  protected readonly home: string;

  protected readonly cacheController?: import('../../cache/controller.js').SessionCacheController;

  protected readonly gpuArbiter?: import('../gpu-arbiter.js').GpuArbiter;

  protected readonly engineBinaries?: import('../../engines/registry.js').EngineBinaryRegistry;

  readonly engineRouter?: import('./engine-router.js').EngineRouter;

  /**
   * Snapshot of every provider's prompt-cache state. Empty array when
   * no controller is wired (cloud-only install, tests). Polled by the
   * EngineStatusPill alongside `/api/queues` for the popover stats
   * rows. Cheap — pure read of in-memory state.
   */
  getCacheStats(): import('../../cache/controller.js').ProviderCacheStats[] {
    return this.cacheController?.getAllStats() ?? [];
  }

  /**
   * Operator-driven invalidation hook. The /api/cache/evict route
   * calls this to drop a single session's cache; same path the
   * compaction / archive / delete hooks already use internally.
   */
  invalidateSessionCache(sessionId: string): void {
    this.cacheController?.invalidate(sessionId);
  }

  /**
   * Operator-driven full-provider eviction. Same hook the resetClient
   * path uses; surfaced on /api/cache/clear so an operator can punt
   * stale state without waiting for credential rotation.
   */
  invalidateProviderCache(providerName: string): void {
    this.cacheController?.invalidateProvider(providerName);
  }

  /**
   * Live-update the controller's per-provider budget. Called from the
   * config PUT handler when the operator changes `cacheBudgetMb` —
   * eviction kicks in immediately if the new budget is below current
   * usage. No-op if no controller is wired.
   */
  setCacheBudget(providerName: string, bytes: number): void {
    this.cacheController?.setBudget(providerName, bytes);
  }

  /**
   * Live-update the capacity broker's total budget for resident local
   * engines. Called from the config PUT handler when the operator moves the
   * memory slider (`localEngineMemoryGb`); `null` reverts to the host's
   * auto-derived value.
   *
   * No-op when no router exists yet — {@link buildEngineRouter} reads the
   * config itself, so a router built later already picks the new value up.
   * The in-flight case is the one that needs care: a build that read the
   * config *before* this write would otherwise install the stale budget and
   * keep it until shutdown, so chain onto the pending promise rather than
   * only checking the resolved cache.
   */
  async setLocalEngineMemoryBudget(bytes: number | null): Promise<void> {
    const live = this.engineRouter ?? this.engineRouterCache;
    if (live) {
      live.broker.setBudgetBytes(bytes);
      return;
    }
    const pending = this.engineRouterInitPromise;
    if (!pending) return;
    const router = await pending.catch(() => null);
    router?.broker.setBudgetBytes(bytes);
  }

  /**
   * Live-update whether co-resident local models may spill into system RAM.
   * `null` reverts to the host's auto choice. Same in-flight care as
   * {@link setLocalEngineMemoryBudget}, and the same non-eviction contract:
   * turning spillover off doesn't unload anything, it changes what the next
   * spawn is allowed to add.
   */
  async setAllowRamSpillover(allow: boolean | null): Promise<void> {
    const live = this.engineRouter ?? this.engineRouterCache;
    if (live) {
      live.broker.setAllowRamSpillover(allow);
      return;
    }
    const pending = this.engineRouterInitPromise;
    if (!pending) return;
    const router = await pending.catch(() => null);
    router?.broker.setAllowRamSpillover(allow);
  }

  /** Return the provider if it has already been initialized; never creates one. */
  getProviderIfReady(name: ProviderName): LLMProvider | null {
    return this.providers.get(name) ?? null;
  }

  /**
   * Lazily construct the multi-engine router using the engine runtime’s
   * already-resolved deps (store, catalog, llamaCppModels, ds4Models, mlxModels,
   * uvRuntime). Once built, the router owns the {@link ProviderPool}
   * and {@link CapacityBroker}; subsequent calls return the cached
   * instance.
   *
   * Returns `null` when {@link LocalEngineRuntimeOptions.engineRouter} was
   * explicitly injected — that path is owned by the caller (typically
   * tests). The lazy build is only for production wiring through
   * `service.ts`.
   */
  protected engineRouterCache: import('./engine-router.js').EngineRouter | null = null;

  protected engineRouterInitPromise: Promise<
    import('./engine-router.js').EngineRouter | null
  > | null = null;

  /**
   * Shut down the production-owned lazy engine router, including a router
   * whose construction is still in flight. Pooled local providers do not live
   * in {@link providers}, so omitting this step lets their native children
   * outlive gezeld and become PPID-1 orphans.
   *
   * An explicitly injected {@link engineRouter} remains caller-owned (mostly
   * a test seam) and is deliberately left alone.
   */
  protected async shutdownOwnedEngineRouter(): Promise<void> {
    let router = this.engineRouterCache;
    const pending = this.engineRouterInitPromise;
    if (!router && pending) {
      try {
        router = await pending;
      } catch {
        // A failed construction owns no resident providers, but clear the
        // rejected one-flight so a live hard reset can try again later.
      }
    }
    this.engineRouterCache = null;
    this.engineRouterInitPromise = null;
    if (!router) return;
    try {
      await router.shutdown();
    } catch (err) {
      log.warn(
        `engine router shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Free the memory a live reset can free without severing anything: evict
   * every resident engine that is idle right now and leave the rest to the
   * pool's ordinary lifecycle. The router itself stays — dropping it while an
   * engine is still serving a turn would orphan that process outside the
   * broker's accounting, which is the reason the old path force-killed
   * everything instead.
   *
   * An explicitly injected {@link engineRouter} remains caller-owned and is
   * left alone, same rule as {@link shutdownOwnedEngineRouter}. A router
   * whose construction is still in flight owns no resident engines yet, so
   * this deliberately does not await it.
   */
  protected async releaseIdleOwnedEngines(): Promise<void> {
    const router = this.engineRouterCache;
    if (!router) return;
    try {
      const busy = await router.releaseIdle();
      if (busy.length > 0) {
        log.info(
          `[chat] reset kept ${busy.length} busy engine(s) resident (${busy.join(', ')}) — they unload when their turns finish`,
        );
      }
    } catch (err) {
      log.warn(`engine release-idle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Resolve (or build) the router. Returns `null` only when no local
   * provider is wired up at all (cloud-only installs); production
   * installs with `llamaCppModels`, `ds4Models`, or `mlxModels` set always get a
   * router. Callers MUST tolerate a `null` return — the legacy
   * singleton path takes over.
   */
  protected async getEngineRouter(): Promise<import('./engine-router.js').EngineRouter | null> {
    if (this.engineRouter) return this.engineRouter;
    if (this.engineRouterCache) return this.engineRouterCache;
    if (!this.llamaCppModels && !this.ds4Models && !this.mlxModels) return null;
    if (this.engineRouterInitPromise) return this.engineRouterInitPromise;
    this.engineRouterInitPromise = this.buildEngineRouter().then((r) => {
      this.engineRouterCache = r;
      return r;
    });
    return this.engineRouterInitPromise;
  }

  protected async buildEngineRouter(): Promise<import('./engine-router.js').EngineRouter | null> {
    const { EngineRouter } = await import('./engine-router.js');
    const { CapacityBroker } = await import('./capacity-broker.js');
    const { ProviderPool } = await import('./provider-pool.js');
    const { GpuPanicGuard } = await import('./gpu-panic-guard.js');
    const gpuPanicGuard = new GpuPanicGuard();
    const config = await this.store.readConfig();
    const budgetBytes =
      typeof config.localEngineMemoryGb === 'number'
        ? Math.round(config.localEngineMemoryGb * 1024 ** 3)
        : undefined;
    // Measure the accelerator before deriving the budget. Without this the
    // broker sizes a discrete-GPU host off system RAM alone — the shape that
    // told a 64 GB / 24 GB-VRAM box its models get "60% of your 63.9 GB
    // machine" and then refused a model that fit the card plus offload.
    // The probe caches, and a failure degrades to the RAM-only curve.
    const memoryProfile = await (async () => {
      try {
        const { detectMemoryProfileCached } = await import('../../system/memory.js');
        return await detectMemoryProfileCached();
      } catch {
        return null;
      }
    })();
    const broker = new CapacityBroker({
      ...(budgetBytes !== undefined ? { budgetBytes } : {}),
      gpuVramBytes: memoryProfile?.gpuVramBytes ?? null,
      ...(memoryProfile
        ? {
            unifiedMemory:
              memoryProfile.gpuMemoryKind === 'integrated' ||
              memoryProfile.gpuMemoryKind === 'unified',
          }
        : {}),
      allowRamSpillover: config.allowRamSpillover ?? null,
    });
    const pool = new ProviderPool({ broker, builders: {} });

    // Builders close over `this` so they can re-read config and use the
    // already-resolved model managers / runtimes. Each replica goes
    // through the same factories as the singleton path, with
    // `modelOverride` set to pin the modelId + replicaIdx.
    const llamaBuilder: import('./provider-pool.js').ProviderBuilder = async ({
      modelId,
      replicaIdx,
    }) => {
      const cfg = await this.store.readConfig();
      const affinity = cfg.providerQueue?.affinity;
      const eb = this.engineBinaries;
      const provider = await buildLlamaCppProvider({
        config: cfg,
        affinity,
        home: this.home,
        ...(this.llamaCppModels ? { llamaCppModels: this.llamaCppModels } : {}),
        ...(this.gpuArbiter ? { arbiter: this.gpuArbiter } : {}),
        ...(eb ? { ensureEngine: () => ensureLlamaEngineStatus(eb, cfg) } : {}),
        catalog: this.catalog,
        modelOverride: { modelId, replicaIdx },
        // Pool path: lets the slot ceiling see co-resident reservations.
        broker,
      });
      await this.initLocalProvider('llama-cpp', provider, cfg);
      // Prefer the launch admission's own reservation (weights + KV at the
      // granted window) over the catalog/weights-multiplier estimate — the
      // ledger otherwise carries zero KV and under-reserves dense models
      // whose KV rivals their weights (M1).
      const bytes =
        provider.plannedReservationBytes?.() ??
        (await this.resolveResidentBytes('llama-cpp', modelId));
      const installed = await this.llamaCppModels?.resolveModel(modelId).catch(() => null);
      return {
        provider,
        residentBytes: bytes,
        ...(installed?.approxSizeBytes ? { modelWeightsBytes: installed.approxSizeBytes } : {}),
      };
    };

    const mlxBuilder: import('./provider-pool.js').ProviderBuilder = async ({
      modelId,
      replicaIdx,
    }) => {
      const cfg = await this.store.readConfig();
      const affinity = cfg.providerQueue?.affinity;
      const provider = await buildMlxProvider({
        config: cfg,
        affinity,
        store: this.store,
        ...(this.mlxModels ? { mlxModels: this.mlxModels } : {}),
        ...(this.uvRuntime ? { uvRuntime: this.uvRuntime } : {}),
        ...(this.mlxRuntimeStatus ? { mlxRuntimeStatus: this.mlxRuntimeStatus } : {}),
        ...(this.gpuArbiter ? { arbiter: this.gpuArbiter } : {}),
        modelOverride: { modelId, replicaIdx },
        broker,
      });
      await this.initLocalProvider('mlx', provider, cfg);
      // Same M1 preference as the llama-cpp builder: the launch admission's
      // weights+KV reservation over the catalog/weights-multiplier fallback.
      const bytes =
        provider.plannedReservationBytes?.() ?? (await this.resolveResidentBytes('mlx', modelId));
      const installed = await this.mlxModels?.resolveModel(modelId).catch(() => null);
      return {
        provider,
        residentBytes: bytes,
        ...(installed?.approxSizeBytes ? { modelWeightsBytes: installed.approxSizeBytes } : {}),
      };
    };

    const ds4Builder: import('./provider-pool.js').ProviderBuilder = async ({
      modelId,
      replicaIdx,
    }) => {
      const cfg = await this.store.readConfig();
      const affinity = cfg.providerQueue?.affinity;
      const provider = await buildDs4Provider({
        config: cfg,
        affinity,
        home: this.home,
        ...(this.ds4Models ? { ds4Models: this.ds4Models } : {}),
        ...(this.gpuArbiter ? { arbiter: this.gpuArbiter } : {}),
        catalog: this.catalog,
        modelOverride: { modelId, replicaIdx },
        broker,
      });
      await this.initLocalProvider('ds4', provider, cfg);
      const bytes = await this.resolveResidentBytes('ds4', modelId);
      const installed = await this.ds4Models?.resolveModel(modelId).catch(() => null);
      return {
        provider,
        residentBytes: bytes,
        ...(installed?.approxSizeBytes ? { modelWeightsBytes: installed.approxSizeBytes } : {}),
      };
    };

    const builders: Partial<
      Record<LocalProviderName, import('./provider-pool.js').ProviderBuilder>
    > = {};
    if (this.llamaCppModels) builders['llama-cpp'] = llamaBuilder;
    if (this.mlxModels) builders.mlx = mlxBuilder;
    // ds4 has no model-manager gate (v1 resolves its GGUF from an explicit
    // path / external URL, not the catalog dir) — always register it; the
    // builder throws an actionable error when neither a ds4-server binary
    // nor an external URL is configured, and the M5 availability probe hides
    // ds4 in the UI on unsupported platforms.
    builders.ds4 = ds4Builder;

    // Replace the empty pool with one that holds the actual builders.
    const realPool = new ProviderPool({
      broker,
      builders,
      gpuPanicGuard,
      // The arbiter already reads device-wide accelerator memory for the idle
      // release hint; the pool needs the same number to refuse a spawn onto a
      // card another process has filled.
      ...(this.gpuArbiter
        ? { vramHeadroom: () => this.gpuArbiter!.getMemoryPressureStatus() }
        : {}),
    });
    return new EngineRouter({
      broker,
      pool: realPool,
      builders,
      resolveResidentBytes: (provider, modelId) => {
        // Synchronous lookup; we cache the catalog read inside
        // `resolveResidentBytesCache` populated lazily on first
        // builder call. Falls through to broker estimator on miss.
        const cached = this.resolveResidentBytesCache.get(`${provider}:${modelId}`);
        return cached;
      },
    });
  }

  /**
   * Per-replica provider initialization + cache-controller wiring.
   * Mirrors the singleton-path post-construction work inside
   * {@link ensureProvider}, factored out so the pool's builder
   * closures can share it. Cache-controller registration is gated
   * on replica index — only replica 0 registers, because the
   * controller is keyed by provider name and N adapters would
   * collide.
   */
  protected async initLocalProvider(
    name: LocalProviderName,
    provider: LLMProvider,
    config: GezelConfig,
  ): Promise<void> {
    try {
      await provider.initialize();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const actionable =
        err instanceof Error && (err as Error & { isActionable?: boolean }).isActionable === true;
      throw new Error(
        actionable
          ? message
          : `${name} provider failed to start: ${message}. Go to Settings and check your credentials.`,
      );
    }
    // Wire the engine's prompt-cache adapter. Without this, pool-built
    // providers (the default path for local engines) have
    // `cacheAdapter = null` — every send re-attaches cache_id to the
    // request body, the wrapped engine clears its KV cache on stream
    // end, and each tool-loop iteration pays the full prefill cost
    // again. Wild-caught on a gemma4-26b/MLX Meester loop:
    // 11+ tool-loop iterations, ~10s of prefill per turn, no cache
    // hits in Python logs because the request body never carried
    // `cache_id`. `ensureProvider` already had this wiring inline;
    // pulling it out so both call sites share one source of truth.
    await this.wireLocalProviderCacheAdapter(name, provider, config);
  }

  /**
   * Construct the engine's `EngineCacheAdapter`, register it with the
   * shared `cacheController`, and attach it to the provider so every
   * subsequent send carries cache extras. Idempotent at the controller
   * level — `registerAdapter` overwrites by `providerName`, so calling
   * this for two replicas of the same provider just keeps the
   * most-recently-registered adapter in the controller's tracking.
   * Each provider still gets its own per-replica adapter via
   * `setCacheAdapter`. Returns early when no controller is wired
   * (test paths) or the provider isn't a local engine.
   */
  protected async wireLocalProviderCacheAdapter(
    name: LocalProviderName,
    provider: LLMProvider,
    config: GezelConfig,
  ): Promise<void> {
    if (!this.cacheController) return;
    // ds4 manages its own KV persistence (`--kv-disk-dir`, token-text
    // keyed), so its adapter attaches nothing per request and can't evict
    // or inspect — its one real capability is `warm`: a prefill-only
    // request that runs the (minutes-long, SSD-streamed) conversation
    // prefill while the user is still reading, so the next real turn
    // lands on hot KV. Wired to the OUTER Ds4Provider only — the inner
    // llama provider's send path expects the llama-specific slot adapter.
    if (name === 'ds4') {
      const ds4Provider = provider as import('../ds4/provider.js').Ds4Provider;
      const { Ds4CacheAdapter } = await import('../ds4/cache-adapter.js');
      const innerLlama = ds4Provider.llamaCpp;
      const adapter = new Ds4CacheAdapter({
        resolveBaseUrl: async () => innerLlama.currentBaseUrl(),
        isBusy: () => {
          const snap = ds4Provider.queue?.snapshot();
          if (!snap) return false;
          return snap.running > 0 || snap.queuedInteractive > 0;
        },
        // Route the warm through the session's OWN request assembly so
        // the warmed prefix is byte-identical to the next real turn's
        // prompt (ds4 KV is prefix-keyed from token 0 — a hand-built
        // transcript request stores a key no real turn can hit). The
        // ensureState here also pre-builds the MCP bridge + provider
        // session — work the real turn needs anyway, done early.
        prefillSession: async (sessionId) => {
          return this.prefillCacheSession(sessionId);
        },
      });
      this.cacheController.registerAdapter(adapter);
      ds4Provider.setCacheAdapter(adapter);
    } else if (name === 'llama-cpp') {
      type LlamaCppProviderType = import('../llama-cpp/provider.js').LlamaCppProvider;
      const llamaProvider = provider as LlamaCppProviderType;
      const { LlamaCppCacheAdapter } = await import('../llama-cpp/cache-adapter.js');
      const llamaSlotSavePath = llamaProvider.getSlotSavePath();
      const adapter = new LlamaCppCacheAdapter({
        resolveBaseUrl: async () => llamaProvider.currentBaseUrl(),
        // `/slots` is an AUTHENTICATED endpoint — only `/health` answers
        // without the key (see engine-api-key.ts). The provider authenticates
        // because `build-provider` wraps its fetch in `withEngineApiKey`, but
        // the adapter is constructed here with a bare `fetch`, so without this
        // it sent no Authorization header and every call 401'd: the `/slots`
        // usage poll AND both `?action=save|restore` calls, i.e. the whole
        // disk KV persistence layer, silently dead. It failed quietly because
        // each call site degrades on error by design (no cache entry, `disk
        // save: MISSED`) — the only symptom was cold prefills and a 5-second
        // drip of `unauthorized: Invalid API Key` in the engine log, ~300 per
        // trial. Resolved per call, not captured: the key is generated lazily.
        resolveAuthToken: () => engineApiKey(),
        // The ENGINE slot count (`--parallel N`), not `queue.concurrency`:
        // the queue reserves a background lane above the engine slots, so
        // on a single-slot launch it reads 2 and the adapter would bind
        // sessions to slot ids the server doesn't have (wild-caught
        // 2026-08-03 — save/restore against the phantom slot 400s
        // silently).
        slotCount: llamaProvider.getLaunchedSlots(),
        ...(llamaSlotSavePath ? { slotSavePath: llamaSlotSavePath } : {}),
      });
      this.cacheController.registerAdapter(adapter);
      llamaProvider.setCacheAdapter(adapter);
    } else if (name === 'mlx') {
      const mlxProvider = provider as import('../mlx/provider.js').MlxProvider;
      const { MlxCacheAdapter } = await import('../mlx/cache-adapter.js');
      const adapter = new MlxCacheAdapter({
        resolveBaseUrl: async () => mlxProvider.currentBaseUrl(),
        runExclusive: (label, work) => mlxProvider.runExclusiveEngineRequest(label, work),
      });
      this.cacheController.registerAdapter(adapter);
      mlxProvider.setCacheAdapter(adapter);
    }
  }

  /**
   * Cache of catalog `residentBytes` per `(provider:modelId)`.
   * Populated synchronously by `prefetchResidentBytes` so the
   * router's sync resolver works. Falls back to the broker estimator
   * on miss.
   */
  protected readonly resolveResidentBytesCache = new Map<string, number>();

  /**
   * Drop cached reservations so the next admission re-reads the catalog and
   * config. ds4 prices its footprint at the launch context, so a per-model
   * context override changes what the broker must reserve — leaving the old
   * entry cached would keep billing the pre-override number for the life of
   * the process. Call from any route that mutates context sizing.
   */
  invalidateResidentBytesCache(provider?: LocalProviderName, modelId?: string): void {
    if (!provider) {
      this.resolveResidentBytesCache.clear();
      return;
    }
    if (modelId) {
      this.resolveResidentBytesCache.delete(`${provider}:${modelId}`);
      return;
    }
    for (const key of this.resolveResidentBytesCache.keys()) {
      if (key.startsWith(`${provider}:`)) this.resolveResidentBytesCache.delete(key);
    }
  }

  protected async resolveResidentBytes(
    provider: LocalProviderName,
    modelId: string,
  ): Promise<number> {
    const cacheKey = `${provider}:${modelId}`;
    const cached = this.resolveResidentBytesCache.get(cacheKey);
    if (cached !== undefined) return cached;
    // Read from the catalog. The chat-model manifest carries
    // residentBytes per source block (llamaCpp / ds4 / mlx); fall back to
    // approxSizeBytes * tier multiplier when missing.
    let bytes: number | undefined;
    try {
      const items = await this.catalog.list('chat-model');
      const match = items.find((m) => m.manifest.id === modelId);
      // The discriminated `manifest` union narrows to a chat-model
      // shape via `kind`. Cast through `unknown` because we've
      // already filtered by id from the chat-model list — the kind
      // check would be redundant.
      const cm = match?.manifest as
        | {
            kind: 'chat-model';
            llamaCpp?: {
              residentBytes?: number;
              approxSizeBytes?: number;
              mmproj?: { sizeBytes?: number };
            };
            mlx?: { residentBytes?: number; approxSizeBytes?: number };
            ds4?: {
              residentBytes?: number;
              approxSizeBytes?: number;
              kvBytesPerToken?: number;
              residentCtxTokens?: number;
              maxLaunchCtx?: number;
            };
          }
        | undefined;
      if (cm) {
        const block = provider === 'mlx' ? cm.mlx : provider === 'ds4' ? cm.ds4 : cm.llamaCpp;
        if (block?.residentBytes) {
          bytes = block.residentBytes;
          if (provider === 'ds4') {
            const config = await this.store.readConfig();
            const externalBaseUrl = process.env.GEZEL_DS4_SERVER_URL ?? config.ds4BaseUrl;
            if (!externalBaseUrl) {
              const {
                ds4ProjectedResidentBytes,
                ds4ResidentBytesForMode,
                ds4ResidentLine,
                shouldUseDs4SsdStreaming,
              } = await import('../ds4/residency.js');
              // Bill the window this model will actually launch with. The
              // authored footprint is a measurement at `residentCtxTokens`, so
              // without this a raised context reserves the old number and the
              // broker admits a model whose KV no longer fits — the exact
              // memory-pressure event the residency rules exist to prevent.
              const ds4Block = cm.ds4;
              const line = ds4ResidentLine({
                residentBytes: bytes,
                kvBytesPerToken: ds4Block?.kvBytesPerToken,
                residentCtxTokens: ds4Block?.residentCtxTokens,
              });
              if (line) {
                const { totalmem } = await import('node:os');
                bytes = ds4ProjectedResidentBytes(
                  line,
                  resolveDs4LaunchCtx({
                    configured:
                      config.modelContextOverrides?.[`ds4:${modelId}`] ?? config.ds4NumCtx,
                    ramTieredCtx: totalmem() / 1024 ** 3 >= 192 ? 262_144 : 131_072,
                    catalogMaxCtx: ds4Block?.maxLaunchCtx,
                    minViableContextTokens: minViableLocalContextTokens(),
                  }),
                );
              }
              bytes = ds4ResidentBytesForMode(
                bytes,
                shouldUseDs4SsdStreaming({
                  configured: config.ds4SsdStreaming,
                  modelSizeBytes: block.approxSizeBytes,
                }),
              );
            }
          }
        } else if (block?.approxSizeBytes) {
          const { CapacityBroker } = await import('./capacity-broker.js');
          // `approxSizeBytes` is the weights alone; a multimodal entry also
          // loads its projector, which the catalog sizes separately.
          const mmprojBytes = provider === 'llama-cpp' ? (cm.llamaCpp?.mmproj?.sizeBytes ?? 0) : 0;
          bytes = CapacityBroker.estimateResidentBytes(provider, block.approxSizeBytes, {
            mmprojBytes,
          });
        }
      }
    } catch {
      /* fall through to default */
    }
    if (bytes === undefined) {
      const { CapacityBroker } = await import('./capacity-broker.js');
      bytes = CapacityBroker.estimateResidentBytes(provider, 8 * 1024 ** 3);
    }
    this.resolveResidentBytesCache.set(cacheKey, bytes);
    return bytes;
  }

  /**
   * Reconcile the pool's resident set to match a target clone-count
   * map. Surfaces the Settings → Local Models picker's intent to the
   * runtime: spawn missing replicas (up to capacity) and evict
   * excess. No-op when no router is configured.
   */
  async reconcileEnginePool(
    provider: LocalProviderName,
    target: Record<string, number>,
  ): Promise<void> {
    const router = await this.getEngineRouter();
    if (!router) return;
    await router.reconcileClones(provider, target);
  }

  /**
   * Unload one already-resident local model replica without constructing the
   * engine router as a side effect. The pool rejects the request if the model
   * became busy after the UI's last lifecycle sample.
   */
  async unloadIdleEngine(
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
  ): Promise<boolean> {
    const router = this.engineRouter ?? this.engineRouterCache;
    if (!router || !router.pool.has(makeEngineKey(provider, modelId, replicaIdx))) return false;
    return router.unloadIdle(provider, modelId, replicaIdx);
  }

  /**
   * Snapshot of the live pool — committed bytes, budget, per-key
   * resident set. Surfaced via `GET /api/engines/status`. Returns
   * `null` for installs without a pool wired.
   */
  async engineStatus(): Promise<import('./provider-pool.js').PoolSnapshot | null> {
    const router = await this.getEngineRouter();
    if (!router) return null;
    return router.snapshot();
  }

  /**
   * Read the already-live local-engine pool without constructing the router.
   * Hot status endpoints use this path so opening a telemetry popover never
   * initializes local inference as a side effect.
   */
  peekEngineStatus(): import('./provider-pool.js').PoolSnapshot | null {
    const router = this.engineRouter ?? this.engineRouterCache;
    return router?.snapshot() ?? null;
  }

  /**
   * Live provider-queue summaries for pool-resident local engines, keyed
   * by provider name — the data `/api/queues` needs to reflect pooled
   * work the singleton {@link getProviderIfReady} path can't see (chat
   * turns AND background one-shots). See
   * {@link ProviderPool.queueSummaries} for why the blind spot existed.
   *
   * Synchronous, non-building peek: reads the already-resolved router and
   * returns an empty map when none exists yet. A poll before any local
   * work has run has nothing resident to report anyway — and a status
   * endpoint must never spin the router up as a side effect.
   */
  localEngineQueueSummaries(): Map<
    LocalProviderName,
    import('./provider-pool.js').PooledQueueSummary
  > {
    const router = this.engineRouter ?? this.engineRouterCache;
    if (!router) return new Map();
    return router.pool.queueSummaries();
  }

  /**
   * Launch provenance of every live local engine — the granted context
   * window, slots, and KV dtype each engine ACTUALLY started with, from
   * the supervisors' retained launch payloads. Non-building and cheap:
   * walks resident providers only, never starts an engine. Feeds
   * `/api/system/diagnostics` `localEngines` (Settings → About), so a
   * "model is looping" report carries the grant without log spelunking.
   */
  localEngineLaunchSummaries(): Array<{
    provider: LocalProviderName;
    modelId?: string;
    snapshot: import('../types.js').EngineLaunchSnapshot;
  }> {
    const router = this.engineRouter ?? this.engineRouterCache;
    const out: Array<{
      provider: LocalProviderName;
      modelId?: string;
      snapshot: import('../types.js').EngineLaunchSnapshot;
    }> = router?.pool.engineLaunchSnapshots() ?? [];
    // The singleton map can hold the same provider object (and therefore
    // the same engine process) a pool entry already reported — dedupe by
    // pid, the process identity the snapshot is about.
    const seenPids = new Set(
      out.map((entry) => entry.snapshot.pid).filter((pid) => pid !== undefined),
    );
    for (const name of ['llama-cpp', 'mlx', 'ds4'] as const) {
      const singleton = this.providers.get(name);
      const snapshot = singleton?.engineLaunchSnapshot?.();
      if (!snapshot) continue;
      if (snapshot.pid !== undefined && seenPids.has(snapshot.pid)) continue;
      const modelId = singleton?.getEffectiveModelId?.();
      out.push({ provider: name, ...(modelId !== undefined ? { modelId } : {}), snapshot });
    }
    return out;
  }

  /**
   * Non-building lookup for an already-created native provider. Unlike
   * `getProviderForModel`, this cannot allocate a replica, evict another model,
   * or start an engine. The caller still checks the provider's live base URL
   * because a retained provider object may currently have no resident process.
   */
  peekResidentLocalProviders(name: ProviderName, modelId?: string): LLMProvider[] {
    if (!isLocalProvider(name) || !modelId) return [];
    const singleton = this.providers.get(name);
    const router = this.engineRouter ?? this.engineRouterCache;
    const pooled = router?.pool.peekProvidersForModel(name, modelId) ?? [];
    return singleton ? [singleton, ...pooled.filter((provider) => provider !== singleton)] : pooled;
  }

  /**
   * Resolve the context window a native model would receive without binding a
   * pool replica. This is the broker-side half of remote admission: focusing a
   * chat needs the live memory clamp so the user daemon can size its prompt,
   * but it must not load the model or evict somebody else's resident engine.
   *
   * `standalone` prices the target as the eventual sole resident: inventory
   * callers use it for stable device fitness, while remote admission combines
   * it with `liveSystemPressure` because a competing Gezel engine is
   * evictable/queueable but memory held by other applications is not. See
   * {@link previewLocalEnginePlan}'s `standalone` note.
   */
  async previewContextWindowForModel(
    name: LocalProviderName,
    modelId: string,
    opts: { standalone?: boolean; liveSystemPressure?: boolean } = {},
  ): Promise<number | undefined> {
    return (await this.previewLocalEnginePlan(name, modelId, opts)).contextWindow;
  }

  /**
   * Reservations held by models OTHER than the one being previewed.
   *
   * `committed()` totals every replica, the previewed model's own included.
   * Feeding that back as `committedOtherBytes` prices the launch as if a
   * second copy had to load beside the resident one, so the model currently
   * serving chats reports "won't fit" against its own reservation — and on a
   * host where one big model fills most of the budget, every OTHER row is
   * denied by a reservation that eviction would release. Every consumer of
   * `committedOtherBytes` means co-resident models, so subtract our own
   * replicas here. A key the parser doesn't recognise stays counted: an
   * unattributable reservation is real memory, and over-counting only makes
   * the preview conservative.
   */
  protected committedOtherBytesFor(
    snapshot: CapacityCommitted | undefined,
    provider: LocalProviderName,
    modelId: string,
  ): number {
    if (!snapshot?.enforced) return 0;
    const own = snapshot.byKey.reduce((sum, entry) => {
      const parsed = parseEngineKey(entry.key);
      return parsed?.provider === provider && parsed.modelId === modelId ? sum + entry.bytes : sum;
    }, 0);
    return Math.max(0, snapshot.committedBytes - own);
  }

  /**
   * The memory picture every engine's launch preview prices against.
   *
   * One derivation because each engine branch below used to rebuild it, and
   * they drifted: the llama.cpp branch pinned its admission clamp to usable
   * VRAM alone on discrete hosts, so a 21 GB MoE the broker would gladly
   * admit against a 30 GB budget reported "won't fit" — while the MLX branch,
   * which never passed live RAM, priced the same question correctly. A 4.7 GB
   * model was denied the same way. Adding an engine must not re-open that.
   *
   * Policy previews deliberately carry no `freeSystemRamBytes`: live free RAM
   * is self-referential there — a warm engine can depress it and make every
   * inventory row, itself included, fluctuate. Imminent placement callers may
   * opt into `liveSystemPressure`; that is the broker `/admit` path and must
   * use the same reclaimable-aware clamp as provider construction. Confining
   * grown KV to fast memory is not lost for policy previews —
   * `planAdaptiveContextGrowth` applies that clamp itself from `budgetKind` +
   * `vramBytes`.
   */
  protected async previewCapacityInputs(
    provider: LocalProviderName,
    modelId: string,
    opts: { standalone?: boolean; liveSystemPressure?: boolean },
  ): Promise<{
    /** Admission budget for the whole resident set. */
    budgetBytes: number;
    /** Fast (on-accelerator) pool — the ceiling adaptive growth may spend. */
    fastBudgetBytes: number;
    /** What slot COUNT is sized against; below `fastBudgetBytes` on big hosts. */
    concurrencySizingBytes: number;
    /** Usable VRAM on a discrete card; 0 on unified / CPU-only hosts. */
    vramBytes: number;
    budgetKind: CapacityCommitted['pools']['kind'];
    /** Reservations held by models OTHER than this one. */
    committedOtherBytes: number;
    /** Reclaimable-aware RAM available for an imminent placement. */
    freeSystemRamBytes?: number;
  }> {
    const { computeCapacityBudget } = await import('./capacity-broker.js');
    const { measuredCapacityBudget } = await import('./measured-budget.js');
    const router = this.engineRouter ?? this.engineRouterCache;
    const snapshot = router?.broker.committed();
    // An unenforced budget carries no usable numbers — fall back wholesale
    // rather than per-field, so a snapshot never contributes half a picture.
    const enforced = snapshot?.enforced ? snapshot : undefined;
    // No broker yet means no engine has ever been placed in this process, so
    // the ambient GPU probe may still be unpublished — measure rather than
    // read it. See measured-budget.ts for what a missing card costs here.
    const live = enforced ? computeCapacityBudget() : await measuredCapacityBudget();
    const committedOtherBytes = this.committedOtherBytesFor(snapshot, provider, modelId);
    return {
      budgetBytes: enforced?.budgetBytes ?? live.budgetBytes,
      fastBudgetBytes:
        enforced === undefined
          ? live.fastBytes
          : (router?.broker.fastBudgetBytes() ?? enforced.pools.fastBytes),
      concurrencySizingBytes: enforced?.pools.concurrencySizingBytes ?? live.concurrencySizingBytes,
      vramBytes: enforced?.pools.vramBytes ?? live.vramBytes,
      budgetKind: enforced?.pools.kind ?? live.kind,
      committedOtherBytes: opts.standalone ? 0 : committedOtherBytes,
      // A standalone imminent placement treats other Gezel engines as
      // evictable: if one is busy, /infer queues until it drains. Its current
      // process footprint is therefore not an intrinsic device-capacity
      // denial. With no competing reservation, live pressure represents
      // external applications / real system load and must match launch.
      ...(opts.liveSystemPressure && !(opts.standalone && committedOtherBytes > 0)
        ? { freeSystemRamBytes: availableSystemRamBytes() }
        : {}),
    };
  }

  /**
   * Full non-binding launch preview: the context window a native model
   * would receive AND the resident footprint at that window. Powers the
   * models-list "size in memory" column alongside
   * {@link previewContextWindowForModel}.
   *
   * Two footprints, deliberately: `plannedResidentBytes` is weights plus
   * ONE slot's KV — what serving a single chat costs, and the only figure
   * that tracks measured peak RSS. `reservedResidentBytes` is weights plus
   * `plannedSlots` slots' KV — what the broker actually holds. Quoting the
   * fleet as "size in memory" reads as the cost of using the model at all,
   * which overstates a multi-slot host by the slot count.
   */
  async previewLocalEnginePlan(
    name: LocalProviderName,
    modelId: string,
    /**
     * ds4 only: price a catalog entry that is NOT downloaded yet. The ds4 plan
     * needs the catalog block and this device's RAM tier, never the GGUF, so
     * the browse list can quote the window and footprint a download would land
     * on — which is when the fit decision is actually made. Other engines keep
     * throwing {@link ModelNotInstalledError}: their plans read the real
     * header.
     */
    opts: {
      allowUninstalled?: boolean;
      /**
       * Price the model as the eventual only resident engine. Inventory rows
       * use this for stable device fitness. Remote admission also uses it
       * because another Gezel engine can be evicted once idle; paired with
       * `liveSystemPressure`, non-Gezel system load still constrains the plan.
       * Actual launch admission keeps default live-reservation behavior and
       * may evict an idle model (or report that a busy one is blocking the
       * swap).
       */
      standalone?: boolean;
      /**
       * Apply the same reclaimable-aware live RAM clamp as a real provider
       * launch. Remote admission uses this immediately before inference;
       * inventory and settings previews deliberately leave it off so a warm
       * model does not make every catalog row fluctuate with system pressure.
       */
      liveSystemPressure?: boolean;
    } = {},
  ): Promise<{
    contextWindow?: number;
    plannedResidentBytes?: number;
    reservedResidentBytes?: number;
    plannedSlots?: number;
    /** GGUF/model-config advertised native window — the context slider's max. */
    nativeContextWindow?: number;
    /** Applied per-model context override (config.modelContextOverrides). */
    overrideContextTokens?: number;
    /**
     * What automatic sizing would grant right now, computed only while an
     * override is active (otherwise `contextWindow` IS the automatic value).
     * The slider's "Auto" marker.
     */
    autoContextWindow?: number;
    /**
     * Post-quant single-slot KV linearization so the UI can price
     * "~X GB in memory" live while the slider drags:
     * `weightsResidentBytes + kvFixedBytesPerSlot + kvBytesPerTokenPerSlot × ctx`.
     * ds4 reports it too, from its catalog-authored slope; absent there only
     * for entries that have not been measured yet.
     */
    kvBytesPerTokenPerSlot?: number;
    kvFixedBytesPerSlot?: number;
    weightsResidentBytes?: number;
    /**
     * ds4 only: the slider's max — min(native window, catalog maxLaunchCtx).
     * ds4 has no ctx-vs-memory admission, so the authored launch ceiling is
     * the only guard against a window the engine cannot actually serve.
     */
    contextCeilingTokens?: number;
  }> {
    let residentContextWindow: number | undefined;
    for (const resident of this.peekResidentLocalProviders(name, modelId)) {
      const residentModel = resident.getEffectiveModelId?.();
      if (residentModel && residentModel !== modelId) continue;
      const prepared = await resident.prepareContextWindow?.(modelId);
      const live = prepared ?? resident.getContextWindow?.();
      if (live && Number.isFinite(live) && live > 0) {
        residentContextWindow = Math.floor(live);
        break;
      }
    }

    const useResidentOr = (planned: number, minimum: number): number => {
      if (residentContextWindow === undefined) return planned;
      if (residentContextWindow < minimum) {
        throw new CapacityDeniedError(
          `${modelId} is already running with only ${residentContextWindow.toLocaleString('en-US')} context tokens per turn, below its required ${minimum.toLocaleString('en-US')}-token working window. Restart the local engine so Gezel can re-admit it at the current context policy.`,
          { reason: 'resident-below-minimum' },
        );
      }
      return residentContextWindow;
    };
    // Reusing an already-running target does not allocate its weights again,
    // so current free RAM (which that same process depressed) is not a launch
    // input. Keep the policy checks below — including resident-below-minimum
    // and changed overrides — while skipping only the self-referential clamp.
    const capacityOpts =
      residentContextWindow !== undefined && opts.liveSystemPressure
        ? { ...opts, liveSystemPressure: false }
        : opts;

    const config = await this.store.readConfig();
    // The floor this host is held to — 64K, or 32K where memory forces the
    // trade. Read once so every branch of the preview prices the same window
    // the launch path will ask for.
    const contextFloor = minViableLocalContextTokens();
    if (name === 'mlx') {
      const installed = await this.mlxModels?.resolveModel(modelId);
      if (!installed) throw new ModelNotInstalledError(name, modelId);
      const mlxOverride = config.modelContextOverrides?.[`mlx:${modelId}`];
      // An override below the host floor is deliberate user intent — lower
      // the floor to the override instead of raising the request back up.
      const mlxFloor =
        mlxOverride !== undefined ? Math.min(contextFloor, mlxOverride) : contextFloor;
      const geometry = installed.modelDir ? readMlxModelGeometry(installed.modelDir) : undefined;
      const {
        CapacityBroker,
        defaultLocalEngineSlots,
        kvQuantScale,
        localEngineSlotCeiling,
        planCtxTokensForMemory,
        plannedLocalEngineSlots,
      } = await import('./capacity-broker.js');
      const capacity = await this.previewCapacityInputs('mlx', modelId, capacityOpts);
      const {
        budgetBytes,
        fastBudgetBytes: fastBudget,
        committedOtherBytes,
        concurrencySizingBytes: concurrencySizingBudget,
      } = capacity;
      const kvBits = config.mlxKvBits ?? 0;
      const kvCacheType = kvBits === 4 ? 'q4_0' : kvBits === 8 ? 'q8_0' : 'f16';
      const weightsResident = CapacityBroker.estimateResidentBytes(
        'mlx',
        installed.approxSizeBytes,
      );
      // One planning pass — request resolution + memory-priced admission
      // (M4: mirror buildMlxProvider so the advertised window is what memory
      // admits, not the native max — before this an MLX 26B on a 16 GB Mac
      // previewed 256K). Runs a second time with the override ignored to
      // mark where "Automatic" lands on the slider.
      const planPass = (
        configuredLimit: number | undefined,
        floor: number,
      ): { grantedCtx: number; slots?: number; kvBytesPerToken?: number; minimum: number } => {
        let effective = resolveMlxEffectiveNumCtx({
          ...(installed.contextWindow ? { modelContextWindow: installed.contextWindow } : {}),
          ...(configuredLimit !== undefined ? { configuredLimit } : {}),
          minViableContextTokens: floor,
        });
        const minimum = Math.min(installed.contextWindow ?? floor, floor);
        const exactPerSlotKvF16 = geometry
          ? estimateExactPerSlotKvBytesF16(geometry, effective)
          : undefined;
        if (!geometry || exactPerSlotKvF16 === undefined) return { grantedCtx: effective, minimum };
        const kvBytesPerToken =
          (exactPerSlotKvF16 / Math.max(1, effective)) * kvQuantScale(kvCacheType);
        const configured = config.providerConcurrency?.mlx;
        const ceiling = localEngineSlotCeiling({
          engine: 'mlx',
          budgetBytes: fastBudget,
          sizingBudgetBytes: concurrencySizingBudget,
          weightsBytes: installed.approxSizeBytes,
          perTurnCtxTokens: effective,
          kvCacheType,
          committedOtherBytes,
          exactPerSlotKvBytesF16: exactPerSlotKvF16,
        });
        let slots = plannedLocalEngineSlots({
          configuredSlots: configured,
          ceiling,
          tierDefault: defaultLocalEngineSlots(fastBudget),
        });
        const admission = planCtxTokensForMemory({
          requestedPerTurnCtxTokens: effective,
          slots,
          minimumPerTurnCtxTokens: minimum,
          kvBytesPerToken,
          weightsResidentBytes: weightsResident,
          budgetBytes,
          committedOtherBytes,
          ...(capacity.freeSystemRamBytes !== undefined
            ? { freeSystemRamBytes: capacity.freeSystemRamBytes }
            : {}),
          vramBytes: capacity.vramBytes,
        });
        if (!admission.minimumSatisfied) {
          throw new CapacityDeniedError(
            formatContextCapacityDenial({ modelLabel: installed.name ?? modelId, plan: admission }),
          );
        }
        slots = admission.slots;
        effective = admission.perTurnCtxTokens;
        return { grantedCtx: effective, slots, kvBytesPerToken, minimum };
      };
      const plan = planPass(mlxOverride ?? config.mlxNumCtx, mlxFloor);
      let autoContextWindow: number | undefined;
      if (mlxOverride !== undefined) {
        try {
          autoContextWindow = planPass(config.mlxNumCtx, contextFloor).grantedCtx;
        } catch {
          // Automatic sizing may not fit where a smaller override does — no marker.
        }
      }
      // A resident engine below (or above) a freshly-set override keeps its
      // launch window until restart; surface that as restart-required
      // instead of quietly showing the stale window as if it were current.
      if (
        mlxOverride !== undefined &&
        residentContextWindow !== undefined &&
        residentContextWindow !== plan.grantedCtx
      ) {
        throw new CapacityDeniedError(
          `${modelId} is running with ${residentContextWindow.toLocaleString('en-US')} context tokens per turn, but its custom context setting now resolves to ${plan.grantedCtx.toLocaleString('en-US')}. Restart the local engine to apply it.`,
          { reason: 'resident-below-minimum' },
        );
      }
      const kvLin =
        geometry !== undefined
          ? (() => {
              const a = estimateExactPerSlotKvBytesF16(geometry, 8_192);
              const b = estimateExactPerSlotKvBytesF16(geometry, 65_536);
              if (a === undefined || b === undefined) return undefined;
              const scale = kvQuantScale(kvCacheType);
              const bytesPerToken = ((b - a) / (65_536 - 8_192)) * scale;
              return { bytesPerToken, fixedBytes: Math.max(0, a * scale - bytesPerToken * 8_192) };
            })()
          : undefined;
      return {
        contextWindow: useResidentOr(plan.grantedCtx, plan.minimum),
        ...(plan.slots !== undefined && plan.kvBytesPerToken !== undefined
          ? {
              plannedResidentBytes: Math.round(
                weightsResident + plan.kvBytesPerToken * plan.grantedCtx,
              ),
              reservedResidentBytes: Math.round(
                weightsResident + plan.kvBytesPerToken * plan.grantedCtx * plan.slots,
              ),
              plannedSlots: plan.slots,
              weightsResidentBytes: weightsResident,
            }
          : {}),
        ...(installed.contextWindow ? { nativeContextWindow: installed.contextWindow } : {}),
        ...(mlxOverride !== undefined ? { overrideContextTokens: mlxOverride } : {}),
        ...(autoContextWindow !== undefined ? { autoContextWindow } : {}),
        ...(kvLin !== undefined
          ? { kvBytesPerTokenPerSlot: kvLin.bytesPerToken, kvFixedBytesPerSlot: kvLin.fixedBytes }
          : {}),
      };
    }

    if (name === 'ds4') {
      const installed = await this.ds4Models?.resolveModel(modelId);
      const hasExplicitSource = Boolean(
        process.env.GEZEL_DS4_MODEL ||
          process.env.GEZEL_DS4_SERVER_URL ||
          config.ds4ModelPath ||
          config.ds4BaseUrl,
      );
      const detail = await this.catalog.get('chat-model', modelId).catch(() => null);
      const ds4Manifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
      const ds4Source = ds4Manifest?.ds4;
      // A catalog entry with a ds4 block is plannable before download; only a
      // model we know nothing about is genuinely absent.
      if (!installed && !hasExplicitSource && !(opts.allowUninstalled && ds4Source)) {
        throw new ModelNotInstalledError(name, modelId);
      }
      const { totalmem } = await import('node:os');
      const ramTieredCtx = totalmem() / 1024 ** 3 >= 192 ? 262_144 : 131_072;
      const ds4Override = config.modelContextOverrides?.[`ds4:${modelId}`];
      const ds4Floor =
        ds4Override !== undefined ? Math.min(contextFloor, ds4Override) : contextFloor;
      const effective = resolveDs4LaunchCtx({
        configured: ds4Override ?? config.ds4NumCtx,
        ramTieredCtx,
        catalogMaxCtx: ds4Source?.maxLaunchCtx,
        minViableContextTokens: ds4Floor,
      });
      if (
        ds4Override !== undefined &&
        residentContextWindow !== undefined &&
        residentContextWindow !== effective
      ) {
        throw new CapacityDeniedError(
          `${modelId} is running with ${residentContextWindow.toLocaleString('en-US')} context tokens per turn, but its custom context setting now resolves to ${effective.toLocaleString('en-US')}. Restart the local engine to apply it.`,
          { reason: 'resident-below-minimum' },
        );
      }
      // The slider's max for ds4: the authored catalog launch ceiling wins
      // over the advertised native window because ds4 has no ctx-vs-memory
      // admission to catch a window the engine cannot actually serve. The
      // manifest's window stands in before download, when there is no GGUF
      // header to read.
      const nativeWindow = installed?.contextWindow ?? ds4Manifest?.contextWindow;
      const ceilingTokens =
        ds4Source?.maxLaunchCtx !== undefined || nativeWindow !== undefined
          ? Math.min(
              ds4Source?.maxLaunchCtx ?? Number.POSITIVE_INFINITY,
              nativeWindow ?? Number.POSITIVE_INFINITY,
            )
          : undefined;
      let ds4AutoContextWindow: number | undefined;
      if (ds4Override !== undefined) {
        ds4AutoContextWindow = resolveDs4LaunchCtx({
          configured: config.ds4NumCtx,
          ramTieredCtx,
          catalogMaxCtx: ds4Source?.maxLaunchCtx,
          minViableContextTokens: contextFloor,
        });
      }
      // ds4's catalog residentBytes is an authored SSD-streaming working set
      // (expert cache + resident weights + KV) measured at ONE window. Where
      // the entry also authors the per-token slope, re-base it onto the window
      // this device actually launches with and hand the UI the same
      // `fixed + slope × ctx` line llama.cpp/MLX rows carry, so the slider
      // prices a drag instead of claiming the footprint never moves. Entries
      // without a measured slope keep the flat number and say so.
      const { ds4ProjectedResidentBytes, ds4ResidentLine } = await import('../ds4/residency.js');
      const ds4Line = ds4ResidentLine({
        residentBytes: ds4Source?.residentBytes,
        kvBytesPerToken: ds4Source?.kvBytesPerToken,
        residentCtxTokens: ds4Source?.residentCtxTokens,
      });
      return {
        contextWindow: useResidentOr(effective, Math.min(effective, ds4Floor)),
        plannedResidentBytes: ds4Line
          ? ds4ProjectedResidentBytes(ds4Line, effective)
          : await this.resolveResidentBytes('ds4', modelId),
        ...(ds4Line
          ? {
              weightsResidentBytes: ds4Line.contextFreeBytes,
              kvFixedBytesPerSlot: 0,
              kvBytesPerTokenPerSlot: ds4Line.kvBytesPerToken,
            }
          : {}),
        ...(nativeWindow ? { nativeContextWindow: nativeWindow } : {}),
        ...(ds4Override !== undefined ? { overrideContextTokens: ds4Override } : {}),
        ...(ds4AutoContextWindow !== undefined ? { autoContextWindow: ds4AutoContextWindow } : {}),
        ...(ceilingTokens !== undefined && Number.isFinite(ceilingTokens)
          ? { contextCeilingTokens: ceilingTokens }
          : {}),
      };
    }

    const installed = await this.llamaCppModels?.resolveModel(modelId);
    if (!installed) throw new ModelNotInstalledError(name, modelId);

    // Charge the projector against memory only when the launch will actually
    // load it. Every estimate below used to pass `installed.mmprojSizeBytes`
    // unconditionally, which was harmless while the file only existed for
    // models that had opted in — but the projector now ships with the model,
    // so an unconditional charge would quietly tax every multimodal model
    // (~900MB on a 27B) including the ones deliberately running text-only.
    const visionBudgetBytes = mmprojBudgetBytes(
      installed.mmprojSizeBytes,
      !!installed.mmprojPath && nativeVisionEnabledFor(config.nativeVision, modelId),
    );

    const envNumCtx = (() => {
      const raw = process.env.GEZEL_LLAMA_NUM_CTX;
      if (!raw) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    })();
    const manifestEngineConfig = await resolveCatalogLlamaCppEngineConfig(this.catalog, modelId);
    const perModelCtxOverride = config.modelContextOverrides?.[`llama-cpp:${modelId}`];
    const explicitContextWindow = envNumCtx ?? perModelCtxOverride ?? config.llamaCppNumCtx;
    // A per-model override below the host floor is deliberate user intent —
    // lower the admission floor to the override instead of silently raising
    // the request back to 64K. Env / machine-wide values keep their
    // historical floor semantics. Mirrors buildLlamaCppProvider.
    const overrideActive =
      perModelCtxOverride !== undefined && explicitContextWindow === perModelCtxOverride;
    const minViableTokens = overrideActive
      ? Math.min(contextFloor, perModelCtxOverride)
      : contextFloor;
    const contextRequirement = resolveLlamaCppContextRequirement({
      modelContextWindow: installed.contextWindow,
      minViableContextTokens: minViableTokens,
      ...(explicitContextWindow !== undefined ? { explicitContextWindow } : {}),
      ...(manifestEngineConfig?.contextSize !== undefined
        ? {
            adaptiveContextWindow: manifestEngineConfig.contextSize,
            manifestContextSize: manifestEngineConfig.contextSize,
          }
        : {}),
      contextSizing: config.llamaCppContextSizing ?? 'adaptive',
    });
    const effectiveNumCtx = contextRequirement.requestedPerTurnCtxTokens;
    // Resident/env short-circuits still want a footprint estimate, which
    // needs the header read below — the return moves after it. An active
    // per-model override deliberately does NOT short-circuit on a resident
    // engine: the full plan must run so a stale resident window surfaces as
    // restart-required instead of masquerading as the applied setting.
    const shortCircuit =
      (residentContextWindow !== undefined && !overrideActive) || envNumCtx !== undefined;

    const {
      defaultLocalEngineSlots,
      estimatePerSlotKvBytes,
      kvQuantScale,
      llamaCppSlotCeiling,
      planAdaptiveContextGrowth,
      planCtxTokensForMemory,
      plannedLocalEngineSlots,
    } = await import('./capacity-broker.js');
    const capacity = await this.previewCapacityInputs('llama-cpp', modelId, capacityOpts);
    const { budgetBytes: admissionBudgetBytes, fastBudgetBytes, committedOtherBytes } = capacity;
    const configuredSlots = config.providerConcurrency?.['llama-cpp'];
    const kvCacheType = resolveLlamaCppKvCacheType({
      architecture: installed.architecture,
      modelId,
      override: config.llamaCppKvCacheType,
    });
    // Header-exact per-slot KV for the slot ceiling (M2); the
    // weights-scaled heuristic only when the GGUF is unreadable.
    // Metadata-only read — this path never needs tensor sizes.
    let summary: GgufSummary | null = null;
    try {
      summary = await readGgufSummaryAsync(installed.weightsPath);
    } catch {
      summary = null;
    }
    const exactPerSlotKvF16 = summary
      ? estimateExactPerSlotKvBytesF16(
          {
            blockCount: summary.blockCount,
            embeddingLength: summary.embeddingLength,
            headCount: summary.headCount,
            headCountKv: summary.headCountKv,
            headCountKvPerLayer: summary.headCountKvPerLayer,
            slidingWindow: summary.slidingWindow,
            slidingWindowPattern: summary.slidingWindowPattern,
            sharedKvLayers: summary.sharedKvLayers,
            loopCount: summary.loopCount,
            keyLength: summary.keyLength,
            valueLength: summary.valueLength,
            keyLengthSwa: summary.keyLengthSwa,
            valueLengthSwa: summary.valueLengthSwa,
            fullAttentionInterval: summary.fullAttentionInterval,
            ssmInnerSize: summary.ssmInnerSize,
            ssmStateSize: summary.ssmStateSize,
            ssmConvKernel: summary.ssmConvKernel,
          },
          effectiveNumCtx,
        )
      : undefined;
    // Weights + KV at a given window/slot count. Two figures, because they
    // answer different questions: `single` is what one chat costs (the
    // models-list headline), `reserved` is what the broker holds for the
    // whole slot fleet (the launch path's reservation math).
    const plannedFor = (
      ctx: number,
      slotCount: number,
      kv: string,
    ): { single: number; reserved: number; slots: number } | undefined => {
      if (!summary) return undefined;
      const perSlotF16 = estimateExactPerSlotKvBytesF16(
        {
          blockCount: summary.blockCount,
          embeddingLength: summary.embeddingLength,
          headCount: summary.headCount,
          headCountKv: summary.headCountKv,
          headCountKvPerLayer: summary.headCountKvPerLayer,
          slidingWindow: summary.slidingWindow,
          slidingWindowPattern: summary.slidingWindowPattern,
          sharedKvLayers: summary.sharedKvLayers,
          loopCount: summary.loopCount,
          keyLength: summary.keyLength,
          valueLength: summary.valueLength,
          keyLengthSwa: summary.keyLengthSwa,
          valueLengthSwa: summary.valueLengthSwa,
          fullAttentionInterval: summary.fullAttentionInterval,
          ssmInnerSize: summary.ssmInnerSize,
          ssmStateSize: summary.ssmStateSize,
          ssmConvKernel: summary.ssmConvKernel,
        },
        ctx,
      );
      if (perSlotF16 === undefined) return undefined;
      const weightsBytes = estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
        mmprojBytes: visionBudgetBytes,
      });
      const perSlotBytes = perSlotF16 * kvQuantScale(kv);
      return {
        single: Math.round(weightsBytes + perSlotBytes),
        reserved: Math.round(weightsBytes + perSlotBytes * slotCount),
        slots: slotCount,
      };
    };
    // Post-quant single-slot KV linearization for the UI's live slider
    // estimate. Two-point sampling stays exact for full-attention models
    // and matches the windowed/hybrid piecewise slope everywhere above the
    // sliding window — the slider's 32K floor clears every real window.
    const kvLinearizationFor = (
      kv: string,
    ): { bytesPerToken: number; fixedBytes: number } | undefined => {
      if (!summary) return undefined;
      const geometry = {
        blockCount: summary.blockCount,
        embeddingLength: summary.embeddingLength,
        headCount: summary.headCount,
        headCountKv: summary.headCountKv,
        headCountKvPerLayer: summary.headCountKvPerLayer,
        slidingWindow: summary.slidingWindow,
        slidingWindowPattern: summary.slidingWindowPattern,
        sharedKvLayers: summary.sharedKvLayers,
        loopCount: summary.loopCount,
        keyLength: summary.keyLength,
        valueLength: summary.valueLength,
        keyLengthSwa: summary.keyLengthSwa,
        valueLengthSwa: summary.valueLengthSwa,
        fullAttentionInterval: summary.fullAttentionInterval,
        ssmInnerSize: summary.ssmInnerSize,
        ssmStateSize: summary.ssmStateSize,
        ssmConvKernel: summary.ssmConvKernel,
      };
      const a = estimateExactPerSlotKvBytesF16(geometry, 8_192);
      const b = estimateExactPerSlotKvBytesF16(geometry, 65_536);
      if (a === undefined || b === undefined) return undefined;
      const scale = kvQuantScale(kv);
      const bytesPerToken = ((b - a) / (65_536 - 8_192)) * scale;
      return { bytesPerToken, fixedBytes: Math.max(0, a * scale - bytesPerToken * 8_192) };
    };
    const ceilingAt = (ctx: number, kv: LlamaCppKvCacheType) =>
      llamaCppSlotCeiling({
        budgetBytes: fastBudgetBytes,
        sizingBudgetBytes: capacity.concurrencySizingBytes,
        weightsBytes: installed.approxSizeBytes,
        perTurnCtxTokens: ctx,
        kvCacheType: kv,
        committedOtherBytes,
        ...(exactPerSlotKvF16 !== undefined ? { exactPerSlotKvBytesF16: exactPerSlotKvF16 } : {}),
      });
    if (shortCircuit) {
      const contextWindow = useResidentOr(
        effectiveNumCtx,
        contextRequirement.minimumPerTurnCtxTokens,
      );
      // Memory-aware slot count, same as the main path below. The raw tier
      // default is what a launch would *like*; on a constrained host the
      // ceiling is what it can actually have, and quoting the former made
      // this branch advertise reservations the broker would never admit.
      const planned = plannedFor(
        contextWindow,
        plannedLocalEngineSlots({
          configuredSlots,
          ceiling: ceilingAt(contextWindow, kvCacheType),
          tierDefault: defaultLocalEngineSlots(fastBudgetBytes),
        }),
        kvCacheType,
      );
      const lin = kvLinearizationFor(kvCacheType);
      return {
        contextWindow,
        ...(planned !== undefined
          ? {
              plannedResidentBytes: planned.single,
              reservedResidentBytes: planned.reserved,
              plannedSlots: planned.slots,
              weightsResidentBytes: estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
                mmprojBytes: visionBudgetBytes,
              }),
            }
          : {}),
        ...(installed.contextWindow ? { nativeContextWindow: installed.contextWindow } : {}),
        ...(perModelCtxOverride !== undefined
          ? { overrideContextTokens: perModelCtxOverride }
          : {}),
        ...(lin !== undefined
          ? { kvBytesPerTokenPerSlot: lin.bytesPerToken, kvFixedBytesPerSlot: lin.fixedBytes }
          : {}),
      };
    }
    // One planning pass: policy resolution → KV/slot plan → admission
    // ladder → windowed re-plan → adaptive growth, mirroring
    // buildLlamaCppProvider. Runs once for the live preview and — while a
    // per-model override is active — a second time with the override
    // ignored, so the slider can mark where "Automatic" lands right now.
    const llamaPlanPass = (
      explicitArg: number | undefined,
      minViableArg: number,
    ): {
      grantedCtx: number;
      slots: number;
      kvCacheType: LlamaCppKvCacheType;
      plannedFieldsOk: boolean;
    } => {
      const requirement = resolveLlamaCppContextRequirement({
        modelContextWindow: installed.contextWindow,
        minViableContextTokens: minViableArg,
        ...(explicitArg !== undefined ? { explicitContextWindow: explicitArg } : {}),
        ...(manifestEngineConfig?.contextSize !== undefined
          ? {
              adaptiveContextWindow: manifestEngineConfig.contextSize,
              manifestContextSize: manifestEngineConfig.contextSize,
            }
          : {}),
        contextSizing: config.llamaCppContextSizing ?? 'adaptive',
      });
      let grantedCtx = requirement.requestedPerTurnCtxTokens;
      let kv = resolveLlamaCppKvCacheType({
        architecture: installed.architecture,
        modelId,
        override: config.llamaCppKvCacheType,
      });
      // Per-pass exact KV at this pass's requested window — the auto pass
      // may request a different window than the primary one, and a slot
      // ceiling fed with the other pass's bytes skews the marker.
      const exactAtRequested = summary
        ? estimateExactPerSlotKvBytesF16(
            {
              blockCount: summary.blockCount,
              embeddingLength: summary.embeddingLength,
              headCount: summary.headCount,
              headCountKv: summary.headCountKv,
              headCountKvPerLayer: summary.headCountKvPerLayer,
              slidingWindow: summary.slidingWindow,
              slidingWindowPattern: summary.slidingWindowPattern,
              sharedKvLayers: summary.sharedKvLayers,
              loopCount: summary.loopCount,
              keyLength: summary.keyLength,
              valueLength: summary.valueLength,
              keyLengthSwa: summary.keyLengthSwa,
              valueLengthSwa: summary.valueLengthSwa,
              fullAttentionInterval: summary.fullAttentionInterval,
              ssmInnerSize: summary.ssmInnerSize,
              ssmStateSize: summary.ssmStateSize,
              ssmConvKernel: summary.ssmConvKernel,
            },
            grantedCtx,
          )
        : undefined;
      const passPlanCtx = grantedCtx;
      const passCeiling = (kvType: LlamaCppKvCacheType, ctxTokens: number) =>
        llamaCppSlotCeiling({
          budgetBytes: fastBudgetBytes,
          sizingBudgetBytes: capacity.concurrencySizingBytes,
          weightsBytes: installed.approxSizeBytes,
          perTurnCtxTokens: ctxTokens,
          kvCacheType: kvType,
          committedOtherBytes,
          ...(exactAtRequested !== undefined
            ? { exactPerSlotKvBytesF16: (exactAtRequested * ctxTokens) / passPlanCtx }
            : {}),
        });
      // One pricing for a candidate KV dtype, shared by the plan's fit gate
      // and by the admission below — a second copy is how a preview starts
      // promising a window the launch then denies.
      const referenceCtx = 4096;
      const exactKvAtReferenceFor = (kvType: LlamaCppKvCacheType) =>
        summary
          ? estimateKvReserveBytes({
              blockCount: summary.blockCount,
              embeddingLength: summary.embeddingLength,
              headCount: summary.headCount,
              headCountKv: summary.headCountKv,
              headCountKvPerLayer: summary.headCountKvPerLayer,
              slidingWindowPattern: summary.slidingWindowPattern,
              sharedKvLayers: summary.sharedKvLayers,
              loopCount: summary.loopCount,
              keyLength: summary.keyLength,
              valueLength: summary.valueLength,
              keyLengthSwa: summary.keyLengthSwa,
              valueLengthSwa: summary.valueLengthSwa,
              fullAttentionInterval: summary.fullAttentionInterval,
              ssmInnerSize: summary.ssmInnerSize,
              ssmStateSize: summary.ssmStateSize,
              ssmConvKernel: summary.ssmConvKernel,
              ctxTokens: referenceCtx,
              kvCacheType: kvType,
            })
          : undefined;
      const kvBytesPerTokenFor = (kvType: LlamaCppKvCacheType) => {
        const exact = exactKvAtReferenceFor(kvType);
        return exact !== undefined
          ? exact / referenceCtx
          : estimatePerSlotKvBytes({
              perTurnCtxTokens: referenceCtx,
              weightsBytes: installed.approxSizeBytes,
              kvCacheType: kvType,
            }) / referenceCtx;
      };
      const weightsResidentBytes = estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
        mmprojBytes: visionBudgetBytes,
      });
      const planFitsAt = (kvType: LlamaCppKvCacheType, ctxTokens: number, slotCount: number) => {
        // `minimumPerTurnCtxTokens: ctxTokens` makes this ask for the WHOLE
        // window — a plan admission would only accept by clamping does not
        // count as a fit, which is exactly the case q8_0 has to rescue.
        const probe = planCtxTokensForMemory({
          requestedPerTurnCtxTokens: ctxTokens,
          slots: slotCount,
          minimumPerTurnCtxTokens: ctxTokens,
          kvBytesPerToken: kvBytesPerTokenFor(kvType),
          weightsResidentBytes,
          budgetBytes: admissionBudgetBytes,
          committedOtherBytes,
          ...(capacity.freeSystemRamBytes !== undefined
            ? { freeSystemRamBytes: capacity.freeSystemRamBytes }
            : {}),
          vramBytes: capacity.vramBytes,
        });
        return probe.minimumSatisfied && probe.slots >= slotCount;
      };
      const kvPlan = planLlamaCppKv({
        architecture: installed.architecture,
        modelId,
        override: config.llamaCppKvCacheType,
        slotsConfigured: configuredSlots !== undefined,
        ...(configuredSlots !== undefined ? { configuredSlots } : {}),
        requestedCtxTokens: grantedCtx,
        minimumCtxTokens: requirement.minimumPerTurnCtxTokens,
        ctxConfigured:
          explicitArg !== undefined || (config.llamaCppContextSizing ?? 'adaptive') === 'model-max',
        ceilingFor: passCeiling,
        fitsAt: planFitsAt,
        maxSlots: defaultLocalEngineSlots(fastBudgetBytes),
      });
      kv = kvPlan.kvCacheType;
      // Mirror the launch: the f16-by-context-cap trade shrinks the granted
      // window here too, so the settings preview shows what will really run.
      if (kvPlan.ctxCapTokens !== undefined && kvPlan.ctxCapTokens < grantedCtx) {
        grantedCtx = kvPlan.ctxCapTokens;
      }
      let slots = plannedLocalEngineSlots({
        configuredSlots,
        ceiling: passCeiling(kv, grantedCtx),
        tierDefault: defaultLocalEngineSlots(fastBudgetBytes),
      });
      if ((config.llamaCppSpecType ?? manifestEngineConfig?.spec?.type) === 'draft-mtp') slots = 1;

      try {
        if (!summary) throw new Error('GGUF header unreadable');
        const exactKvAtReference = exactKvAtReferenceFor(kv);
        const kvBytesPerToken = kvBytesPerTokenFor(kv);
        // The linearization the accepted plan priced with, so the growth
        // pass cannot disagree with admission about the same launch.
        let ladderKvLinearization: {
          bytesPerToken: number;
          fixedPerSlotBytes: number;
        } | null = { bytesPerToken: kvBytesPerToken, fixedPerSlotBytes: 0 };
        let admission = planCtxTokensForMemory({
          requestedPerTurnCtxTokens: grantedCtx,
          slots,
          minimumPerTurnCtxTokens: requirement.minimumPerTurnCtxTokens,
          kvBytesPerToken,
          weightsResidentBytes: estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
            mmprojBytes: visionBudgetBytes,
          }),
          budgetBytes: admissionBudgetBytes,
          committedOtherBytes,
          ...(capacity.freeSystemRamBytes !== undefined
            ? { freeSystemRamBytes: capacity.freeSystemRamBytes }
            : {}),
          vramBytes: capacity.vramBytes,
        });
        // Mirror the launch path's windowed-cache admission (see
        // buildLlamaCppProvider): when the launch will decline the Gemma
        // `--swa-full` auto-default (or the windowed cache is pinned), the
        // full-attention plan above overstates the real allocation — re-plan
        // with the windowed linearization so the previewed window matches
        // what the engine will actually grant.
        // Strict model-max deliberately does NOT gate this: for SWA models
        // the windowed cache is the only layout whose native-window KV can
        // fit real machines, and the strict minimum rides inside
        // `requirement.minimumPerTurnCtxTokens`, so the windowed
        // re-plan sheds slots or denies but never shortens the window.
        const explicitSwaFull = config.llamaCppSwaFull ?? manifestEngineConfig?.swaFull;
        const windowedCacheWillRun =
          (!admission.minimumSatisfied || admission.clamped || admission.slots < slots) &&
          (explicitSwaFull === false ||
            (explicitSwaFull === undefined &&
              isGemmaModel({ architecture: installed.architecture, modelId })));
        if (windowedCacheWillRun) {
          const windowed = estimateWindowedKvLinearization({
            blockCount: summary.blockCount,
            embeddingLength: summary.embeddingLength,
            headCount: summary.headCount,
            headCountKv: summary.headCountKv,
            headCountKvPerLayer: summary.headCountKvPerLayer,
            slidingWindow: summary.slidingWindow,
            slidingWindowPattern: summary.slidingWindowPattern,
            sharedKvLayers: summary.sharedKvLayers,
            loopCount: summary.loopCount,
            keyLength: summary.keyLength,
            valueLength: summary.valueLength,
            keyLengthSwa: summary.keyLengthSwa,
            valueLengthSwa: summary.valueLengthSwa,
            fullAttentionInterval: summary.fullAttentionInterval,
            ssmInnerSize: summary.ssmInnerSize,
            ssmStateSize: summary.ssmStateSize,
            ssmConvKernel: summary.ssmConvKernel,
            kvCacheType: kv,
          });
          if (windowed) {
            admission = planCtxTokensForMemory({
              requestedPerTurnCtxTokens: grantedCtx,
              slots,
              minimumPerTurnCtxTokens: requirement.minimumPerTurnCtxTokens,
              kvBytesPerToken: windowed.bytesPerToken,
              weightsResidentBytes:
                estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
                  mmprojBytes: visionBudgetBytes,
                }) +
                windowed.fixedBytes * slots,
              budgetBytes: admissionBudgetBytes,
              committedOtherBytes,
              ...(capacity.freeSystemRamBytes !== undefined
                ? { freeSystemRamBytes: capacity.freeSystemRamBytes }
                : {}),
              vramBytes: capacity.vramBytes,
            });
            ladderKvLinearization = {
              bytesPerToken: windowed.bytesPerToken,
              fixedPerSlotBytes: windowed.fixedBytes,
            };
          } else if ((summary.slidingWindow ?? 0) > 0 || explicitSwaFull === undefined) {
            // SWA model without a readable layout: the launch path leaves
            // such a launch untouched — preview the requested window.
            return { grantedCtx, slots, kvCacheType: kv, plannedFieldsOk: false };
          }
        }
        if (!admission.minimumSatisfied) {
          throw new CapacityDeniedError(
            formatContextCapacityDenial({ modelLabel: installed.name ?? modelId, plan: admission }),
          );
        }
        slots = admission.slots;
        grantedCtx = admission.perTurnCtxTokens;
        // ── Adaptive context growth ── mirror of buildLlamaCppProvider:
        // slots and the base grant are settled; spend leftover FAST memory
        // on a longer window up to the resolver's target. Exact GGUF
        // geometry only.
        if (
          requirement.growthTargetTokens !== undefined &&
          ladderKvLinearization !== null &&
          exactKvAtReference !== undefined
        ) {
          const growth = planAdaptiveContextGrowth({
            basePerTurnCtxTokens: grantedCtx,
            targetPerTurnCtxTokens: requirement.growthTargetTokens,
            slots,
            kvBytesPerToken: ladderKvLinearization.bytesPerToken,
            kvFixedPerSlotBytes: ladderKvLinearization.fixedPerSlotBytes,
            weightsResidentBytes: estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
              mmprojBytes: visionBudgetBytes,
            }),
            fastBudgetBytes,
            committedOtherBytes,
            budgetKind: capacity.budgetKind,
            vramBytes: capacity.vramBytes,
            ...(capacity.freeSystemRamBytes !== undefined
              ? { freeSystemRamBytes: capacity.freeSystemRamBytes }
              : {}),
            isMoE: (summary.expertCount ?? 0) > 1,
            // A user-chosen lane count is not growth's to spend.
            allowSlotTrade: configuredSlots === undefined,
          });
          if (growth.grown) {
            grantedCtx = growth.perTurnCtxTokens;
            slots = growth.slots;
          }
        }
      } catch (error) {
        if (error instanceof CapacityDeniedError) throw error;
        log.warn(
          `[llama-cpp] could not inspect ${modelId} while previewing admission: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { grantedCtx, slots, kvCacheType: kv, plannedFieldsOk: true };
    };

    const plan = llamaPlanPass(explicitContextWindow, minViableTokens);
    let autoContextWindow: number | undefined;
    if (overrideActive) {
      try {
        autoContextWindow = llamaPlanPass(config.llamaCppNumCtx, contextFloor).grantedCtx;
      } catch {
        // Automatic sizing may not fit where a smaller override does — no marker.
      }
    }
    // A resident engine holding a different window than a freshly-set
    // override keeps its launch window until restart; surface that as
    // restart-required instead of quietly showing the stale window as if
    // the setting had applied.
    if (
      overrideActive &&
      residentContextWindow !== undefined &&
      residentContextWindow !== plan.grantedCtx
    ) {
      throw new CapacityDeniedError(
        `${modelId} is running with ${residentContextWindow.toLocaleString('en-US')} context tokens per turn, but its custom context setting now resolves to ${plan.grantedCtx.toLocaleString('en-US')}. Restart the local engine to apply it.`,
        { reason: 'resident-below-minimum' },
      );
    }
    const planned = plan.plannedFieldsOk
      ? plannedFor(plan.grantedCtx, plan.slots, plan.kvCacheType)
      : undefined;
    const lin = plan.plannedFieldsOk ? kvLinearizationFor(plan.kvCacheType) : undefined;
    return {
      contextWindow: plan.grantedCtx,
      ...(planned !== undefined
        ? {
            plannedResidentBytes: planned.single,
            reservedResidentBytes: planned.reserved,
            plannedSlots: planned.slots,
            weightsResidentBytes: estimateLlamaCppResidentBytes(installed.approxSizeBytes, {
              mmprojBytes: visionBudgetBytes,
            }),
          }
        : {}),
      ...(installed.contextWindow ? { nativeContextWindow: installed.contextWindow } : {}),
      ...(perModelCtxOverride !== undefined ? { overrideContextTokens: perModelCtxOverride } : {}),
      ...(autoContextWindow !== undefined ? { autoContextWindow } : {}),
      ...(lin !== undefined
        ? { kvBytesPerTokenPerSlot: lin.bytesPerToken, kvFixedBytesPerSlot: lin.fixedBytes }
        : {}),
    };
  }

  /**
   * Cancel a pending provider-queue entry by (provider, id). Resolves
   * the queue the SAME two ways {@link localEngineQueueSummaries} +
   * `/api/queues` surface it: the singleton `providers` map first
   * (cloud providers, seeded test mocks), then the engine pool for
   * pool-routed local engines whose queue the singleton never sees.
   * Returns true when an entry was removed, false when the id is
   * unknown (already running, already cancelled, or no such provider).
   */
  cancelProviderQueueItem(name: ProviderName, id: number): boolean {
    if (this.getProviderIfReady(name)?.queue?.cancelPending(id)) return true;
    const router = this.engineRouter ?? this.engineRouterCache;
    return router ? router.pool.cancelPendingQueueItem(name, id) : false;
  }

  /** Reorder a pending provider-queue entry. Same singleton-then-pool
   *  resolution as {@link cancelProviderQueueItem}. */
  moveProviderQueueItem(name: ProviderName, id: number, direction: 'up' | 'down'): boolean {
    if (this.getProviderIfReady(name)?.queue?.movePending(id, direction)) return true;
    const router = this.engineRouter ?? this.engineRouterCache;
    return router ? router.pool.movePendingQueueItem(name, id, direction) : false;
  }

  protected sessionsPerEngineKey(): Map<string, number> {
    return new Map();
  }
  protected async bindLocalReplica(
    router: import('./engine-router.js').EngineRouter,
    name: LocalProviderName,
    modelId: string,
    opts: {
      sessionId: string;
      priorEngineKey?: string | undefined;
      engineDrainWaitMs?: number;
    },
  ): Promise<{ engineKey: string; provider: LLMProvider }> {
    // Pre-populate the bytes cache so the router's sync resolver
    // hits on the first ensure.
    await this.resolveResidentBytes(name, modelId);

    // Tally active sessions per engine key for load-balanced bind.
    const sessionsPerKey = this.sessionsPerEngineKey();

    return router.bindForSession(
      name,
      modelId,
      {
        sessionId: opts.sessionId,
        sessionsPerKey,
        ...(opts.engineDrainWaitMs !== undefined ? { drainWaitMs: opts.engineDrainWaitMs } : {}),
      },
      opts.priorEngineKey,
    );
  }
  protected async getLocalProviderForModel(
    name: LocalProviderName,
    modelId: string | undefined,
    opts: { engineDrainWaitMs?: number },
    fallback: () => Promise<LLMProvider>,
  ): Promise<LLMProvider> {
    const seeded = this.providers.get(name);
    if (seeded) return seeded;

    const router = await this.getEngineRouter();
    if (!router) return fallback();

    const config = await this.store.readConfig();
    const resolved = modelId ?? config.defaultModel?.[name];
    if (!resolved) return fallback();

    const installed =
      name === 'llama-cpp'
        ? await this.llamaCppModels?.resolveModel(resolved)
        : name === 'ds4'
          ? // ds4 v1 also resolves weights OUTSIDE the model manager — an
            // explicit gguf path (GEZEL_DS4_MODEL / config.ds4ModelPath) or
            // an external server (GEZEL_DS4_SERVER_URL / config.ds4BaseUrl).
            // `buildDs4Provider` handles those directly, so don't gate the
            // pool on the store: falling back to the singleton here spawns
            // a SECOND supervisor for a server that's already running, and
            // ds4-server's single-instance lock refuses it — every ds4
            // one-shot (summaries, meester-status, extraction) then fails
            // with "another ds4 process is already running" (wild-caught
            // by validate-ambient-gate on an env-path daemon).
            ((await this.ds4Models?.resolveModel(resolved)) ??
            (process.env.GEZEL_DS4_MODEL ||
            process.env.GEZEL_DS4_SERVER_URL ||
            config.ds4ModelPath ||
            config.ds4BaseUrl
              ? { explicitSource: true }
              : undefined))
          : await this.mlxModels?.resolveModel(resolved);
    if (!installed) {
      throw new ModelNotInstalledError(name, resolved);
    }

    const { provider } = await this.bindLocalReplica(router, name, resolved, {
      // Synthetic id — one-shot requests have no session record; the
      // bind still load-balances across resident replicas.
      sessionId: `v1:${randomUUID()}`,
      ...(opts.engineDrainWaitMs !== undefined
        ? { engineDrainWaitMs: opts.engineDrainWaitMs }
        : {}),
    });
    return provider;
  }
}
