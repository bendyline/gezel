import { join } from 'node:path';
import {
  DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
  type GezelConfig,
  createLogger,
} from '@bendyline/gezel';
import { gezelPaths } from '@bendyline/gezel/paths';
import type { Store } from '../../fs/store.js';
import type { MlxRuntimeStatusBus } from '../../python/mlx-runtime-status-bus.js';
import { noModelYetMessage } from '../active-install-message.js';
import { estimateExactPerSlotKvBytesF16 } from '../llama-cpp/offload-planner.js';
import {
  CapacityDeniedError,
  availableSystemRamBytes,
  formatContextCapacityDenial,
  minViableLocalContextTokens,
  resolveLocalContextRequirement,
} from '../native/capacity-broker.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { readMlxModelGeometry } from './model-geometry.js';
import { MlxProvider } from './provider.js';
import { templateOpensReasoning } from './reasoning-stream.js';
import { MLX_DEFAULT_PACKAGE_SPEC, MLX_VENV_NAME, mlxVenvPackages } from './venv.js';

const log = createLogger('chat');

/**
 * MLX does not receive a fixed-context launch flag: its KV cache grows with
 * the request up to the model architecture's native limit. Consequently the
 * catalog context window — not an arbitrary prefill-performance target — is
 * the correct denominator for overflow checks, compaction, tool-output caps,
 * and user-facing context warnings. An explicit operator limit still wins,
 * clamped to the model's native maximum. Manual model paths have no catalog
 * metadata, so they fall back to the host's context floor (64K, or 32K on a
 * memory-constrained machine).
 */
export function resolveMlxEffectiveNumCtx(opts: {
  modelContextWindow?: number;
  configuredLimit?: number;
  minViableContextTokens?: number;
}): number {
  return resolveLocalContextRequirement({
    modelContextWindow: opts.modelContextWindow,
    requestedContextWindow: opts.configuredLimit ?? opts.modelContextWindow,
    ...(opts.minViableContextTokens !== undefined
      ? { minViableContextTokens: opts.minViableContextTokens }
      : {}),
  }).requestedPerTurnCtxTokens;
}

/**
 * Construct an `MlxProvider` honoring env vars, config, and the
 * UvRuntime bootstrap. Resolution order for the wire target:
 *
 *   1. `GEZEL_MLX_SERVER_URL` / `config.mlxBaseUrl` — external wire mode,
 *      no subprocess. Mirrors llama-cpp's external-baseUrl branch.
 *   2. A supervised `mlx_lm.server` subprocess launched from the MLX
 *      venv UvRuntime manages. Requires:
 *        - Apple Silicon (darwin-arm64). Other platforms → actionable
 *          error pointing the user at llama-cpp.
 *        - A UvRuntime instance on `ChatManager` (see `ChatManagerOptions`).
 *        - An installed MLX model directory — via `mlxModels` catalog
 *          manager or `config.mlxModelPath` env/config override.
 *   3. Any of those missing → actionable error the Settings UI can
 *      surface with a clear "install a model / switch Python runtime"
 *      affordance.
 *
 * Unlike buildLlamaCppProvider, we must ensure the Python venv + mlx-lm
 * package are provisioned BEFORE the supervisor spawns — the child
 * launch command is the venv's `mlx_lm.server` console script. That's
 * an `await uvRuntime.ensureVenv(...)` on the cold path, which can
 * take minutes on first install. Subsequent boots are a no-op.
 */
export async function buildMlxProvider(opts: {
  config: GezelConfig;
  affinity: boolean | undefined;
  store: Store;
  mlxModels?: import('./index.js').MlxModelManager;
  uvRuntime?: import('../../python/uv-runtime.js').UvRuntime;
  mlxRuntimeStatus?: import('../../python/mlx-runtime-status-bus.js').MlxRuntimeStatusBus;
  /**
   * Pool-driven multi-engine routing. Same role as the same field on
   * {@link buildLlamaCppProvider} — caller wins over config defaults.
   */
  modelOverride?: { modelId: string; replicaIdx: number };
  /**
   * Capacity broker (multi-model pool path). When present, its committed-bytes
   * snapshot subtracts co-resident model reservations from the KV budget so the
   * slot ceiling + cache budget account for what else is already loaded. Absent
   * on the singleton path → full budget, committedOther = 0.
   */
  broker?: import('../native/capacity-broker.js').CapacityBroker;
  arbiter?: import('../gpu-arbiter.js').GpuArbiter;
}): Promise<MlxProvider> {
  const { config, affinity, store } = opts;
  const externalBaseUrl = opts.modelOverride
    ? undefined
    : (process.env.GEZEL_MLX_SERVER_URL ?? config.mlxBaseUrl);

  const defaultModelId = opts.modelOverride?.modelId ?? config.defaultModel?.mlx;
  const concurrency = config.providerConcurrency?.mlx;
  // Batched-inference sizing (mlxSlots / mlxBatchMaxConcurrency) and the
  // in-engine cache budget are computed below, AFTER the model size, effective
  // context window, and KV dtype resolve — a memory-aware slot ceiling needs
  // all three. Sizing concurrency here (pre-resolve) from a model-blind default
  // alone is what let a 27B model open a width-4 engine gate and abort Metal.
  // Per-model context override (Settings → Local models → Context size…)
  // wins over the machine-wide mlxNumCtx cap for the model being launched.
  const perModelCtxOverride = defaultModelId
    ? config.modelContextOverrides?.[`mlx:${defaultModelId}`]
    : undefined;
  const numCtx = perModelCtxOverride ?? config.mlxNumCtx;
  const baseProviderOpts = {
    ...(defaultModelId ? { defaultModel: defaultModelId } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(affinity !== undefined ? { affinity } : {}),
    ...(numCtx ? { numCtx } : {}),
  };

  if (externalBaseUrl) {
    return new MlxProvider({ baseUrl: externalBaseUrl, ...baseProviderOpts });
  }

  // ── Platform gate ──
  // MLX has no CPU / CUDA / Vulkan path — if we're not on darwin-arm64,
  // the model can't load even if mlx-lm is somehow installed.
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    const err = new Error(
      'MLX runs on Apple Silicon Macs only. Switch to llama in Settings → On-device (llama).',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  if (!opts.uvRuntime) {
    const err = new Error(
      'MLX provider: Python runtime not configured. Open Settings → On-device (MLX) and ensure Python or uv is available.',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // Model dir: explicit config/env wins; otherwise pick the first
  // catalog-installed MLX model. Pool-driven path (`modelOverride`
  // set) skips env/config override — caller already decided which
  // modelId to load — and refuses to fall back to a different
  // installed model if `resolveModel(modelId)` misses.
  const explicitPath = opts.modelOverride
    ? undefined
    : (process.env.GEZEL_MLX_MODEL ?? config.mlxModelPath);
  let modelDir = explicitPath;
  let modelCatalogInfo: import('./index.js').InstalledMlxModel | null = null;
  if (!modelDir && opts.mlxModels) {
    if (defaultModelId) {
      modelCatalogInfo = await opts.mlxModels.resolveModel(defaultModelId);
    }
    if (!modelCatalogInfo && !opts.modelOverride) {
      modelCatalogInfo = await opts.mlxModels.resolveDefaultModel();
    }
    if (modelCatalogInfo) modelDir = modelCatalogInfo.modelDir;
  }
  if (!modelDir) {
    // Distinguish "a specific model is selected but isn't installed" from
    // "nothing is downloaded at all". The former is a stale selection — a
    // model ID saved in config (or pinned on the session) that no longer
    // maps to an installed model, e.g. after the model was deleted or the
    // catalog ID changed. Naming the ID tells the user exactly which saved
    // selection to fix rather than implying nothing is downloaded.
    // See the llama.cpp twin: a first run downloads a multi-gigabyte model and
    // the user chats while waiting. Say what is happening rather than telling
    // them to start a download that is already running.
    const activeInstall = () =>
      opts.mlxModels?.getActiveInstalls().find((i) => i.phase !== undefined) ?? null;
    let message: string;
    if (defaultModelId && !modelCatalogInfo) {
      const installed = opts.mlxModels ? await opts.mlxModels.listInstalled() : [];
      message = installed.length
        ? `Apple MLX: the selected model "${defaultModelId}" is no longer available. ` +
          `Pick a local model in Settings → This Mac (${installed
            .map((m) => m.id)
            .join(', ')}), or download "${defaultModelId}" again.`
        : noModelYetMessage('Apple MLX', activeInstall());
    } else {
      message = noModelYetMessage('Apple MLX', activeInstall());
    }
    const err = new Error(message);
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // A per-model override below the host floor is deliberate user intent —
  // lower the floor to the override instead of silently raising the request
  // back to 64K. The machine-wide mlxNumCtx keeps its historical semantics.
  const mlxContextFloor =
    perModelCtxOverride !== undefined
      ? Math.min(minViableLocalContextTokens(), perModelCtxOverride)
      : minViableLocalContextTokens();
  let effectiveNumCtx = resolveMlxEffectiveNumCtx({
    ...(modelCatalogInfo?.contextWindow
      ? { modelContextWindow: modelCatalogInfo.contextWindow }
      : {}),
    ...(numCtx ? { configuredLimit: numCtx } : {}),
    minViableContextTokens: mlxContextFloor,
  });

  // Ensure the mlx venv + mlx-vlm package exist. We use `mlx-vlm`
  // (not `mlx-lm`) as the backend because our "This Mac" catalog is
  // anchored on Gemma 4 E-series, a vision-language-audio model
  // whose weights ship wrapped in a `language_model.*` / `vision_tower.*`
  // namespace. mlx_lm's text-only loader rejects that wrapper; mlx_vlm
  // handles it natively and also serves the same OpenAI-compatible
  // `/v1/chat/completions` endpoint for text-only chat. The venv spec
  // (name + package list, including the `torch`/`torchvision` pins) is
  // centralized in `mlx/venv.ts` so this lazy first-chat path and the
  // parallel warm fired at model-install time request an identical
  // list — `ensureVenv`'s fast-path keys on the package set, so any
  // drift would make this call reinstall instead of hitting the warmed
  // venv. `config.mlxPackageSpec` lets advanced users override the pin
  // in Settings → This Mac → Advanced.
  const mlxPackageSpec = config.mlxPackageSpec ?? MLX_DEFAULT_PACKAGE_SPEC;
  // Publish provisioning status so the UI pill can show "MLX warming
  // up" while uv resolves + installs torch / mlx-vlm wheels (1–5 min on
  // first install). On the common path the install-time warm has
  // already finished, so `ensureVenv` returns near-instantly via its
  // manifest fast-path; we still flip to 'provisioning' briefly so the
  // pill updates correctly if the venv was deleted out from under us.
  opts.mlxRuntimeStatus?.publish({
    phase: 'provisioning',
    message: `Installing ${mlxPackageSpec} + torch wheels (one-time, ~1–5 min)…`,
  });
  let venv: Awaited<ReturnType<typeof opts.uvRuntime.ensureVenv>>;
  try {
    venv = await opts.uvRuntime.ensureVenv({
      name: MLX_VENV_NAME,
      packages: mlxVenvPackages(config.mlxPackageSpec),
    });
  } catch (err) {
    opts.mlxRuntimeStatus?.publish({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  opts.mlxRuntimeStatus?.publish({
    phase: 'ready',
    message: `Python ${venv.pythonVersion ?? '?'} via ${venv.source}`,
  });

  // Persist a read-only snapshot of the resolved Python runtime so the
  // Settings UI can show it without re-probing.
  await store
    .writeConfig({
      pythonRuntime: {
        source: venv.source,
        ...(venv.pythonVersion ? { pythonVersion: venv.pythonVersion } : {}),
        ...(venv.uvVersion ? { uvVersion: venv.uvVersion } : {}),
        installerPath: venv.venvRoot,
        resolvedAt: new Date().toISOString(),
      },
    })
    .catch(() => {});

  // We spawn our own wrapped server (`gezel_mlx_server.py`, Phase 2)
  // instead of upstream `mlx_vlm.server`. The wrapper:
  //   - Owns the prompt-cache lifecycle (preserves cache across
  //     requests when a `cache_id` is supplied — upstream clears every
  //     stream's cache in its `finally`, forcing full re-prefill per
  //     turn).
  //   - Exposes `/v1/cache/{stats,evict,warm}` for the
  //     SessionCacheController to manage warm sessions.
  //   - Reuses mlx-vlm as a *library* (model loading, chat templating,
  //     PromptCacheState, stream_generate) — no reimplementation of
  //     anything that's stable upstream.
  // The Python file is copied alongside dist/ at build time (see
  // tsup.config.ts); `pythonServerPath` resolves it relative to this
  // bundle so dev and packaged modes both work without env wiring.
  //
  // The bundle layout is one of:
  //   - `dist/index.js`            → embedded import via package main
  //   - `dist/bin/gezeld.js`       → CLI/daemon entrypoint
  //   - `<root>/packages/service/src/chat/manager.ts` (raw-source, dev)
  // In all three the python file lands at `dist/providers/mlx/python/...`
  // (tsup's `publicDir` copies it once into the dist root). We walk up
  // from the current module's directory looking for the providers tree
  // so the resolution is bundle-shape-agnostic — without this, the
  // `dist/bin/` path fails because the loop would otherwise just take
  // `<distDir>/providers/...` and miss the up-one-level case.
  const { fileURLToPath } = await import('node:url');
  const { existsSync: existsSyncForPy } = await import('node:fs');
  const pythonServerPath = (() => {
    const here = fileURLToPath(import.meta.url);
    const startDir = here.replace(/[\\/][^\\/]+$/, '');
    // Try the current dir, then walk up to the dist root. Cap at 4
    // levels (dist/bin is the deepest case in practice; dev raw-source
    // would never look here anyway because evals always run from dist).
    let dir = startDir;
    for (let i = 0; i < 4; i++) {
      const candidate = join(dir, 'providers', 'mlx', 'python', 'gezel_mlx_server.py');
      if (existsSyncForPy(candidate)) return candidate;
      const parent = dir.replace(/[\\/][^\\/]+$/, '');
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      `gezel_mlx_server.py not found relative to ${startDir}. Build output may be corrupt — try \`pnpm --filter @bendyline/gezel-service build\` and verify dist/providers/mlx/python/gezel_mlx_server.py exists.`,
    );
  })();
  const venvPython = venv.binPath('python');

  // KV cache quantization. **Opt-in only.** Originally defaulted to 4 bits but
  // backed out after `RotatingKVCache Quantization NYI` crashed mid-prefill on
  // a session whose prompt approached the model's context limit. That class
  // now implements `to_quantized` upstream, and `maybe_quantize_kv_cache`
  // skips any layer still lacking it rather than raising — so the crash is
  // gone, but so is any signal that a layer went unquantized.
  //
  // Which is the whole difficulty: quantization lands on the SERIAL path only.
  // mlx-lm's BatchGenerator builds `BatchKVCache` layers, which have no
  // `to_quantized` and are silently skipped. Planning KV at q8 while the
  // engine runs f16 would under-reserve by ~45%, and an MLX overcommit is not
  // a soft failure — a Metal command-buffer OOM SIGABRTs the whole process.
  //
  // So the flags always go to the engine (a wave that collapses to serial
  // still gets the saving, which only ever over-reserves), while PLANNING
  // always prices KV at f16. Every slot the engine owns is a slot the
  // BatchGenerator may batch across, so there is no configuration in which the
  // q8 discount is safe to plan against — and under-reserving here is the
  // failure that SIGABRTs the whole python process.
  const kvBits = config.mlxKvBits ?? 0;
  const kvQuantArgs: string[] =
    kvBits > 0 ? ['--kv-bits', String(kvBits), '--kv-quant-scheme', 'uniform'] : [];

  // ── Memory-aware batch sizing ──
  // Size concurrent slots to what actually fits GPU memory, not just a tiered
  // default. This is the fix for the width-4-on-a-27B Metal abort: a Metal
  // command-buffer OOM aborts the WHOLE python process (SIGABRT — the "Python
  // quit unexpectedly" dialog), not just the offending request, so over-slotting
  // MLX is fatal in a way an over-slotted llama-server (which fails one slot)
  // is not. MLX runs KV in f16 by default, so the ceiling must NOT take a q8
  // discount. An explicit `providerConcurrency.mlx` still wins verbatim
  // (documented opt-in to the risk), mirroring llama-cpp's configuredSlots.
  const {
    computeCapacityBudget,
    defaultLocalEngineSlots,
    localEngineSlotCeiling,
    localEngineKvBudgetBytes,
    fastMemoryBudgetBytes,
  } = await import('../native/capacity-broker.js');
  const mlxWeightsBytes = modelCatalogInfo?.approxSizeBytes ?? 8 * 1024 ** 3;
  const mlxBrokerSnap = opts.broker?.committed();
  // Fast memory, not the admission budget — same reason as the llama path.
  // MLX only runs on unified-memory Macs today, where the two are equal.
  const mlxBudgetBytes = mlxBrokerSnap?.enforced
    ? (opts.broker?.fastBudgetBytes() ?? mlxBrokerSnap.pools.fastBytes)
    : fastMemoryBudgetBytes();
  const mlxCommittedOther = mlxBrokerSnap?.enforced ? mlxBrokerSnap.committedBytes : 0;
  // Always f16 — see the KV-quantization note above. The engine still gets
  // `--kv-bits` when the user set it; only PLANNING refuses the discount.
  const mlxKvCacheType = 'f16';
  const mlxKvBudgetBytes = localEngineKvBudgetBytes({
    engine: 'mlx',
    budgetBytes: mlxBudgetBytes,
    weightsBytes: mlxWeightsBytes,
    committedOtherBytes: mlxCommittedOther,
  });
  // Header-exact per-slot KV from the model dir's config.json (M4) —
  // before this, MLX memory math could only use the weights heuristic,
  // which under-prices small dense models ~3× and over-prices hybrids.
  const mlxGeometry = modelDir ? readMlxModelGeometry(modelDir) : undefined;
  // Read once per provider build: whether the chat template leaves a reasoning
  // block open, so a streamed turn starts mid-thought.
  const opensReasoning = modelDir ? templateOpensReasoning(modelDir) : false;
  const mlxExactPerSlotKvF16 = mlxGeometry
    ? estimateExactPerSlotKvBytesF16(mlxGeometry, effectiveNumCtx)
    : undefined;
  // No readable geometry means no honest KV price: the weights-scaled
  // heuristic under-prices a dense model's KV ~3x, and over-slotting MLX
  // SIGABRTs the whole process rather than failing one request. Stay serial
  // instead of guessing. (An inflated weights multiplier used to mask this
  // by accident; now that the weights figure is the measured one, the guard
  // has to be stated.) An explicit `providerConcurrency.mlx` still wins.
  const mlxSlotCeiling =
    mlxExactPerSlotKvF16 === undefined
      ? 1
      : localEngineSlotCeiling({
          engine: 'mlx',
          budgetBytes: mlxBudgetBytes,
          sizingBudgetBytes: mlxBrokerSnap?.enforced
            ? mlxBrokerSnap.pools.concurrencySizingBytes
            : computeCapacityBudget().concurrencySizingBytes,
          weightsBytes: mlxWeightsBytes,
          perTurnCtxTokens: effectiveNumCtx,
          kvCacheType: mlxKvCacheType,
          committedOtherBytes: mlxCommittedOther,
          exactPerSlotKvBytesF16: mlxExactPerSlotKvF16,
        });
  const mlxRequestedSlots = concurrency ?? defaultLocalEngineSlots(mlxBudgetBytes);
  let mlxSlots = concurrency ?? Math.min(mlxRequestedSlots, mlxSlotCeiling);
  if (mlxSlots < mlxRequestedSlots) {
    log.info(
      `[mlx] memory ceiling clamped concurrency ${mlxRequestedSlots} → ${mlxSlots} ` +
        `(model ~${Math.round(mlxWeightsBytes / 1024 ** 3)}GB weights, ctx ${effectiveNumCtx}, ` +
        `kv ${mlxKvCacheType}, ~${Math.round(mlxKvBudgetBytes / 1024 ** 3)}GB free for KV)`,
    );
  }
  // Memory-priced context admission (M4): MLX previously launched at the
  // model's NATIVE window with no admission at all — its lazily-growing
  // cache meant the OOM arrived mid-generation instead of at launch, and
  // the UI advertised a window memory could never back. Same ladder as
  // llama-cpp (deny below min(native, 64K) → shed slots → clamp), priced
  // with the config.json-exact KV when readable. MLX has no eval-env
  // bypass; an explicit `config.mlxNumCtx` still sets the REQUEST, not an
  // admission exemption.
  let mlxPlannedReservationBytes: number | undefined;
  if (mlxGeometry && mlxExactPerSlotKvF16 !== undefined) {
    const { CapacityBroker, kvQuantScale, planCtxTokensForMemory, resolveLocalContextRequirement } =
      await import('../native/capacity-broker.js');
    const requirement = resolveLocalContextRequirement({
      ...(modelCatalogInfo?.contextWindow
        ? { modelContextWindow: modelCatalogInfo.contextWindow }
        : {}),
      requestedContextWindow: effectiveNumCtx,
      minViableContextTokens: mlxContextFloor,
    });
    const kvBytesPerToken =
      (mlxExactPerSlotKvF16 / Math.max(1, effectiveNumCtx)) * kvQuantScale(mlxKvCacheType);
    const weightsResident = CapacityBroker.estimateResidentBytes('mlx', mlxWeightsBytes);
    const admission = planCtxTokensForMemory({
      requestedPerTurnCtxTokens: effectiveNumCtx,
      slots: mlxSlots,
      minimumPerTurnCtxTokens: requirement.minimumPerTurnCtxTokens,
      kvBytesPerToken,
      weightsResidentBytes: weightsResident,
      budgetBytes: mlxBrokerSnap?.enforced ? mlxBrokerSnap.budgetBytes : mlxBudgetBytes,
      committedOtherBytes: mlxCommittedOther,
      freeSystemRamBytes: availableSystemRamBytes(),
      vramBytes: 0,
    });
    if (!admission.minimumSatisfied) {
      throw new CapacityDeniedError(
        formatContextCapacityDenial({
          modelLabel: modelCatalogInfo?.name ?? defaultModelId ?? 'this MLX model',
          plan: admission,
        }),
      );
    }
    if (admission.slots < mlxSlots) {
      log.info(
        `[mlx] ${modelCatalogInfo?.id ?? 'model'}: reducing concurrency ${mlxSlots} -> ${admission.slots} to preserve at least ${requirement.minimumPerTurnCtxTokens} context tokens per turn`,
      );
      mlxSlots = admission.slots;
    }
    if (admission.clamped) {
      log.warn(`[mlx] ${modelCatalogInfo?.id ?? 'model'}: ${admission.reason}`);
      effectiveNumCtx = admission.perTurnCtxTokens;
    }
    mlxPlannedReservationBytes = Math.round(
      weightsResident + kvBytesPerToken * effectiveNumCtx * mlxSlots,
    );
  }
  // One width: the memory-ceiling-clamped slot count we reserved KV for is
  // exactly what `--max-concurrency` opens. `providerConcurrency.mlx = 1` is
  // the way to ask for a serial engine, and it shrinks the reservation too.
  const mlxBatchMaxConcurrency = mlxSlots;

  const providerHolder: { current: MlxProvider | null } = { current: null };

  // Persistent stdout/stderr trail from the wrapped python server.
  // Routes the supervisor's per-line output to disk at
  // `<logs>/mlx-server-YYYY-MM-DD.log` so the cache lines (`[cache]
  // miss/hit/saved`), prefill progress, and `[stream] client
  // disconnected` events survive past gezeld restarts. Without this,
  // the python child's prints land only on console.log and are
  // invisible to anyone diagnosing "why is prefill happening 3 times
  // in a row?". Mirrors the llama-cpp `logFile` wiring two functions
  // up.
  const { MlxLogFile } = await import('./log.js');
  const mlxLogFile = new MlxLogFile(gezelPaths(store.homePath).logs);

  let cachedPort: number | undefined;
  // In-engine cache budget. Operator override via
  // `config.cacheBudgetMb.mlx`; otherwise we read system RAM and pick
  // a tier (1/2/4/8 GB). This caps the wrapped server's in-process
  // prompt-cache; the controller-side LRU manages the same pool from
  // outside via `/v1/cache/{stats,evict}` polling. Both layers needed:
  // the in-engine bound is the safety net against OOM if the
  // controller's view drifts from engine reality between reconciles.
  const { totalmem } = await import('node:os');
  const ramAwareDefaultMb = (await import('../../cache/budget.js')).defaultCacheBudgetMb(
    totalmem(),
  );
  // Clamp the in-engine prompt-cache budget to the post-weights KV headroom
  // (the same number the slot ceiling uses). The RAM-tier default is model-blind
  // — an 8 GB cache budget behind a 28 GB model on a 64 GB box is ~4× the actual
  // headroom, and a fat resident cache of idle-session KV pushed the 27B session
  // over the Metal working set alongside the concurrent slots. The 256 MB floor
  // keeps ≥1 session cacheable (the server never evicts its last entry) so a
  // single-session user doesn't cold re-prefill every turn.
  const mlxKvHeadroomMb = Math.max(256, Math.floor(mlxKvBudgetBytes / (1024 * 1024)));
  const cacheBudgetMb = Math.min(config.cacheBudgetMb?.mlx ?? ramAwareDefaultMb, mlxKvHeadroomMb);

  // ── Disk-persisted prompt cache ──
  // The wrapped server writes evicted entries (and warmed prefixes) to
  // `<home>/engines/mlx/cache/<fingerprint>/<cache_id>.safetensors`.
  // On miss, the server tries disk before falling back to fresh
  // prefill. Fingerprint segmentation prevents wrong-shape KV state
  // from loading into a different model — change the model and the
  // path changes, the disk-LRU eventually prunes the orphaned tree.
  //
  // The fingerprint is a cheap stable hash of fields that change only
  // on (re-)install: catalog id, catalog version, install timestamp,
  // resolved model directory. Reinstalling the same model with no
  // catalog bump produces the same fingerprint — caches survive minor
  // catalog republishes that don't change weights. A catalog version
  // bump or a switch to a different model path produces a different
  // fingerprint, so old caches are never accidentally loaded against
  // new weights.
  // Replica isolation: replica 0 keeps the canonical cache root; 1+
  // get a `replica-N` sibling subdir so concurrent MLX wrappers
  // don't collide on each other's disk-cache writes. The python
  // wrapper hashes (model-fingerprint, cache_id) into the on-disk
  // filename, so a different `--persist-dir` per replica is
  // sufficient isolation.
  const mlxReplicaSuffix =
    opts.modelOverride && opts.modelOverride.replicaIdx > 0
      ? `replica-${opts.modelOverride.replicaIdx}`
      : '';
  const cacheRoot = mlxReplicaSuffix
    ? join(store.homePath, 'engines', 'mlx', 'cache', mlxReplicaSuffix)
    : join(store.homePath, 'engines', 'mlx', 'cache');
  const { createHash } = await import('node:crypto');
  const fingerprintInput = [
    modelCatalogInfo?.id ?? defaultModelId ?? modelDir,
    modelCatalogInfo?.catalogVersion ?? '',
    modelCatalogInfo?.installedAt ?? '',
    modelDir,
  ].join('::');
  const modelFingerprint = createHash('sha256')
    .update(fingerprintInput, 'utf8')
    .digest('hex')
    .slice(0, 24);
  const diskCacheBudgetMb = config.mlxDiskCacheBudgetMb ?? 8192;

  // Two-stage idle (Phase 2.5): freeze at half the default idle
  // budget, SIGTERM at the full budget. Freeze flushes warm cache
  // entries to disk via /admin/flush while the model is still
  // resident, so the SIGKILL window between Stage 1 and Stage 2
  // can't lose them. MLX cold-start is ~1–3 min so the staged
  // approach is especially valuable here vs llama.cpp.
  const mlxIdleMs = config.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS;
  const mlxFreezeMs = Math.floor(mlxIdleMs / 2);
  // Python+MLX cold-start (PyTorch imports, MLX metal shaders JIT) is
  // slower than llama.cpp's Metal compile. 300s headroom covers the
  // first-ever launch on a cold machine; warm launches are seconds. But a
  // truly cold machine also has to BUILD the mlx-vlm/torch venv on the
  // first turn (uv installs ~70 packages, ~10 min) before the engine even
  // spawns — which blows past 300s and times the first turn out. Honor
  // `GEZEL_MLX_STARTUP_TIMEOUT_MS` (mirrors `GEZEL_LLAMA_STARTUP_TIMEOUT_MS`)
  // so a cold first MLX turn can wait out the venv build without recompiling.
  const mlxStartupTimeoutMs = (() => {
    const env = process.env.GEZEL_MLX_STARTUP_TIMEOUT_MS;
    if (env) {
      const n = Number.parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 300_000;
  })();
  const supervisor = new NativeEngineSupervisor({
    logPrefix: '[mlx]',
    startupTimeoutMs: mlxStartupTimeoutMs,
    idleTimeoutMs: mlxIdleMs,
    freezeTimeoutMs: mlxFreezeMs,
    isBusy: () => providerHolder.current?.isEngineBusy() ?? false,
    ...(opts.arbiter ? { memoryPressure: () => opts.arbiter!.getMemoryPressureStatus() } : {}),
    onFreeze: async () => {
      await providerHolder.current?.getCacheAdapter()?.flushAll();
    },
    onLog: (line) => {
      log.info(line);
      mlxLogFile.write(line);
    },
    onRawLine: (line) => providerHolder.current?.onStdoutLine(line),
    resolveLaunch: async () => {
      const port = cachedPort ?? (await pickFreePort());
      cachedPort = port;
      return {
        // Spawn the wrapper via the venv's python so all mlx-vlm
        // imports resolve. The .py file path is bundle-relative — see
        // pythonServerPath derivation above. `--cache-budget-mb` caps
        // the in-engine cache size; the Phase-3 controller manages
        // policy from outside via `/v1/cache/{stats,evict}`.
        command: venvPython,
        args: [
          pythonServerPath,
          '--model',
          modelDir,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--cache-budget-mb',
          String(cacheBudgetMb),
          '--persist-dir',
          cacheRoot,
          '--model-fingerprint',
          modelFingerprint,
          '--disk-cache-budget-mb',
          String(diskCacheBudgetMb),
          // Tunable prefill chunk size — only forwarded when the
          // operator overrides; otherwise the python wrapper's own
          // default (2048) lands.
          ...(config.mlxPrefillStepSize
            ? ['--prefill-step-size', String(config.mlxPrefillStepSize)]
            : []),
          // BatchGenerator width. Every positive value uses the snapshot-safe
          // path; 1 is a singleton wave, N>1 batches co-arriving sequences.
          // Only an explicit 0 selects the legacy serial fallback.
          '--max-concurrency',
          String(mlxBatchMaxConcurrency),
          // This engine's unified-memory SHARE (weights + KV + compute): the
          // budget minus what co-resident models already hold. Each engine is a
          // separate process, so the in-engine admission guard must gate on this
          // process's share, not the whole-device budget, or two engines
          // collectively overshoot. The server further caps at Metal's
          // recommended working set (whichever is tighter). Singleton path:
          // committedOther = 0 → full budget.
          // Opt-in structured tool-call streaming (GEZEL_MLX_STREAM_TOOL_CALLS=1).
          // Off by default: without a matching mlx_vlm tool parser the server
          // falls back to streaming markup as content, which is the path the
          // gezel-side salvage layer has always handled. On, the client gets a
          // real call boundary and can end a turn once the write is usable.
          ...(process.env.GEZEL_MLX_STREAM_TOOL_CALLS === '1' ? ['--stream-tool-calls'] : []),
          '--gpu-memory-limit-mb',
          String(Math.max(0, Math.floor((mlxBudgetBytes - mlxCommittedOther) / (1024 * 1024)))),
          // What this engine may PIN, as distinct from what it may use. Wiring
          // is not reclaimable by the OS, so the ceiling above is the wrong
          // number to pass Metal: a 27B on a 128 GB Mac wired its whole 96 GiB
          // share, held ~103 GB against a ~45 GB working set, and drove the
          // machine to 155 MB free. The planned resident set (weights + the
          // KV its slots will actually hold) is what steady-state inference
          // needs kept out of the pager. Omitted when geometry was unreadable
          // — the server then leaves the wired limit alone rather than guessing.
          ...(mlxPlannedReservationBytes !== undefined
            ? [
                '--wired-limit-mb',
                String(Math.max(1, Math.floor(mlxPlannedReservationBytes / (1024 * 1024)))),
              ]
            : []),
          ...kvQuantArgs,
        ],
        env: {
          // Force the engine to operate purely off-disk. We've already
          // downloaded every file MlxModelManager declared via the
          // catalog manifest, and any "needed file is missing" should
          // raise a clean FileNotFoundError naming the file — NOT
          // silently fall back to fetching `https://huggingface.co/<gibberish>`
          // and leaving the user staring at a 401. The huggingface_hub
          // and transformers offline switches together cover every
          // auto-fetch path inside mlx_vlm.server.
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          TRANSFORMERS_NO_ADVISORY_WARNINGS: '1',
        },
        baseUrl: `http://127.0.0.1:${port}`,
      };
    },
  });

  const provider = new MlxProvider({
    supervisor,
    ...baseProviderOpts,
    // Weights + KV at the admitted window — the broker-ledger reservation
    // the pool should hold for this replica (M1).
    ...(mlxPlannedReservationBytes !== undefined
      ? { plannedReservationBytes: mlxPlannedReservationBytes }
      : {}),
    // Engine batch width — matches the server's `--max-concurrency`. Widens
    // the provider's queue + engine gate to N (1 = singleton BatchGenerator).
    // Supervised path only; external-baseUrl MLX stays at one in-flight
    // request because we don't control that server's width.
    batchMaxConcurrency: mlxBatchMaxConcurrency,
    // mlx_vlm.server's `/v1/chat/completions` keys its in-memory cache
    // on `request.model` and reloads when it doesn't match what was
    // preloaded via `--model` (`PRELOAD_MODEL` env). The reload path
    // calls `huggingface_hub.snapshot_download(<request.model>)` —
    // which fails offline with a `LocalEntryNotFoundError` ("Cannot
    // find an appropriate cached snapshot folder…") when the request
    // value is a catalog id like `gemma4-e4b-mlx` rather than the
    // on-disk path. Sending the absolute model dir keeps the cache
    // warm and avoids the offline-fetch attempt entirely.
    defaultModel: modelDir,
    numCtx: effectiveNumCtx,
    ...(opensReasoning ? { templateOpensReasoning: true } : {}),
    ...(opts.mlxModels ? { modelManager: opts.mlxModels } : {}),
    ...(modelCatalogInfo ? { modelDisplayName: modelCatalogInfo.name } : {}),
    // Catalog id, distinct from `defaultModel` (the on-disk path).
    // Surfaced via `getEffectiveModelId()` so the chat manager can
    // recover a tier-classifiable model id when neither `record.model`
    // nor `config.defaultModel.mlx` was set — without this the user's
    // session uses an auto-picked model and lands in `tier:tiny`.
    // Falls back to `defaultModelId` (config-resolved id) when the
    // catalog lookup didn't fire (explicit `mlxModelPath` env override).
    ...(modelCatalogInfo
      ? { catalogModelId: modelCatalogInfo.id }
      : defaultModelId
        ? { catalogModelId: defaultModelId }
        : {}),
  });
  providerHolder.current = provider;
  return provider;
}
