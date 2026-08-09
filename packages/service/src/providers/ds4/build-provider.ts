import { basename, dirname, join } from 'node:path';
import { type GezelConfig, createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { gezelPaths } from '@bendyline/gezel/paths';
import { LlamaCppProvider, createLlamaCppPatientFetch } from '../llama-cpp/index.js';
import { minViableLocalContextTokens } from '../native/capacity-broker.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { Ds4Provider } from './provider.js';

const log = createLogger('chat');

/**
 * Resolve ds4's launch `--ctx` from the device tier and the model's catalog
 * cap.
 *
 * A high explicit `config.ds4NumCtx` wins. A lower value cannot push a
 * long-context model below Gezel's viability floor (64K, or 32K on a
 * memory-constrained host); a catalog model whose native launch cap is
 * genuinely smaller retains that smaller cap. Otherwise the RAM tier is an
 * upper bound that a model may lower but never raise — the tier is calibrated
 * on DeepSeek V4 Flash's ~4 GiB of resident non-routed weights, and a model
 * holding five times that much cannot afford the same KV allocation on the
 * same machine.
 */
export function resolveDs4LaunchCtx(opts: {
  configured?: number | undefined;
  ramTieredCtx: number;
  catalogMaxCtx?: number | undefined;
  minViableContextTokens?: number | undefined;
}): number {
  const floor =
    opts.minViableContextTokens && opts.minViableContextTokens > 0
      ? opts.minViableContextTokens
      : minViableLocalContextTokens();
  const resolved =
    opts.configured ??
    (opts.catalogMaxCtx ? Math.min(opts.ramTieredCtx, opts.catalogMaxCtx) : opts.ramTieredCtx);
  if (opts.catalogMaxCtx && opts.catalogMaxCtx < floor) {
    return opts.catalogMaxCtx;
  }
  return Math.max(floor, resolved);
}

/**
 * Build a ds4 (DwarfStar) provider. `ds4-server` is wire-compatible with
 * `llama-server` (OpenAI `/v1/chat/completions` SSE), so this returns a
 * {@link Ds4Provider} wrapping a {@link LlamaCppProvider} pointed at either an
 * external ds4-server (`config.ds4BaseUrl` / `GEZEL_DS4_SERVER_URL`) or a
 * supervised bundled `ds4-server` (`GEZEL_DS4_SERVER_BIN`).
 *
 * ds4 is not a general GGUF runner: it loads the specific DeepSeek-V4 and
 * GLM 5.2 quants its engine was built for, detecting the family at load time
 * from the GGUF's `general.architecture`. Models reach the supervised path
 * through the catalog's `ds4` source block, or an EXPLICIT GGUF via
 * `config.ds4ModelPath` / `GEZEL_DS4_MODEL`. GPU-only: `--metal` on darwin,
 * `--cuda` on linux (ds4's CPU path crashes the macOS kernel, so we never fall
 * back to it). Readiness probes `GET /v1/models` because ds4 has no `/health`
 * endpoint.
 */
export async function buildDs4Provider(opts: {
  config: GezelConfig;
  affinity: boolean | undefined;
  home: string;
  /** Prevent the idle supervisor from stopping DS4 between requests in an active tool loop. */
  isBusy?: () => boolean;
  /**
   * ds4 GGUF store (a `LlamaCppModelManager` with engine:'ds4'). When set, the
   * supervised path resolves the catalog modelId to an installed weights file
   * — so the model picker's "install" flow works without a manual path.
   */
  ds4Models?: import('../llama-cpp/index.js').LlamaCppModelManager;
  /** Catalog metadata drives the model-specific streaming cache and fit gate. */
  catalog?: CatalogService;
  modelOverride?: { modelId: string; replicaIdx: number };
  broker?: import('../native/capacity-broker.js').CapacityBroker;
}): Promise<Ds4Provider> {
  const { config, affinity, home } = opts;
  const defaultModelId = opts.modelOverride?.modelId ?? config.defaultModel?.ds4;
  // ds4 models support ~1M context and SSD-STREAM their KV cache to disk, so
  // the practical ceiling on a given box is RAM for the Metal context buffers
  // (~0.75 GiB at 24K, scaling with ctx) — which share RAM with the expert
  // cache. Scale ctx with device RAM, far above llama.cpp-class defaults to use
  // the engine's headline strength, but bounded so buffers + expert cache still
  // fit and the KV stays under ds4-server's ~4 GiB disk budget. A small window
  // throws away exactly what ds4 is for and overflows on large specialist
  // handoffs. (Full 1M needs a 128 GB+ box AND a raised ds4 --kv-disk-budget.)
  //
  // This tier assumes DeepSeek-V4's small resident footprint. A model whose
  // non-routed weights are much larger caps it further via the catalog's
  // `ds4.maxLaunchCtx`; see `resolveDs4LaunchCtx` below.
  const totalRamGb = (await import('node:os')).totalmem() / 1024 ** 3;
  const ramTieredCtx = totalRamGb >= 192 ? 262_144 : 131_072;
  const ds4ConstrainedToolNoSignalMs = (() => {
    const raw = process.env.GEZEL_DS4_CONSTRAINED_TOOL_NO_SIGNAL_MS;
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 600_000;
  })();
  const baseProviderOpts = {
    fetchImpl: createLlamaCppPatientFetch(),
    ...(defaultModelId ? { defaultModel: defaultModelId } : {}),
    ...(affinity !== undefined ? { affinity } : {}),
    // ds4-server emits per-turn token usage only when the request asks via
    // stream_options.include_usage — opt in so usage/tok-s telemetry works.
    includeUsageInStream: true,
    // ds4-server replays assistant turns as `<think>{reasoning_content}</think>`
    // and keeps per-call DSML by tool-call id. Echoing the captured reasoning
    // back keeps the re-rendered history byte-identical to what was generated,
    // so the engine's live-KV prefix survives each tool iteration and a
    // continuation prefills only the new tool results — instead of the
    // `live kv cache miss … reason=token-mismatch` full-tail re-prefill
    // (minutes per iteration at SSD-streamed prefill speeds). The env var is
    // a no-rebuild kill switch while the replay path is field-tuned.
    replayReasoningContent: process.env.GEZEL_DS4_NO_REASONING_REPLAY !== '1',
    // DS4 prefill can exceed three minutes even on compact tool prompts when
    // a continuation misses the live KV prefix and re-streams expert weights.
    // Keep the constrained mutation watchdog active, but give the engine a
    // model-appropriate prefill allowance. Override with
    // GEZEL_DS4_CONSTRAINED_TOOL_NO_SIGNAL_MS.
    constrainedToolNoSignalMs: ds4ConstrainedToolNoSignalMs,
    // ds4-server is a hard singleton backed by an unusually large SSD-streamed
    // model. Never overlap foreground and background generations: concurrent
    // expert reads can saturate the SSD and make the whole workstation
    // unresponsive even when the bounded resident cache itself fits.
    concurrency: 1,
    reserveBackgroundSlot: false,
  };

  // External ds4-server (dev iteration / LAN). Wins whenever set — a single
  // external server already holds the model, so model resolution is moot.
  // This is the path validated against a locally-run `ds4-server` while the
  // bundled-binary vendoring (M2) lands.
  const externalBaseUrl = process.env.GEZEL_DS4_SERVER_URL ?? config.ds4BaseUrl;
  if (externalBaseUrl) {
    return new Ds4Provider({
      inner: new LlamaCppProvider({
        baseUrl: externalBaseUrl,
        disableThinkingRequestShape: 'deepseek',
        // The external server owns its own `--ctx`; we only need a window to
        // reason about pressure with, so the catalog cap can't apply here.
        numCtx: config.ds4NumCtx ?? ramTieredCtx,
        ...baseProviderOpts,
      }),
    });
  }

  // Supervised: bundled ds4-server binary (set by the Electron supervisor /
  // eval harness once vendored).
  const binary = process.env.GEZEL_DS4_SERVER_BIN;
  if (!binary) {
    const err = new Error(
      'DwarfStar (ds4) engine: no ds4-server is available. Point Settings → DwarfStar (ds4) → External URL at a running ds4-server, or install a Gezel build that bundles ds4-server for this platform (Apple-Silicon Metal or Linux CUDA only).',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // Model path: explicit env/config wins; otherwise resolve the catalog
  // modelId through the ds4 GGUF store (installed via the model picker into
  // `engines/ds4/models`). Mirrors buildLlamaCppProvider's precedence.
  let modelPath = process.env.GEZEL_DS4_MODEL ?? config.ds4ModelPath;
  let installedModel: import('../llama-cpp/index.js').InstalledLlamaCppModel | null | undefined;
  if (!modelPath && opts.ds4Models) {
    if (defaultModelId) {
      installedModel = await opts.ds4Models.resolveModel(defaultModelId);
      if (installedModel) modelPath = installedModel.weightsPath;
    }
    if (!modelPath && !opts.modelOverride) {
      installedModel = await opts.ds4Models.resolveDefaultModel();
      if (installedModel) modelPath = installedModel.weightsPath;
    }
  }
  if (!modelPath) {
    const err = new Error(
      defaultModelId
        ? `DwarfStar (ds4) engine: model "${defaultModelId}" isn't available locally yet — download it from Settings → DwarfStar (ds4), or set config.ds4ModelPath / GEZEL_DS4_MODEL to a GGUF DwarfStar supports.`
        : 'DwarfStar (ds4) engine: no DwarfStar model is available locally — download one from Settings → DwarfStar (ds4), or set config.ds4ModelPath / GEZEL_DS4_MODEL. DwarfStar is not a general GGUF runner; it runs the specific DeepSeek-V4 and GLM 5.2 builds its engine supports.',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  // GPU backend: Metal on Apple Silicon, CUDA on Linux. ds4's CPU path
  // crashes the macOS kernel, so it is never selected on darwin.
  const backendFlag = process.platform === 'darwin' ? '--metal' : '--cuda';

  const effectiveModelId = defaultModelId ?? installedModel?.id;
  const catalogDetail = effectiveModelId
    ? await opts.catalog?.get('chat-model', effectiveModelId).catch(() => null)
    : null;
  const ds4Source =
    catalogDetail?.manifest.kind === 'chat-model' ? catalogDetail.manifest.ds4 : undefined;
  let modelSizeBytes = installedModel?.approxSizeBytes ?? ds4Source?.approxSizeBytes;
  if (!modelSizeBytes) {
    const { stat: statDs4Model } = await import('node:fs/promises');
    modelSizeBytes = await statDs4Model(modelPath)
      .then((st) => st.size)
      .catch(() => undefined);
  }

  const numCtx = resolveDs4LaunchCtx({
    configured: config.ds4NumCtx,
    ramTieredCtx,
    catalogMaxCtx: ds4Source?.maxLaunchCtx,
    minViableContextTokens: minViableLocalContextTokens(),
  });
  if (numCtx !== (config.ds4NumCtx ?? ramTieredCtx)) {
    log.info(
      `[ds4] ${effectiveModelId ?? basename(modelPath)} caps launch context at ${numCtx} ` +
        `(device tier would allow ${ramTieredCtx})`,
    );
  }

  // Streaming is the safe default. A stale/manual `false` is honored only
  // when this exact model plus runtime/OS headroom fits the unified-memory
  // machine. The old device-only 120 GiB threshold made a 153 GiB Q4 GGUF try
  // full residency on a 128 GiB Mac and could lock up the whole system.
  const { planDs4ExpertCache, shouldUseDs4SsdStreaming } = await import('./residency.js');
  const ssdStreaming = shouldUseDs4SsdStreaming({
    configured: config.ds4SsdStreaming,
    modelSizeBytes,
    totalRamBytes: totalRamGb * 1024 ** 3,
  });
  if (config.ds4SsdStreaming === false && ssdStreaming) {
    log.warn(
      `[ds4] ignored unsafe full-residency override for ${effectiveModelId ?? modelPath}; ` +
        `model=${modelSizeBytes ?? 'unknown'} bytes, system=${Math.round(totalRamGb)} GiB`,
    );
  }

  const cachePlan = planDs4ExpertCache({
    configuredGb: config.ds4CacheExpertsGb,
    catalogCacheBytes: ds4Source?.cacheExpertsBytes,
    catalogResidentBytes: ds4Source?.residentBytes,
    totalRamBytes: totalRamGb * 1024 ** 3,
  });
  if (ssdStreaming && !cachePlan.safe) {
    const err = new Error(
      `DwarfStar (ds4) engine: ${effectiveModelId ?? 'the selected model'} cannot keep a safe minimum expert cache while preserving memory for the operating system. Choose a lighter model in Settings → DwarfStar (ds4).`,
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }
  if (cachePlan.clamped) {
    log.warn(
      `[ds4] clamped expert cache ${cachePlan.requestedGb} → ${cachePlan.cacheGb} GiB to preserve system headroom`,
    );
  }
  const cacheExpertsGb = cachePlan.cacheGb;

  const kvDir = join(home, 'engines', 'ds4', 'kv');
  const { mkdir: mkdirDs4 } = await import('node:fs/promises');
  await mkdirDs4(kvDir, { recursive: true }).catch(() => {});

  // ds4-server compiles its Metal shaders from `./metal/*.metal` resolved
  // relative to its working directory (19 sources, each only overridable by a
  // separate env var — cwd is the clean lever). build.sh stages `metal/` next
  // to the binary, and the dev/external `GEZEL_DS4_SERVER_BIN` points at the
  // ds4 checkout which also has `metal/`, so cwd = the binary's directory.
  // Without this, startup aborts with "metal backend unavailable".
  const { dirname: ds4Dirname } = await import('node:path');
  const ds4BundleDir = process.env.GEZEL_DS4_CWD ?? ds4Dirname(binary);

  // Cold mmap of an 87GB GGUF + first-run Metal shader compile is minutes,
  // not seconds. Default 10 min; env-overridable for slow cold SSD reads.
  const startupTimeoutMs = (() => {
    const env = process.env.GEZEL_DS4_STARTUP_TIMEOUT_MS;
    if (env) {
      const n = Number.parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 600_000;
  })();
  const idleMs = config.localEngineIdleTimeoutMs ?? 30 * 60 * 1000;

  // Persist DS4 stdout/stderr independently from llama.cpp. Dev embedded mode
  // has no service-*.log capture, so without this file a force-quit erases the
  // only evidence of model loading, cache sizing, or a native-engine failure.
  const { LlamaCppLogFile: Ds4LogFile } = await import('../llama-cpp/log.js');
  const ds4LogFile = new Ds4LogFile(gezelPaths(home).logs, 'ds4-server');

  // Same holder pattern as buildLlamaCppProvider: the supervisor is
  // constructed before the provider, so onRawLine closes over a ref that's
  // filled in below. Routing stderr through onStdoutLine (with the ds4
  // classifier) is what turns ds4's prefill-chunk / decode / page-warming
  // lines into live engine_phase progress in the chat — without it a
  // multi-minute DS4 prefill is a silent spinner.
  const ds4ProviderHolder: { current: LlamaCppProvider | null } = { current: null };
  const { classifyDs4Line } = await import('./stdout-parser.js');

  let cachedDs4Port: number | undefined;
  const supervisor = new NativeEngineSupervisor({
    logPrefix: '[ds4-server]',
    startupTimeoutMs,
    idleTimeoutMs: idleMs,
    ...(opts.isBusy ? { isBusy: opts.isBusy } : {}),
    // ds4 exposes no /health — a 200 on /v1/models is the readiness signal.
    readinessPath: '/v1/models',
    onLog: (line) => {
      log.info(line);
      ds4LogFile.write(line);
    },
    onRawLine: (line) => ds4ProviderHolder.current?.onStdoutLine(line),
    resolveLaunch: async () => {
      const port = cachedDs4Port ?? (await pickFreePort());
      cachedDs4Port = port;
      const args = [
        '--model',
        modelPath,
        backendFlag,
        '--ctx',
        String(numCtx),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--kv-disk-dir',
        kvDir,
        // ds4-server's default disk budget is 4096 MiB — about 7 large
        // (40k-token ≈ 540 MiB) session chunks, which a busy multi-session
        // install churns through in minutes and the LRU then evicts the
        // very chunk a resumed session needs. Disk is the cheap resource
        // here; 16 GiB keeps ~30 large chunks live. Override with
        // GEZEL_DS4_KV_DISK_MB.
        '--kv-disk-space-mb',
        String(
          (() => {
            const raw = process.env.GEZEL_DS4_KV_DISK_MB;
            if (raw) {
              const parsed = Number.parseInt(raw, 10);
              if (Number.isFinite(parsed) && parsed > 0) return parsed;
            }
            return 16_384;
          })(),
        ),
        '--cors',
      ];
      if (ssdStreaming) {
        args.push('--ssd-streaming');
        if (cacheExpertsGb && cacheExpertsGb > 0) {
          args.push('--ssd-streaming-cache-experts', `${cacheExpertsGb}GB`);
        }
      }
      // Record the effective safety policy before spawn. ds4-server's own
      // stdout does not reliably echo its argv, and a hard lockup/force-quit
      // otherwise leaves no way to tell whether streaming was actually on.
      ds4LogFile.write(
        `[ds4-server] launch model=${effectiveModelId ?? basename(modelPath)} ` +
          `sizeGiB=${modelSizeBytes ? (modelSizeBytes / 1024 ** 3).toFixed(1) : 'unknown'} ` +
          `backend=${backendFlag.slice(2)} ctx=${numCtx} ` +
          `ssdStreaming=${ssdStreaming} cacheExpertsGiB=${ssdStreaming ? cacheExpertsGb : 0}`,
      );
      return { command: binary, args, baseUrl: `http://127.0.0.1:${port}`, cwd: ds4BundleDir };
    },
  });

  const ds4Inner = new LlamaCppProvider({
    supervisor,
    logFile: ds4LogFile,
    disableThinkingRequestShape: 'deepseek',
    classifyLine: classifyDs4Line,
    ...baseProviderOpts,
  });
  ds4ProviderHolder.current = ds4Inner;
  return new Ds4Provider({ inner: ds4Inner });
}
