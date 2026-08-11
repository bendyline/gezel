import { delimiter, dirname, join } from 'node:path';
import {
  DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
  type GezelConfig,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { LlamaBackend } from '@bendyline/gezel/native';
import { recordLlamaQuarantine } from '@bendyline/gezel/native';
import { gezelPaths } from '@bendyline/gezel/paths';
import { effectiveEngineRelease, isEnginePinned } from '../../engines/native-manifest.js';
import {
  resolveCatalogLlamaCppEngineConfig,
  resolveCatalogReasoningBudget,
} from '../catalog-model-config.js';
import {
  CapacityDeniedError,
  availableSystemRamBytes,
  formatContextCapacityDenial,
  minViableLocalContextTokens,
  planAdaptiveContextGrowth,
  resolveLlamaCppContextRequirement,
} from '../native/capacity-broker.js';
import { makeEngineKey } from '../native/engine-key.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { lastArgValue, readLlamaCppBuildMetadata } from './build-metadata.js';
import {
  matchNvidiaRuntimeDevice,
  maxGpuVramBytes,
  pickBestGpuDevice,
  probeLlamaDevices,
  probeNvidiaRuntimeDevices,
} from './devices.js';
import { type PlannerOffloadDecision, buildLlamaCppEngineArgs } from './engine-flags.js';
import { readGgufSummaryAsync } from './gguf-metadata-async.js';
import type { GgufSummary } from './gguf-metadata.js';
import {
  type LlamaCppKvCacheType,
  isGemmaModel,
  planLlamaCppKv,
  resolveLlamaCppKvCacheType,
} from './kv-cache-type.js';
import {
  degradeMoeOffloadDecision,
  estimateExactPerSlotKvBytesF16,
  estimateKvReserveBytes,
  estimateWindowedKvLinearization,
  fitsSwaFullInFastMemory,
  planMoeOffload,
} from './offload-planner.js';
import { LlamaCppProvider, createLlamaCppPatientFetch } from './provider.js';
import { resolveSpecDraft } from './spec-draft.js';

const log = createLogger('chat');

/**
 * Lazy on-device engine-resolver hook for {@link buildLlamaCppProvider}.
 * Kicks (or attaches to) a background download of llama-server for the
 * detected/overridden GPU backend and returns an actionable status to
 * surface this turn. Returns `undefined` when auto-download is disabled —
 * the caller then falls through to the plain "install the engine" error.
 */
export function ensureLlamaEngineStatus(
  registry: import('../../engines/registry.js').EngineBinaryRegistry,
  config: GezelConfig,
): { detail: string } | undefined {
  if (config.autoDownloadEngines === false) return undefined;
  // No release pinned (and no dev override) → auto-download can't succeed;
  // stay dormant so the caller shows the existing "install / external
  // engine" guidance instead of a download that immediately fails.
  if (!isEnginePinned()) return undefined;
  const override = config.llamaCppBackendOverride;
  const backend =
    override && override !== 'auto'
      ? override
      : process.env.GEZEL_LLAMA_DETECTED_BACKEND || undefined;
  const { snapshot } = registry.ensure('llama-server', backend);
  if (snapshot.error) {
    return { detail: `On-device engine couldn't be downloaded: ${snapshot.error}` };
  }
  const pct =
    snapshot.totalBytes > 0
      ? Math.floor((snapshot.bytesWritten / snapshot.totalBytes) * 100)
      : null;
  const where = backend ? `, ${backend}` : '';
  return {
    detail: `On-device engine (llama-server${where}) is downloading${
      pct !== null ? ` (${pct}%)` : ''
    }. It'll be ready shortly — try again in a moment.`,
  };
}

/**
 * Build the llama.cpp provider for either an externally managed server or a
 * supervised local engine. The supervised path resolves the installed model,
 * plans context/KV/offload against available capacity, and owns the engine's
 * lifecycle through {@link NativeEngineSupervisor}.
 */
export async function buildLlamaCppProvider(opts: {
  config: GezelConfig;
  affinity: boolean | undefined;
  home: string;
  llamaCppModels?: import('./index.js').LlamaCppModelManager;
  arbiter?: import('../gpu-arbiter.js').GpuArbiter;
  /**
   * Optional catalog service — used to read per-model launch-time
   * tuning that can't be expressed per-request, like
   * `tuning.reasoning.thinkingBudget` → `--reasoning-budget` CLI flag.
   * When absent (CLI/external boots), the server starts with its
   * defaults.
   */
  catalog?: CatalogService;
  /**
   * Pool-driven multi-engine routing. When set, the build resolves
   * `modelId` from the catalog (ignoring `config.defaultModel` /
   * `config.llamaCppModelPath` / `GEZEL_LLAMA_CPP_MODEL`), and uses
   * `replicaIdx` to isolate the slot-save-path so concurrent
   * replicas don't collide. Unset = today's singleton behavior.
   */
  modelOverride?: { modelId: string; replicaIdx: number };
  /**
   * Lazy engine-resolver hook. When the on-device binary is missing (and
   * no external URL is configured), this is consulted before erroring: it
   * may kick a background download and return an actionable status to
   * surface this turn. Absent → the plain "install the engine" error.
   */
  ensureEngine?: () => { detail: string } | undefined;
  /**
   * Capacity broker (pool path only). When present, the supervised slot
   * ceiling subtracts already-committed co-resident model reservations
   * from the budget so a second resident model doesn't over-slot into
   * memory the first one already holds. The pool reserves THIS model only
   * after this builder returns, so its committed total is purely the other
   * residents. Absent on the singleton path → the ceiling uses the full
   * auto-detected budget.
   */
  broker?: import('../native/capacity-broker.js').CapacityBroker;
}): Promise<LlamaCppProvider> {
  const { config, affinity, home } = opts;
  const externalBaseUrl = opts.modelOverride
    ? undefined
    : (process.env.GEZEL_LLAMA_SERVER_URL ?? config.llamaCppBaseUrl);
  const binary = process.env.GEZEL_LLAMA_SERVER_BIN;

  const defaultModelId = opts.modelOverride?.modelId ?? config.defaultModel?.['llama-cpp'];
  // Slot count (`--parallel N`) is the single source of truth — drives the
  // queue `concurrency`, `--ctx-size × slots`, and the cache adapter's
  // `slotCount` (read back from `provider.queue.concurrency`). For a
  // SUPERVISED engine the final `slots` is auto-sized below — fast-memory
  // demand default, clamped by a per-model KV memory ceiling — once the
  // model + context window are known; an explicit
  // `providerConcurrency['llama-cpp']` overrides verbatim. The EXTERNAL-
  // baseUrl path keeps the conservative default 2 (we don't control that
  // server's `--parallel`).
  const configuredSlots = config.providerConcurrency?.['llama-cpp'];
  // `config.llamaCppNumCtx` is the user-facing setting; `GEZEL_LLAMA_NUM_CTX`
  // is the env override (eval runs, headless scripted experiments). Env
  // wins when set so an experiment can lift the cap without touching
  // config on disk. KV cache memory grows ~linearly with this — bumping
  // a 120B MoE from 64K → 128K adds ~5-10 GB resident, so the override
  // is most useful on the unified-memory boxes that also lift the
  // capacity broker.
  const envNumCtx = (() => {
    const env = process.env.GEZEL_LLAMA_NUM_CTX;
    if (env) {
      const n = Number.parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  })();
  const numCtx = envNumCtx ?? config.llamaCppNumCtx;
  // Per-model context override (Settings → Local models → Context size…).
  // More specific than the machine-wide llamaCppNumCtx, still below the env
  // escape hatch. Consumed by the supervised context resolution below — an
  // external llama-server owns its own --ctx-size, so the external path
  // keeps reading `numCtx`.
  const perModelCtxOverride = defaultModelId
    ? config.modelContextOverrides?.[`llama-cpp:${defaultModelId}`]
    : undefined;
  const baseProviderOpts = {
    fetchImpl: createLlamaCppPatientFetch(),
    ...(defaultModelId ? { defaultModel: defaultModelId } : {}),
    // llama-server only sends its final `usage` chunk (and the `timings`
    // block that rides with it, carrying decode/prefill rate + cache_n) when
    // the request opts in. Without this the usage tracker stayed empty for
    // every llama-cpp turn, so the product could not show tokens or a decode
    // rate for its own default engine — throughput was reachable only by
    // scraping stdout from the eval harness.
    includeUsageInStream: true,
    // External-baseUrl default; the supervised path overrides this with the
    // auto-sized `slots` computed below (after the model resolves).
    concurrency: configuredSlots ?? 2,
    ...(affinity !== undefined ? { affinity } : {}),
    ...(numCtx ? { numCtx } : {}),
    // User-overridable idle-stream watchdogs. Default 5 min on each is
    // set inside the provider; we forward only when the config carries
    // an explicit override so the provider's defaults stay the source
    // of truth. Mirrors the same pattern Ollama uses.
    ...(config.llamaCppStreamingIdleSec
      ? { streamingIdleMs: config.llamaCppStreamingIdleSec * 1000 }
      : {}),
    // Pre-first-byte cap: `config.llamaCppPreFirstByteIdleSec` is the
    // user-facing knob; `GEZEL_LLAMA_PRE_FIRST_BYTE_TIMEOUT_MS` is the
    // env override (headless eval runs). Wild-caught (
    // nemotron-super-120b chat-stalled trials): cold-loading the 86 GB
    // GGUF + a 20K-token meester prompt prefill takes 6-10 minutes on
    // unified-memory hardware; the provider's 300s default trips and
    // aborts the meester's first turn before the model has emitted
    // anything, leaving the trial wedged with no completed turn.
    // Honor env first when set so eval runs can lift the ceiling
    // without touching `~/.gezel/config.json`.
    ...(() => {
      const envMs = process.env.GEZEL_LLAMA_PRE_FIRST_BYTE_TIMEOUT_MS;
      if (envMs) {
        const n = Number.parseInt(envMs, 10);
        if (Number.isFinite(n) && n > 0) {
          return { preFirstByteIdleMs: n };
        }
      }
      return config.llamaCppPreFirstByteIdleSec
        ? { preFirstByteIdleMs: config.llamaCppPreFirstByteIdleSec * 1000 }
        : {};
    })(),
  };

  if (externalBaseUrl) {
    // External engine — no supervised process, no stdout to capture.
    // Log file + phase events apply only to the supervised path.
    return new LlamaCppProvider({
      baseUrl: externalBaseUrl,
      ...baseProviderOpts,
    });
  }

  if (!binary) {
    // Lazy resolve: kick (or attach to) a background engine download and
    // surface its progress as an actionable error this turn. A later turn
    // — once the resolver stamps GEZEL_LLAMA_SERVER_BIN — skips this branch.
    const ensured = opts.ensureEngine?.();
    if (ensured) {
      const dErr = new Error(ensured.detail);
      (dErr as Error & { isActionable: boolean }).isActionable = true;
      throw dErr;
    }
    const err = new Error(
      'On-device provider: no local engine is available on this machine. Open Settings → On-device → Advanced and point the External engine URL at a running llama-server, or install a Gezel build that bundles the engine. (Developers: drop a llama-server binary into native/build/<platform>/ and restart the app.)',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // Model path: explicit env / config wins; otherwise pick the
  // first catalog-installed model. Whenever we resolve through the
  // catalog, we also capture the full summary so we can read the
  // advertised `contextWindow` below.
  //
  // Pool-driven path (`modelOverride` set): skip the env/config
  // override entirely — the pool's caller already decided which
  // modelId to load. Falls back to `resolveModel(modelId)`; on
  // miss this throws so the broker sees a clean failure rather
  // than silently loading some other model.
  const explicitPath = opts.modelOverride
    ? undefined
    : (process.env.GEZEL_LLAMA_CPP_MODEL ?? config.llamaCppModelPath);
  let modelPath = explicitPath;
  let modelCatalogInfo: import('./index.js').InstalledLlamaCppModel | null = null;
  if (!modelPath && opts.llamaCppModels) {
    if (defaultModelId) {
      modelCatalogInfo = await opts.llamaCppModels.resolveModel(defaultModelId);
    }
    if (!modelCatalogInfo && !opts.modelOverride) {
      modelCatalogInfo = await opts.llamaCppModels.resolveDefaultModel();
    }
    if (modelCatalogInfo) modelPath = modelCatalogInfo.weightsPath;
  }

  // KV-cache precision. Gemma 3/4 are unusually sensitive to a quantized
  // KV cache: large attention head dims (key/value_length = 512), a final
  // logit softcap, and sliding-window attention mean an 8-bit KV cache
  // corrupts the *stored prompt tokens* — the model reasons fine but
  // recalls cached source/text as garbled multilingual tokens. Wild-caught
  // (gemma4-12b): quoted source lines came back as Korean
  // glyphs + emoji with `K/V = q8_0`. Default the Gemma family to f16 KV;
  // every other family keeps the q8_0 default. An explicit
  // `config.llamaCppKvCacheType` always wins. f16 KV costs ~2x the cache
  // memory on Gemma — the slot-ceiling math below reads THIS value so slot
  // sizing stays consistent with what the engine actually allocates.
  let kvCacheType = resolveLlamaCppKvCacheType({
    architecture: modelCatalogInfo?.architecture,
    modelId: defaultModelId ?? undefined,
    override: config.llamaCppKvCacheType,
  });
  if (!modelPath) {
    // See the MLX path for the rationale: a configured/pinned model ID that
    // no longer resolves is a stale selection, not an empty install — name
    // it so the user knows which saved selection to fix.
    let message: string;
    if (defaultModelId && !modelCatalogInfo) {
      const installed = opts.llamaCppModels ? await opts.llamaCppModels.listInstalled() : [];
      message = installed.length
        ? `Local model: the selected model "${defaultModelId}" is no longer available. ` +
          `Pick a local model in Settings → This Mac (${installed
            .map((m) => m.id)
            .join(', ')}), or download "${defaultModelId}" again.`
        : `Local model: the selected model "${defaultModelId}" is not available locally, and no models are downloaded. Download a model from the list above.`;
    } else {
      message = 'Local model: no model downloaded. Download a model from the list above.';
    }
    const err = new Error(message);
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // Per Phase 0 measurements on a cold Mac: Metal library compile is
  // ~14s and model load adds model-size-dependent time. Default
  // startupTimeoutMs is 60s which squeaks through for a 7B on a warm
  // machine but fails the first-ever run. 180s gives headroom for
  // the full first-launch cost.

  // ── Effective context-size resolution ──
  // We want a generous working window without allocating a full 128K
  // slot on a 2B model where most of it would sit empty and eat VRAM.
  //
  //   adaptive target       — per-model manifest
  //                           `tuning.engine.llamaCpp.contextSize`, else
  //                           the 65K global default (see below).
  //   model maximum         — advertised native context from the GGUF
  //                           metadata captured on install.
  //   effectiveNumCtx       — the selected policy's target, clamped to the
  //                           native max and then admitted against memory.
  //                           Semantics: PER SLOT (i.e. per concurrent turn),
  //                           not the total KV cache.
  //
  // The launch passes `--ctx-size ${effectiveNumCtx * slots}` because
  // llama-server divides total ctx evenly across `--parallel`, so the
  // multiplication is what makes `effectiveNumCtx` actually land as
  // the per-turn budget. The session reports `numCtx = effectiveNumCtx`
  // (per-slot) so `ChatManager.checkContextPressure` and the MCP
  // bridge's adaptive tool-output cap both work on a single turn's
  // budget — see `capToolOutput` / Layer 2.
  //
  // Why 65K (after 32K and 49K): matrix #3 petshop
  // OOM'd at `tokens=67924/49152` — 138% over the 49K ceiling. The
  // Voorman + Designer + Image-gen team's iteration depth, combined
  // with 4× read_artifact bringing full file contents back into
  // context per call, produces a working set in the 60-70K range.
  // 65K leaves a small safety margin below 70K; combined with the
  // compaction threshold drop to 0.70, sessions should compact at
  // ~45K and have headroom for 2-3 more tool round-trips. KV cache
  // at 65K on a 26B Q4_K_M Gemma is ~2 GB resident — well under
  // the 32+ GB hosts this size model already requires.
  // Per-model engine-launch defaults from the catalog manifest
  // (`tuning.engine.llamaCpp`). Resolved here (stable catalog data) so
  // `contextSize` can feed the Adaptive target below; also consumed later by
  // specDraft / MTP resolution and merged UNDER the user's global
  // `config.llamaCpp*` overrides by `buildLlamaCppEngineArgs`.
  const manifestEngineConfig = opts.catalog
    ? await resolveCatalogLlamaCppEngineConfig(
        opts.catalog,
        opts.modelOverride?.modelId ?? defaultModelId,
      )
    : undefined;

  const PREFERRED_CTX_DEFAULT = 65_536;
  // Explicit numeric values win: env, then the per-model override, then the
  // machine-wide config. Otherwise Adaptive uses the per-model manifest
  // recommendation (or the 64K practical default) and may GROW toward the
  // native window after admission settles, while Model maximum requests the
  // GGUF's native window and makes it the strict admission floor. Every
  // path still clamps to the native train context.
  const explicitCtx = envNumCtx ?? perModelCtxOverride ?? config.llamaCppNumCtx;
  const hostFloorTokens = minViableLocalContextTokens();
  // A per-model override below the host floor is deliberate user intent —
  // lower the admission floor to the override instead of silently raising
  // the request back to 64K. Env / machine-wide values keep their
  // historical floor semantics.
  const minViableTokens =
    perModelCtxOverride !== undefined && explicitCtx === perModelCtxOverride
      ? Math.min(hostFloorTokens, perModelCtxOverride)
      : hostFloorTokens;
  const contextRequirement = resolveLlamaCppContextRequirement({
    modelContextWindow: modelCatalogInfo?.contextWindow,
    ...(explicitCtx !== undefined ? { explicitContextWindow: explicitCtx } : {}),
    adaptiveContextWindow: manifestEngineConfig?.contextSize ?? PREFERRED_CTX_DEFAULT,
    ...(manifestEngineConfig?.contextSize !== undefined
      ? { manifestContextSize: manifestEngineConfig.contextSize }
      : {}),
    contextSizing: config.llamaCppContextSizing ?? 'adaptive',
    minViableContextTokens: minViableTokens,
  });
  // `let`: RAM-aware admission below may lower this (but never below the
  // model-aware minimum) before anything launch-visible consumes it.
  let effectiveNumCtx = contextRequirement.requestedPerTurnCtxTokens;

  // Auto-size supervised slots now that the model + context window are
  // known: a fast-memory demand default, clamped by a per-model KV memory
  // ceiling so a big model on a small machine can't OOM by over-slotting.
  // Explicit `providerConcurrency['llama-cpp']` overrides verbatim.
  // (Co-resident pool models aren't subtracted here — the broker still
  // denies an over-commit at spawn; threading committed bytes is a TODO.)
  const {
    fastMemoryBudgetBytes,
    defaultLocalEngineSlots,
    llamaCppSlotCeiling,
    computeCapacityBudget,
    estimatePerSlotKvBytes,
    planCtxTokensForMemory,
    plannedLocalEngineSlots,
  } = await import('../native/capacity-broker.js');
  // Subtract co-resident model reservations from the budget when the pool
  // broker is wired (multi-model path), using its actual (possibly config-
  // overridden) budget. Caveat: the broker tracks each model's resident
  // WEIGHTS, not its slot KV, so co-resident KV isn't fully captured — a
  // broader broker improvement. Singleton path has no broker → full budget.
  //
  // Slots are sized against FAST memory, not the admission budget. On a
  // discrete card those differ: the budget also covers the system RAM an
  // offloaded MoE streams experts from, and KV that follows that number
  // instead of the card's own capacity is how a GPU runs out of memory.
  // Unified and CPU-only hosts have one pool, so the two are the same there.
  const brokerSnap = opts.broker?.committed();
  const budgetBytes = brokerSnap?.enforced
    ? (opts.broker?.fastBudgetBytes() ?? brokerSnap.pools.fastBytes)
    : fastMemoryBudgetBytes();
  const committedOtherBytes = brokerSnap?.enforced ? brokerSnap.committedBytes : 0;
  // Gemma f16-KV vs a second slot: when memory alone forces single-slot,
  // trade to q8_0 KV if that buys ≥2 slots — SWA models get no rescue
  // from llama-server's prompt cache, so single-slot session alternation
  // re-prefills the other session's whole context (~41K tok ≈ 79s,
  // wild-caught). Policy + evidence in planLlamaCppKv; explicit
  // kvCacheType or slot config disables the trade.
  // Header-exact per-slot KV for the slot ceiling (M2); the weights
  // heuristic only when no readable GGUF is at hand (external base URL,
  // manual model path). Metadata-only read — the tensor-size walk for the
  // offload planner happens later and separately.
  let headerSummary: GgufSummary | null = null;
  if (modelPath) {
    try {
      headerSummary = await readGgufSummaryAsync(modelPath);
    } catch {
      headerSummary = null;
    }
  }
  const exactPerSlotKvF16 = headerSummary
    ? estimateExactPerSlotKvBytesF16(
        {
          blockCount: headerSummary.blockCount,
          embeddingLength: headerSummary.embeddingLength,
          headCount: headerSummary.headCount,
          headCountKv: headerSummary.headCountKv,
          headCountKvPerLayer: headerSummary.headCountKvPerLayer,
          slidingWindow: headerSummary.slidingWindow,
          slidingWindowPattern: headerSummary.slidingWindowPattern,
          sharedKvLayers: headerSummary.sharedKvLayers,
          keyLength: headerSummary.keyLength,
          valueLength: headerSummary.valueLength,
          keyLengthSwa: headerSummary.keyLengthSwa,
          valueLengthSwa: headerSummary.valueLengthSwa,
        },
        effectiveNumCtx,
      )
    : undefined;
  const ceilingFor = (kv: LlamaCppKvCacheType) =>
    llamaCppSlotCeiling({
      budgetBytes,
      sizingBudgetBytes: brokerSnap?.enforced
        ? brokerSnap.pools.concurrencySizingBytes
        : computeCapacityBudget().concurrencySizingBytes,
      weightsBytes: modelCatalogInfo?.approxSizeBytes ?? 8 * 1024 ** 3,
      perTurnCtxTokens: effectiveNumCtx,
      kvCacheType: kv,
      committedOtherBytes,
      ...(exactPerSlotKvF16 !== undefined ? { exactPerSlotKvBytesF16: exactPerSlotKvF16 } : {}),
    });
  const kvPlan = planLlamaCppKv({
    architecture: modelCatalogInfo?.architecture,
    modelId: defaultModelId ?? undefined,
    override: config.llamaCppKvCacheType,
    slotsConfigured: configuredSlots !== undefined,
    ceilingFor,
    maxSlots: defaultLocalEngineSlots(budgetBytes),
  });
  if (kvPlan.upgraded) {
    kvCacheType = kvPlan.kvCacheType;
    log.info(
      `[llama-cpp] ${modelCatalogInfo?.id ?? defaultModelId ?? 'model'}: trading f16 KV for q8_0 to fit a second engine slot (single-slot SWA session alternation re-prefills wholesale; KV A/B 2026-08-03 showed no measurable q8_0 fidelity cost)`,
    );
  }
  let slots = plannedLocalEngineSlots({
    configuredSlots,
    ceiling: ceilingFor(kvCacheType),
    tierDefault: defaultLocalEngineSlots(budgetBytes),
  });
  // The bundled llama.cpp line still has known multi-slot MTP allocation
  // failures. Keep an explicitly selected MTP mode on one slot so its first
  // decode is reliable; `spec.mtp` alone is capability metadata, not an
  // auto-enable policy.
  const selectedSpecType = config.llamaCppSpecType ?? manifestEngineConfig?.spec?.type;
  if (selectedSpecType === 'draft-mtp' && slots > 1) {
    log.info(
      `[llama-cpp] limiting ${modelCatalogInfo?.id ?? 'MTP model'} to one slot because draft-mtp is not reliable with --parallel > 1 in the bundled engine`,
    );
    slots = 1;
  }
  // Opportunistic batched inference (adaptive interactive policy). Default
  // on for llama-cpp with >1 slot — llama-server batches the `--parallel`
  // slots with continuous batching on by default. `GEZEL_BATCHED_INFERENCE`
  // (eval A/B) overrides config, which overrides the per-engine default.
  const envBatched = process.env.GEZEL_BATCHED_INFERENCE;
  const envBatchedOverride =
    envBatched === '1' || envBatched === 'true'
      ? true
      : envBatched === '0' || envBatched === 'false'
        ? false
        : undefined;
  const batchedInferenceEnabled =
    envBatchedOverride ?? config.batchedInference?.enabled ?? slots > 1;
  // Only the SUPERVISED path controls `--parallel`, so co-batching is
  // forwarded only there; an external llama-server may be single-slot.
  let batchMaxConcurrency = batchedInferenceEnabled && slots > 1 ? slots : 1;

  // Rolling log file at ~/.gezel/logs/llama-server-YYYY-MM-DD.log.
  // Captures raw stdout/stderr so users (and bug reports) have a
  // durable record of what the engine was doing. Tee with the
  // default console.log path so dev iteration still sees output live.
  const { LlamaCppLogFile, LlamaProgressLogThrottle } = await import('./log.js');
  const logFile = new LlamaCppLogFile(gezelPaths(home).logs);
  const progressLogThrottle = new LlamaProgressLogThrottle();

  // ── Slot-cache persistence (Phase 1.2) ──
  // Per-model directory passed to llama-server's --slot-save-path.
  // The adapter writes `sess-<sessionId>.bin` and
  // `prefix-<gezelHash>.bin` files we read back on session resume.
  // Per-model fingerprint segmentation prevents wrong-shape cache
  // loads if the user swaps models behind the same path.
  const llamaCacheRoot = join(home, 'engines', 'llama-cpp', 'slots');
  const { createHash: createLlamaHash } = await import('node:crypto');
  const { mkdir: mkdirAsync } = await import('node:fs/promises');
  const llamaFingerprint = createLlamaHash('sha256')
    .update(
      [
        modelCatalogInfo?.id ?? defaultModelId ?? modelPath,
        modelCatalogInfo?.installedAt ?? '',
        modelPath,
      ].join('::'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 24);
  // Replica isolation: replica 0 keeps the canonical path so an
  // upgrade from singleton to pool reuses the old slot files; 1+
  // get a `replica-N` subdir so concurrent llama-server instances
  // don't trample one another's slot writes.
  const replicaSuffix =
    opts.modelOverride && opts.modelOverride.replicaIdx > 0
      ? `replica-${opts.modelOverride.replicaIdx}`
      : '';
  const slotSavePath = replicaSuffix
    ? join(llamaCacheRoot, llamaFingerprint, replicaSuffix)
    : join(llamaCacheRoot, llamaFingerprint);
  // Pre-create the directory so llama-server's save endpoint doesn't
  // fail on first save (it doesn't recursively create paths).
  await mkdirAsync(slotSavePath, { recursive: true }).catch(() => {});

  // `--reasoning-budget N` from the catalog's `tuning.reasoning.thinkingBudget`.
  // llama-server's default is -1 (unrestricted). For qwen3-family models
  // that can think for ~15K tokens then emit nothing, capping the
  // budget at the manifest's recommended value is the difference
  // between "Builder produces code" and "Builder hangs the trial."
  // See `resolveCatalogReasoningBudget` for the lookup rationale.
  const reasoningBudgetTokens = opts.catalog
    ? await resolveCatalogReasoningBudget(
        opts.catalog,
        opts.modelOverride?.modelId ?? defaultModelId,
      )
    : undefined;

  // Speculative-decoding draft resolution — a manifest names its draft by
  // catalog id; resolve it to the installed GGUF path (or disable) before the
  // argv is built. See providers/llama-cpp/spec-draft.ts for the full rules.
  const specDraft = await resolveSpecDraft({
    perModel: manifestEngineConfig,
    configSpecType: config.llamaCppSpecType,
    configDraftModelPath: config.llamaCppDraftModelPath,
    resolveDraftPath: (id) =>
      opts.llamaCppModels ? opts.llamaCppModels.resolveModelPath(id) : Promise.resolve(null),
  });
  const resolvedManifestEngineConfig = specDraft.perModel;
  if (specDraft.log) log[specDraft.log.level](specDraft.log.message);

  // Phase v2 — hardware-aware MoE offload. Probe device VRAM (cached to
  // `engines/llama-cpp/devices.json` via `--list-devices`) and read the
  // model's MoE metadata from its GGUF header; the planner decides
  // whether to stream experts from system RAM (`--cpu-moe`) on a
  // constrained-VRAM GPU. This is the LOWEST-precedence input to
  // `buildLlamaCppEngineArgs` (an explicit global config or manifest
  // value still wins), and we log the rationale so the operator can see
  // WHY a model was — or wasn't — split. Best-effort: any failure falls
  // back to the engine's own `--fit` / `-ngl auto`.
  let offloadDecision: PlannerOffloadDecision | undefined;
  // Whether weights + full-attention KV at the requested context fit the
  // fast-memory pool — VRAM on a discrete GPU. Gates the Gemma
  // `--swa-full` auto-default (see `EngineFlagInput.swaFullAutoFits`). Set
  // false to keep the full context on the windowed cache when Full would
  // spill or require a slot/context reduction; undefined means it fits or
  // the exact decision could not be computed.
  let swaFullAutoFits: boolean | undefined;
  // Broker-ledger reservation for this launch: resident weights + the KV
  // the engine will actually allocate at the granted window and cache
  // mode. Undefined when the GGUF is unreadable — the pool builder then
  // falls back to the legacy weights-multiplier reservation.
  let plannedReservationBytes: number | undefined;
  // Whether the model's GGUF ships MTP (`nextn`) layers — a safety
  // cross-check for an explicit draft-mtp request.
  let ggufHasMtp = false;
  let mtpLayerCount = 0;
  const llamaBuildMetadata = binary ? await readLlamaCppBuildMetadata(binary) : null;
  let llamaGpuDevice: import('./devices.js').LlamaDevice | null = null;
  let nvidiaRuntimeDevice: import('./devices.js').NvidiaRuntimeDevice | undefined;
  let llamaDevices: import('./devices.js').LlamaDevice[] = [];
  if (binary) {
    const [probe, nvidiaDevices] = await Promise.all([
      probeLlamaDevices({ binaryPath: binary, home }),
      probeNvidiaRuntimeDevices(),
    ]);
    llamaDevices = probe.devices;
    llamaGpuDevice = pickBestGpuDevice(probe.devices);
    nvidiaRuntimeDevice = matchNvidiaRuntimeDevice(llamaGpuDevice, nvidiaDevices);
  }
  if (binary && modelPath) {
    try {
      // `includeTensorSizes` walks the tensor table (~5 MB read on a 100 GB
      // GGUF, <500 ms) so the planner can budget the exact expert/non-expert
      // byte split instead of a flat resident estimate.
      const summary = await readGgufSummaryAsync(modelPath, { includeTensorSizes: true });
      const isMoE = (summary.expertCount ?? 0) > 1;
      mtpLayerCount = summary.nextnPredictLayers ?? 0;
      ggufHasMtp = mtpLayerCount > 0;
      if (!ggufHasMtp && modelCatalogInfo?.draftModelPath) {
        const draftSummary = await readGgufSummaryAsync(modelCatalogInfo.draftModelPath);
        mtpLayerCount = draftSummary.nextnPredictLayers ?? 0;
        ggufHasMtp = mtpLayerCount > 0;
      }
      const approxBytes = modelCatalogInfo?.approxSizeBytes ?? summary.fileSizeBytes;
      const residentBytes = Math.round(approxBytes * 1.2);
      const vramBytes = maxGpuVramBytes(llamaDevices);
      const split =
        summary.nonExpertBytes !== undefined &&
        summary.expertBytesByLayer !== undefined &&
        summary.expertBytesByLayer.length > 0
          ? {
              nonExpertBytes: summary.nonExpertBytes,
              expertBytesByLayer: summary.expertBytesByLayer,
            }
          : undefined;
      // ── RAM-aware context admission ──
      // The slot ceiling sizes the slot COUNT and the broker admits
      // WEIGHTS; neither asks whether one slot at the requested context
      // fits at all. On models with outsized attention geometry that gap
      // is enormous — gemma4-12b at f16 KV is ~380 KB/token, so a 64K
      // default projects ~25 GB of KV and turned a 6.7 GB model into a
      // ~25 GB process that paged a 32 GB machine to a standstill
      // (2026-08-03, two daemons × one model each). Clamp the per-turn
      // context so weights + total KV + compute headroom fit both the
      // capacity budget and live free memory. Exact per-token KV from the
      // GGUF header; the weights-scaled heuristic only as fallback.
      // The admission ladder (deny → reduce slots → clamp) is skipped
      // under GEZEL_LLAMA_NUM_CTX — eval runs lift ceilings deliberately
      // and accept the memory consequences.
      //
      // The fit verdict additionally gates the Gemma `--swa-full`
      // auto-default, in BOTH branches: the full cache is a cache-operation
      // performance trade, while the context window is capability. Auto
      // therefore requires resident weights + exact full KV to fit the fast
      // pool (VRAM on a discrete GPU); otherwise it keeps the full window on
      // the windowed cache. Shared-KV layers and SWA-specific head dimensions
      // are load-bearing here — E4B owns only 24 KV caches for 42 logical
      // layers, and pricing all 42 at global dimensions overstated its two-slot
      // 64K KV allocation as 21 GiB instead of llama.cpp's actual 7 GiB.
      // When the windowed cache is what will run, the launch is NOT left
      // ungated: admission re-plans with the windowed-KV linearization
      // (SWA layers = fixed window-capped bytes, global layers = the only
      // per-token cost), so a host too small even for the windowed cache
      // still denies or clamps honestly instead of OOMing one machine
      // class below the 2026-08-05 incident.
      {
        const REFERENCE_CTX = 4096;
        const exactKvAtReference = estimateKvReserveBytes({
          blockCount: summary.blockCount,
          embeddingLength: summary.embeddingLength,
          headCount: summary.headCount,
          headCountKv: summary.headCountKv,
          headCountKvPerLayer: summary.headCountKvPerLayer,
          slidingWindowPattern: summary.slidingWindowPattern,
          sharedKvLayers: summary.sharedKvLayers,
          keyLength: summary.keyLength,
          valueLength: summary.valueLength,
          keyLengthSwa: summary.keyLengthSwa,
          valueLengthSwa: summary.valueLengthSwa,
          fullAttentionInterval: summary.fullAttentionInterval,
          ssmInnerSize: summary.ssmInnerSize,
          ssmStateSize: summary.ssmStateSize,
          ssmConvKernel: summary.ssmConvKernel,
          ctxTokens: REFERENCE_CTX,
          kvCacheType,
        });
        const kvBytesPerToken =
          exactKvAtReference !== undefined
            ? exactKvAtReference / REFERENCE_CTX
            : estimatePerSlotKvBytes({
                perTurnCtxTokens: REFERENCE_CTX,
                weightsBytes: approxBytes,
                kvCacheType,
              }) / REFERENCE_CTX;
        const liveMemory = await (async () => {
          try {
            const { detectMemoryProfileCached } = await import('../../system/memory.js');
            return await detectMemoryProfileCached();
          } catch {
            return null;
          }
        })();
        const liveBudget = computeCapacityBudget({
          ...(liveMemory ? { systemRamBytes: liveMemory.totalRamBytes } : {}),
          gpuVramBytes: (liveMemory?.gpuVramBytes ?? vramBytes) || null,
          ...(liveMemory
            ? {
                unifiedMemory:
                  liveMemory.gpuMemoryKind === 'integrated' ||
                  liveMemory.gpuMemoryKind === 'unified',
              }
            : {}),
        });
        const fastBudgetBytes = brokerSnap?.enforced
          ? (opts.broker?.fastBudgetBytes() ?? liveBudget.fastBytes)
          : liveBudget.fastBytes;
        const fullKvBytesAtRequested =
          exactKvAtReference !== undefined
            ? (exactKvAtReference / REFERENCE_CTX) * effectiveNumCtx * slots
            : undefined;
        const fullCacheFitsFastMemory =
          fullKvBytesAtRequested !== undefined
            ? fitsSwaFullInFastMemory({
                residentWeightsBytes: residentBytes,
                fullKvBytes: fullKvBytesAtRequested,
                fastBudgetBytes,
                committedOtherBytes,
              })
            : undefined;
        const admission = planCtxTokensForMemory({
          requestedPerTurnCtxTokens: effectiveNumCtx,
          slots,
          minimumPerTurnCtxTokens: contextRequirement.minimumPerTurnCtxTokens,
          kvBytesPerToken,
          weightsResidentBytes: residentBytes,
          budgetBytes: brokerSnap?.enforced ? brokerSnap.budgetBytes : liveBudget.budgetBytes,
          committedOtherBytes,
          freeSystemRamBytes: availableSystemRamBytes(),
          vramBytes: liveBudget.vramBytes,
        });
        const explicitSwaFull = config.llamaCppSwaFull ?? manifestEngineConfig?.swaFull;
        const swaFullAutoDefault =
          explicitSwaFull === undefined &&
          isGemmaModel({
            architecture: modelCatalogInfo?.architecture,
            modelId: defaultModelId ?? undefined,
          });
        const fullKvOverBudget =
          fullCacheFitsFastMemory === false ||
          !admission.minimumSatisfied ||
          admission.slots < slots ||
          admission.clamped;
        // The plan whose ladder (deny → shed slots → clamp) is enforced
        // below. Defaults to the full-attention plan; the windowed-cache
        // branches replace it with windowed math or — only when the GGUF
        // hides its SWA layout — null (no safe estimate; launch untouched,
        // the pre-windowed-admission behavior).
        let ladderPlan: typeof admission | null = admission;
        // The per-slot KV linearization the accepted plan priced with, so
        // the growth pass below cannot disagree with admission about the
        // same launch. Windowed branch swaps in its slope + fixed block;
        // the no-safe-estimate branch nulls it (no growth either).
        let ladderKvLinearization: { bytesPerToken: number; fixedPerSlotBytes: number } | null = {
          bytesPerToken: kvBytesPerToken,
          fixedPerSlotBytes: 0,
        };
        // Strict model-max deliberately does NOT gate this: for SWA models
        // the windowed cache is the only layout whose native-window KV can
        // fit real machines (gemma4-12b at 256K: 4.8 GB windowed vs 164 GB
        // full-attention), and the strict minimum rides inside
        // `contextRequirement.minimumPerTurnCtxTokens`, so the windowed
        // re-plan below sheds slots or denies but never shortens the window.
        const windowedCacheWillRun =
          fullKvOverBudget && (swaFullAutoDefault || explicitSwaFull === false);
        if (windowedCacheWillRun) {
          // The denial, the slot reduction, and the clamp above are all
          // driven by full-attention KV math, which overstates the windowed
          // cache's real allocation (Gemma 4: global layers are both fewer
          // AND cheaper per token than SWA layers — ~14× on 31b). Re-plan
          // with the windowed linearization: SWA layers become a fixed,
          // context-independent reservation; only global layers scale.
          // Without it a 31b-class Gemma on a ~32 GB host would launch
          // with NO context admission at all — the same lazy-Metal-wiring
          // OOM this gate exists to prevent, one machine class down.
          const windowed = estimateWindowedKvLinearization({
            blockCount: summary.blockCount,
            embeddingLength: summary.embeddingLength,
            headCount: summary.headCount,
            headCountKv: summary.headCountKv,
            headCountKvPerLayer: summary.headCountKvPerLayer,
            slidingWindow: summary.slidingWindow,
            slidingWindowPattern: summary.slidingWindowPattern,
            sharedKvLayers: summary.sharedKvLayers,
            keyLength: summary.keyLength,
            valueLength: summary.valueLength,
            keyLengthSwa: summary.keyLengthSwa,
            valueLengthSwa: summary.valueLengthSwa,
            fullAttentionInterval: summary.fullAttentionInterval,
            ssmInnerSize: summary.ssmInnerSize,
            ssmStateSize: summary.ssmStateSize,
            ssmConvKernel: summary.ssmConvKernel,
            kvCacheType,
          });
          if (swaFullAutoDefault) {
            // Declining `--swa-full` dominates every full-math remedy:
            // the context window is capability, the full cache is a
            // session-switch performance trade. Weights-level admission
            // stays with the capacity broker.
            swaFullAutoFits = false;
            const fastFitDetail =
              fullCacheFitsFastMemory === false && fullKvBytesAtRequested !== undefined
                ? `projected weights + full KV ${(
                    (residentBytes + fullKvBytesAtRequested) / 1024 ** 3
                  ).toFixed(1)} GiB exceeds available fast memory ${(
                    Math.max(0, fastBudgetBytes - committedOtherBytes) / 1024 ** 3
                  ).toFixed(1)} GiB`
                : undefined;
            log.warn(
              [
                `[llama-cpp] ${modelCatalogInfo?.id ?? 'model'}: the full SWA working set at the requested `,
                `${effectiveNumCtx * slots}-token total context does not fit fast memory — keeping the full `,
                'context and declining the --swa-full auto-default instead; the windowed KV cache ',
                'is what actually fits (cross-request prefix reuse unavailable). ',
                `Fit detail: ${fastFitDetail ?? admission.reason ?? 'over budget at the requested slot count'}`,
              ].join(''),
            );
          }
          if (windowed) {
            ladderPlan = planCtxTokensForMemory({
              requestedPerTurnCtxTokens: effectiveNumCtx,
              slots,
              minimumPerTurnCtxTokens: contextRequirement.minimumPerTurnCtxTokens,
              kvBytesPerToken: windowed.bytesPerToken,
              weightsResidentBytes: residentBytes + windowed.fixedBytes * slots,
              budgetBytes: brokerSnap?.enforced ? brokerSnap.budgetBytes : liveBudget.budgetBytes,
              committedOtherBytes,
              freeSystemRamBytes: availableSystemRamBytes(),
              vramBytes: liveBudget.vramBytes,
            });
            ladderKvLinearization = {
              bytesPerToken: windowed.bytesPerToken,
              fixedPerSlotBytes: windowed.fixedBytes,
            };
          } else if ((summary.slidingWindow ?? 0) > 0 || swaFullAutoDefault) {
            // A sliding-window model whose GGUF hides the layer layout:
            // full math over-states the real cache and there is no exact
            // substitute — leave the launch alone rather than over-clamp.
            ladderPlan = null;
            ladderKvLinearization = null;
          }
          // else: `swaFull: false` pinned on a model with no SWA layers at
          // all — the flag is a no-op there and the full-attention plan IS
          // the real allocation; fall through with it intact.
        }
        if (ladderPlan !== null && envNumCtx === undefined) {
          const windowedNote = ladderPlan === admission ? '' : ' (windowed KV admission)';
          if (!ladderPlan.minimumSatisfied) {
            throw new CapacityDeniedError(
              formatContextCapacityDenial({
                modelLabel: modelCatalogInfo?.name ?? defaultModelId ?? 'this local model',
                plan: ladderPlan,
              }),
            );
          }
          if (ladderPlan.slots < slots) {
            log.info(
              `[llama-cpp] ${modelCatalogInfo?.id ?? 'model'}${windowedNote}: reducing engine slots ${slots} -> ${ladderPlan.slots} to preserve at least ${contextRequirement.minimumPerTurnCtxTokens} context tokens per turn`,
            );
            slots = ladderPlan.slots;
            batchMaxConcurrency = batchedInferenceEnabled && slots > 1 ? slots : 1;
          }
          if (ladderPlan.clamped) {
            log.warn(
              `[llama-cpp] ${modelCatalogInfo?.id ?? 'model'}${windowedNote}: ${ladderPlan.reason}`,
            );
            effectiveNumCtx = ladderPlan.perTurnCtxTokens;
          }
          // ── Adaptive context growth ──
          // Slots and the base grant are settled; spend whatever FAST
          // memory is left on a longer window, up to the resolver's target
          // (native window ∧ authored tuning ceiling ∧ operator env cap).
          // Exact GGUF geometry only: the weights-scaled heuristic
          // misprices KV by up to ~10× in both directions, and growth on a
          // mispriced slope is how a safe launch becomes a paging one.
          if (
            contextRequirement.growthTargetTokens !== undefined &&
            ladderKvLinearization !== null &&
            exactKvAtReference !== undefined
          ) {
            const growth = planAdaptiveContextGrowth({
              basePerTurnCtxTokens: effectiveNumCtx,
              targetPerTurnCtxTokens: contextRequirement.growthTargetTokens,
              slots,
              kvBytesPerToken: ladderKvLinearization.bytesPerToken,
              kvFixedPerSlotBytes: ladderKvLinearization.fixedPerSlotBytes,
              weightsResidentBytes: residentBytes,
              fastBudgetBytes,
              committedOtherBytes,
              budgetKind: brokerSnap?.enforced ? brokerSnap.pools.kind : liveBudget.kind,
              vramBytes: brokerSnap?.enforced ? brokerSnap.pools.vramBytes : liveBudget.vramBytes,
              freeSystemRamBytes: availableSystemRamBytes(),
              isMoE,
              // A user-chosen lane count is not growth's to spend.
              allowSlotTrade: configuredSlots === undefined,
            });
            if (growth.grown) {
              log.info(
                `[llama-cpp] ${modelCatalogInfo?.id ?? defaultModelId ?? 'model'}: ${growth.reason}`,
              );
              effectiveNumCtx = growth.perTurnCtxTokens;
              if (growth.slots < slots) {
                slots = growth.slots;
                batchMaxConcurrency = batchedInferenceEnabled && slots > 1 ? slots : 1;
              }
            }
          }
        }
      }

      // Price the KV the engine will ACTUALLY allocate. Mirrors the
      // `--swa-full` tri-state in buildLlamaCppEngineArgs (explicit config
      // → manifest → Gemma auto-default gated on the fit verdict): an SWA
      // model on the default windowed cache carries only its global layers
      // per token plus a fixed window block per slot. Feeding the offload
      // planner full-attention math for a windowed launch over-biased
      // Gemma experts into system RAM for a cache that never materializes.
      const effectiveSwaFull =
        config.llamaCppSwaFull ??
        manifestEngineConfig?.swaFull ??
        (swaFullAutoFits !== false &&
          isGemmaModel({
            architecture: modelCatalogInfo?.architecture,
            modelId: defaultModelId ?? undefined,
          }));
      const windowedKvPlan = effectiveSwaFull
        ? undefined
        : estimateWindowedKvLinearization({
            blockCount: summary.blockCount,
            embeddingLength: summary.embeddingLength,
            headCount: summary.headCount,
            headCountKv: summary.headCountKv,
            headCountKvPerLayer: summary.headCountKvPerLayer,
            slidingWindow: summary.slidingWindow,
            slidingWindowPattern: summary.slidingWindowPattern,
            sharedKvLayers: summary.sharedKvLayers,
            keyLength: summary.keyLength,
            valueLength: summary.valueLength,
            keyLengthSwa: summary.keyLengthSwa,
            valueLengthSwa: summary.valueLengthSwa,
            fullAttentionInterval: summary.fullAttentionInterval,
            ssmInnerSize: summary.ssmInnerSize,
            ssmStateSize: summary.ssmStateSize,
            ssmConvKernel: summary.ssmConvKernel,
            kvCacheType,
          });
      const kvReserveBytes = windowedKvPlan
        ? Math.round(
            windowedKvPlan.fixedBytes * slots +
              windowedKvPlan.bytesPerToken * effectiveNumCtx * slots,
          )
        : estimateKvReserveBytes({
            blockCount: summary.blockCount,
            embeddingLength: summary.embeddingLength,
            headCount: summary.headCount,
            headCountKv: summary.headCountKv,
            headCountKvPerLayer: summary.headCountKvPerLayer,
            slidingWindowPattern: summary.slidingWindowPattern,
            sharedKvLayers: summary.sharedKvLayers,
            keyLength: summary.keyLength,
            valueLength: summary.valueLength,
            keyLengthSwa: summary.keyLengthSwa,
            valueLengthSwa: summary.valueLengthSwa,
            fullAttentionInterval: summary.fullAttentionInterval,
            ssmInnerSize: summary.ssmInnerSize,
            ssmStateSize: summary.ssmStateSize,
            ssmConvKernel: summary.ssmConvKernel,
            ctxTokens: effectiveNumCtx * slots,
            kvCacheType,
          });
      // The broker-ledger reservation for this launch: resident weights
      // plus the KV the engine will allocate at the granted window (M1 —
      // the weights-only ledger under-reserved dense models whose KV
      // rivals their weights: qwen3.5-4b at 64K carries more KV than
      // parameters). Consumed by the pool builder via
      // `plannedReservationBytes` so co-residency admission can see it.
      if (kvReserveBytes !== undefined) {
        plannedReservationBytes = residentBytes + kvReserveBytes;
      }
      offloadDecision = planMoeOffload({
        isMoE,
        residentBytes,
        vramBytes,
        ...(split
          ? {
              split,
              ...(summary.blockCount !== undefined ? { blockCount: summary.blockCount } : {}),
              ...(kvReserveBytes !== undefined ? { kvReserveBytes } : {}),
            }
          : {}),
      });
      if (offloadDecision.reason) {
        log.info(
          `[llama-cpp] offload plan (${modelCatalogInfo?.id ?? 'model'}): ${offloadDecision.reason}`,
        );
      }
      // Surface an MTP opportunity WITHOUT auto-enabling it. `--spec-type
      // draft-mtp` on a model llama.cpp can't build an MTP context for is a
      // fatal launch error, and current model/backend pairs still need A/B
      // qualification before default-on.
      if (ggufHasMtp && !manifestEngineConfig?.spec?.mtp && !manifestEngineConfig?.spec?.type) {
        log.info(
          `[llama-cpp] ${modelCatalogInfo?.id ?? 'model'} ships an MTP head (nextn_predict_layers=${mtpLayerCount}); select MTP speculative decoding in Advanced llama.cpp settings to test it.`,
        );
      }
    } catch (err) {
      if (err instanceof CapacityDeniedError) throw err;
      log.warn(
        `[llama-cpp] offload planning skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (selectedSpecType === 'draft-mtp' && !ggufHasMtp) {
    log.warn(
      `[llama-cpp] draft-mtp was requested for ${modelCatalogInfo?.id ?? 'model'}, but its installed target/companion GGUF does not confirm MTP tensors; starting without speculative decoding.`,
    );
  }

  // Forward-declared provider reference — the supervisor's onRawLine
  // callback needs it, but the provider itself needs the supervisor.
  // One is built, then the other; `providerRef` bridges the cycle.
  const providerHolder: { current: LlamaCppProvider | null } = { current: null };

  let cachedPort: number | undefined;
  // Two-stage idle (Phase 2.5): freeze at half the idle budget,
  // SIGTERM at the full budget. The freeze hook flushes slot caches
  // to disk while the engine is still healthy — so a SIGKILL during
  // the freeze→stop window doesn't lose them. The busy guard below is the
  // provider's physical request gate, so a long generation is protected while
  // a tool loop parked between requests can release the GPU normally.
  const llamaIdleMs = config.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS;
  const llamaFreezeMs = Math.floor(llamaIdleMs / 2);
  // Per-model native-vision opt-in. Absent means off — see the `--mmproj`
  // block below for why this isn't simply "the projector is on disk".
  const nativeVisionEnabled =
    !!modelCatalogInfo?.mmprojPath && config.nativeVision?.[modelCatalogInfo.id] === true;
  // Startup timeout: 180s covers a 7B–30B model's CUDA warmup on
  // typical hardware. Frontier-tier 100B+ MoE models on unified-memory
  // boxes (DGX Spark, M-series Macs) routinely take 4–6 minutes for
  // the first KV-cache init; honor `GEZEL_LLAMA_STARTUP_TIMEOUT_MS`
  // so the user can lift the ceiling without recompiling.
  const llamaStartupTimeoutMs = (() => {
    const env = process.env.GEZEL_LLAMA_STARTUP_TIMEOUT_MS;
    if (env) {
      const n = Number.parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 180_000;
  })();
  const supervisor = new NativeEngineSupervisor({
    logPrefix: '[llama-server]',
    startupTimeoutMs: llamaStartupTimeoutMs,
    idleTimeoutMs: llamaIdleMs,
    freezeTimeoutMs: llamaFreezeMs,
    isBusy: () => providerHolder.current?.isEngineBusy() ?? false,
    ...(opts.arbiter ? { memoryPressure: () => opts.arbiter!.getMemoryPressureStatus() } : {}),
    onFreeze: async () => {
      // flushAll is best-effort and handles its own try/catch — but
      // we await so the supervisor's freeze log line aligns with
      // disk-write completion (the operator log reads as one event).
      await providerHolder.current?.getCacheAdapter()?.flushAll();
    },
    onLog: (line) => {
      for (const retainedLine of progressLogThrottle.accept(line)) {
        log.info(retainedLine);
        logFile.write(retainedLine);
      }
    },
    onExit: (snapshot) => {
      if (snapshot.expected) return;
      logFile.writeIncident(snapshot);
      // A build that dies by SIGILL before it ever answers /health has
      // not failed at a task — it cannot run on this CPU at all, and
      // relaunching it on every request just reproduces the crash while
      // a working lower-tier build sits in the same directory. Write it
      // down so the next launch routes around it.
      //
      // Deliberately narrow: only SIGILL, and only before readiness.
      // A SIGSEGV during startup can be a corrupt model file, and any
      // crash after readiness is attributable to the work rather than
      // the binary — quarantining a backend over either would demote
      // users to slow engines for transient reasons.
      if (snapshot.signal !== 'SIGILL' || snapshot.reachedReady) return;
      const backend = process.env.GEZEL_LLAMA_SERVER_BACKEND as LlamaBackend | undefined;
      if (!backend) return;
      const entry = recordLlamaQuarantine(home, {
        backend,
        binaryPath: binary,
        signal: 'SIGILL',
        reason:
          'crashed with SIGILL before the engine became ready — this build uses CPU instructions ' +
          'this machine does not support, or faulted inside GPU library startup',
      });
      if (entry) {
        log.warn(
          `[llama-server] quarantined the ${backend} build after SIGILL (incident=${snapshot.incidentId}); the next launch will fall back to another backend`,
        );
      }
    },
    onRawLine: (line) => providerHolder.current?.onStdoutLine(line),
    // GPU-OOM recovery ladder: when a start dies of VRAM exhaustion and the
    // planner's offload decision was in play, degrade it one step
    // (partial split → all experts to RAM → engine-owned fit) and let the
    // supervisor retry — `resolveLaunch` below re-reads `offloadDecision`
    // on every spawn. The degraded plan sticks for later restarts of this
    // provider, so a recovered engine doesn't re-OOM on its next boot.
    recoverStartup: ({ panicKind }) => {
      if (panicKind !== 'cuda-out-of-memory' && panicKind !== 'vulkan-out-of-memory') {
        return false;
      }
      // Explicit config/manifest offload settings shadow the planner
      // per-field (see `buildLlamaCppEngineArgs`); when every field the
      // ladder would change is pinned, a retry replays the same argv.
      const pinned = (globalValue: unknown, manifestValue: unknown) =>
        globalValue !== undefined || manifestValue !== undefined;
      if (
        pinned(config.llamaCppNGpuLayers, resolvedManifestEngineConfig?.nGpuLayers) &&
        pinned(config.llamaCppCpuMoe, resolvedManifestEngineConfig?.cpuMoe) &&
        pinned(config.llamaCppNCpuMoe, resolvedManifestEngineConfig?.nCpuMoe)
      ) {
        return false;
      }
      const degraded = degradeMoeOffloadDecision(offloadDecision);
      if (!degraded) return false;
      log.warn(
        `[llama-cpp] ${panicKind} while starting ${modelCatalogInfo?.id ?? 'model'} — ${degraded.reason}`,
      );
      offloadDecision = degraded;
      return true;
    },
    resolveLaunch: async () => {
      const port = cachedPort ?? (await pickFreePort());
      cachedPort = port;
      // Prepend the binary's own directory to PATH so the OS finds the
      // bundled CUDA / GGML peer DLLs at process startup, even when the
      // inherited PATH is sparse. Electron's PATH on Windows can omit
      // CUDA_PATH\bin entirely (the user's shell PATH doesn't propagate
      // when launched via VS Code / Start menu / shortcut), and
      // cublasLt's static dep on nvJitLink would otherwise exit
      // 0xC0000135 BEFORE main() runs. The bundle ships every required
      // DLL alongside the exe; this PATH tweak is what makes the
      // exe-dir-search-then-PATH-search resolve them all.
      const binDir = dirname(binary);
      const inheritedPath = process.env.PATH ?? '';
      const resolvedAdvancedArgs = buildLlamaCppEngineArgs({
        config,
        perModel: resolvedManifestEngineConfig,
        planner: offloadDecision,
        kvCacheType,
        slots,
        ggufHasMtp,
        installedDraftModelPath: modelCatalogInfo?.draftModelPath,
        // Opt-in A/B lever: `GEZEL_LLAMA_REASONING_FORMAT=none`
        // disables llama-server's chat-template output parsing so mangled
        // model output reaches `delta.content` for provider-side salvage.
        reasoningFormat: process.env.GEZEL_LLAMA_REASONING_FORMAT?.trim() || undefined,
        architecture: modelCatalogInfo?.architecture,
        modelId: defaultModelId ?? undefined,
        swaFullAutoFits,
      });
      return {
        command: binary,
        args: [
          '--model',
          modelPath,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          // --jinja: use the chat template embedded in the GGUF (or
          // an override via --chat-template). Without it, llama-server
          // falls back to a generic template that doesn't match most
          // modern models — the "silent fallback to Llama-2 format"
          // footgun we surfaced in Phase 0.
          '--jinja',
          // `--ctx-size` is the TOTAL KV cache, divided evenly across
          // `--parallel` slots — so a naive `--ctx-size N` with two
          // slots gives each turn N/2 tokens of working window. We
          // want `effectiveNumCtx` to mean "per-turn budget" (matches
          // what every doc + warning + pressure-check assumes), so
          // multiply by the slot count here. llama-server prints
          // `n_ctx_seq (X) < n_ctx_train (Y)` as a hint when the
          // per-slot value falls below the model's native max — pre-
          // fix, every multi-slot install was tripping that warning
          // and quietly running with half the context the user
          // configured. The session-level `numCtx` reported back to
          // ChatManager.checkContextPressure stays at the per-slot
          // value (it's the working window for one turn), so pressure
          // math doesn't double-count.
          '--ctx-size',
          String(effectiveNumCtx * slots),
          // --parallel matches the ProviderQueue's `concurrency` so the
          // engine has one KV slot per request lane. Without this,
          // llama-server stays at its default 1 slot and the 2nd
          // request just blocks server-side until the 1st finishes —
          // making our lane-aware queue useless.
          '--parallel',
          String(slots),
          // --slot-save-path enables per-slot KV state save/restore via
          // POST /slots/{id}?action={save|restore}. Without this flag
          // the endpoint returns 501 and the adapter's persistence
          // calls all silently fail. Files written here are read back
          // on supervisor restart / new session for the same gezel.
          '--slot-save-path',
          slotSavePath,
          // KV-cache quantization (`kvCacheType`, computed above). Default
          // q8_0 — ~50% memory savings with essentially zero quality
          // impact — EXCEPT the Gemma family, which defaults to f16
          // because q8_0 corrupts its KV cache (see the computation site).
          // Operators override either default via `config.llamaCppKvCacheType`.
          // Both K and V get the same type; asymmetric quant is rarely
          // worth the complexity.
          '--cache-type-k',
          kvCacheType,
          '--cache-type-v',
          kvCacheType,
          // Conditional flags — only pass when explicitly enabled
          // via config so we don't override per-backend defaults the
          // upstream maintainers picked deliberately.
          ...(config.llamaCppMlock ? ['--mlock'] : []),
          // Advanced engine-launch flags: flash-attn (tri-state, forced
          // `on` under quantized KV), `--ubatch-size`, GPU/MoE offload
          // (`--n-gpu-layers` / `--cpu-moe` / `--n-cpu-moe`),
          // `--cache-reuse` (auto-on prefix reuse), speculative decoding,
          // and the `llamaCppExtraArgs` escape hatch. Resolved from
          // global `config` ⊕ the model's manifest `tuning.engine.llamaCpp`.
          // Computed inside the closure so a settings change is picked up
          // on the next spawn.
          ...resolvedAdvancedArgs,
          // Multimodal projector sidecar. Present only when the catalog
          // source declared `mmproj`, the installer fetched it, AND the user
          // opted this model into native vision.
          //
          // The opt-in exists because loading a projector makes llama-server
          // return 501 on slot save/restore, which latches disk-KV prefix
          // caching off for the whole process (see cache-adapter's
          // `slotActionsUnsupported`). That costs cached session resume on
          // every text turn, image or not — so it has to be a choice, not a
          // side effect of installing a model that happens to ship one.
          ...(nativeVisionEnabled && modelCatalogInfo?.mmprojPath
            ? ['--mmproj', modelCatalogInfo.mmprojPath]
            : []),
          // Cap chain-of-thought length per the catalog's tuning.
          // Without this, llama-server runs `reasoning-budget=-1`
          // (Int32.MAX) and some models think themselves into silence.
          ...(reasoningBudgetTokens ? ['--reasoning-budget', String(reasoningBudgetTokens)] : []),
        ],
        diagnostics: {
          nativeRelease: effectiveEngineRelease(),
          model: modelCatalogInfo?.id ?? defaultModelId ?? 'manual-path',
          backend:
            llamaBuildMetadata?.backend ?? process.env.GEZEL_LLAMA_SERVER_BACKEND ?? 'unknown',
          upstreamRevision: llamaBuildMetadata?.revision ?? 'unknown',
          cudaArchitectures: llamaBuildMetadata?.cudaArchitectures?.join(';') ?? 'unknown',
          ...(llamaBuildMetadata?.cudaToolkit
            ? { cudaToolkit: llamaBuildMetadata.cudaToolkit }
            : {}),
          ...(llamaGpuDevice ? { gpu: llamaGpuDevice.name } : {}),
          ...(nvidiaRuntimeDevice
            ? {
                computeCapability: nvidiaRuntimeDevice.computeCapability,
                driverVersion: nvidiaRuntimeDevice.driverVersion,
              }
            : {}),
          contextPerSlot: effectiveNumCtx,
          contextTotal: effectiveNumCtx * slots,
          slots,
          kvCacheType,
          batchSize: lastArgValue(resolvedAdvancedArgs, '--batch-size') ?? 'default',
          ubatchSize: lastArgValue(resolvedAdvancedArgs, '--ubatch-size') ?? 'default',
          flashAttention: lastArgValue(resolvedAdvancedArgs, '--flash-attn') ?? 'default',
          cudaGraphs: process.env.GGML_CUDA_DISABLE_GRAPHS ? 'disabled-by-env' : 'default',
        },
        env: {
          PATH: inheritedPath ? `${binDir}${delimiter}${inheritedPath}` : binDir,
        },
        baseUrl: `http://127.0.0.1:${port}`,
      };
    },
  });

  const provider = new LlamaCppProvider({
    supervisor,
    logFile,
    slotSavePath,
    // Lets `listModels()` enumerate every installed model (not just
    // the resident one) so `/v1/models` + pickers see the full set
    // the engine pool can serve.
    ...(opts.llamaCppModels ? { modelManager: opts.llamaCppModels } : {}),
    ...(opts.arbiter ? { arbiter: opts.arbiter } : {}),
    // Pool replicas register their GPU evictor under their engine key
    // so concurrently-resident models don't clobber each other's
    // registration (and unregister cleanly on eviction). The singleton
    // path keeps the arbiter's 'default' owner.
    ...(opts.modelOverride
      ? {
          evictorOwnerId: makeEngineKey(
            'llama-cpp',
            opts.modelOverride.modelId,
            opts.modelOverride.replicaIdx,
          ),
        }
      : {}),
    ...baseProviderOpts,
    // The RAM-aware admission pass may have lowered the launch from the
    // configured/default ceiling. Keep the session-side pressure checks,
    // tool budgets, and user-facing diagnostics on the exact per-slot value
    // passed to llama-server instead of falling back to the pre-clamp 65K.
    numCtx: effectiveNumCtx,
    // Weights + KV at the granted window/cache mode — the broker-ledger
    // reservation the pool should hold for this replica (M1).
    ...(plannedReservationBytes !== undefined ? { plannedReservationBytes } : {}),
    // Same value that decides `--mmproj` above, so the wire shape and the
    // launch flag can never disagree: typed image parts are only emitted for
    // a server that was actually started with a projector.
    visionEnabled: nativeVisionEnabled,
    // Supervised slot count (RAM/KV-sized above) overrides the external
    // default; drives the queue, `--parallel`, and (via
    // `provider.queue.concurrency`) the cache adapter's slotCount.
    concurrency: slots,
    // Engine batch width — only the supervised path controls `--parallel`,
    // so co-batching is enabled here (not on the external-baseUrl path,
    // whose server may be single-slot). 1 = today's serial-ish behavior.
    batchMaxConcurrency,
    // Catalog id surfaced via `getEffectiveModelId()` so the chat
    // manager can recover a tier-classifiable model id when neither
    // `record.model` nor `config.defaultModel['llama-cpp']` was set —
    // without this the user's session uses an auto-picked model and
    // lands in `tier:tiny`. Falls back to `defaultModelId` when the
    // catalog lookup didn't fire (explicit `llamaCppModelPath` env
    // override). Mirrors the symmetric block in `buildMlxProvider`.
    ...(modelCatalogInfo
      ? { catalogModelId: modelCatalogInfo.id }
      : defaultModelId
        ? { catalogModelId: defaultModelId }
        : {}),
  });
  providerHolder.current = provider;
  return provider;
}
