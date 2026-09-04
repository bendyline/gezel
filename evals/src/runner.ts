import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { GezelConfig, SessionTelemetryListResponse } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { startAutoAnswerer } from './auto-answer.ts';
import { type EngineContextRecord, extractEngineContext } from './engine-context.ts';
import {
  classifyTrial,
  describePreProviderStall,
  readDaemonLogTailSync,
  summarizeNativeEngineIncidents,
} from './failure-class.ts';
import { evalFetchUrlMockOriginEnv } from './fetch-url-mock-origins.ts';
import { attachableDeliverable, describeSendFailure } from './handoff.ts';
import { summarizeKeurmeesterCases } from './keurmeester-metrics.ts';
import { TrialLogger } from './logging.ts';
import { startMockServices } from './mock/mock-server.ts';
import {
  assertMlxSourceComplete,
  defaultCacheRoot,
  ensureWarmModel,
  isModelInstalled,
  linkDrafterIntoTrial,
  linkModelIntoTrial,
  staleInstallReason,
} from './model-cache.ts';
import { loadModelEvalHints } from './model-eval-hints.ts';
import { classifyEvalModelTier, modelBillionsForEval } from './model-tier.ts';
import type { ResolvedBinary } from './native-bin.ts';
import { repoRoot, resolveDs4Binary, resolveLlamaBinary, resolveSdBinary } from './native-bin.ts';
import {
  PerfCollector,
  type TrialMetrics,
  captureHostInfo,
  writeHostInfo,
  writeMetrics,
} from './perf-collector.ts';
import { captureFingerprint, digestFingerprint } from './progress-fingerprint.ts';
import {
  type ChatProvider,
  buildProviderConfig,
  categorizeProvider,
  isLocalEngine,
  isSelfOrchestratingProvider,
  probeProviderAuth,
} from './providers.ts';
import { captureRecordingState, writeRecordingManifest } from './recording/capture.ts';
import { distillRunDir } from './recording/distill-io.ts';
import {
  type ChatEventRecorderHandle,
  type ChatEventRecorderStats,
  startChatEventRecorder,
} from './recording/recorder.ts';
import { captureRecordingScreenshots } from './recording/screenshots.ts';
import { resolveEvalRunsDir } from './run-paths.ts';
import {
  HARNESS_INTERVENTION_SETTLE_MS,
  lastDeliveredHarnessIntervention,
  lastDeliveredSniffNudge,
  noteHarnessInterventionDelivered,
} from './sniff-feedback.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from './spawn.ts';
import { bareToolName } from './tool-names.ts';
import { writeTrialFacts } from './trial-facts.ts';
import type {
  EvalRepairActionSnapshot,
  EvalScenario,
  EvalTerminalFailure,
  FailureMode,
  SuccessCheckResult,
  TrialFinalSniff,
  TrialOptions,
  TrialResult,
  TrialStatus,
} from './types.ts';

export {
  attachableDeliverable,
  describeSendFailure,
  isCoordinationOnlyRole,
} from './handoff.ts';

/**
 * Tools whose successful call means the model actually changed something.
 *
 * Matched through `bareToolName`, so every spelling of the same capability
 * lands here: the plain gezel-mcp name a local engine emits, the
 * `mcp__gezel__` namespacing CLI providers apply, and the CLI providers'
 * own built-in editors. Legacy camelCase spellings are kept for scoring
 * pre-rename run dirs.
 *
 * Bare-name-only matching made this counter read ZERO for the whole of
 * every anthropic-cli trial, which is the second arm of
 * `advanceEscalationState`: with the failure text frozen too, the
 * escalation ladder could never leave attempt 1, so the harness delivered
 * exactly ONE repair message and then sat silent until the retry-loop
 * killed the trial — reporting "(retry-loop nudge was sent and ignored)"
 * for a ladder that never escalated. Wild-caught on
 * craftbook-author-fanout x claude-sonnet-4-6: one nudge at 19:28:06,
 * 17 minutes of real work (9 `mcp__gezel__append_to_file`, 5 `Write`),
 * no second message, killed at 19:45:22.
 */
const COMPLETED_REPAIR_MUTATION_TOOLS = new Set([
  'write_file',
  'write_artifact',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'append_to_file',
  'insert_at_marker',
  'copy_artifact_to_workspace',
  'writefile',
  'replaceinfile',
  'replacelines',
  'applypatch',
  'appendtofile',
  'insertatmarker',
  // CLI providers' built-in editors — Claude has no gezel-mcp `write_file`.
  'write',
  'edit',
  'multiedit',
  'notebookedit',
]);

/**
 * Count committed assistant turns that completed at least one successful
 * file mutation. A turn is the unit (rather than each tool call) because one
 * repair response may try a failed surgical edit and then land a successful
 * rewrite; that is one model attempt, not two. In-flight calls are absent
 * from `session.messages` until the turn commits, which makes this safe as a
 * bounded-repair action token.
 */
export function completedRepairActionSnapshot(
  session: {
    messages: Array<{
      role: 'user' | 'assistant';
      toolCalls?: Array<{ name: string; success: boolean }>;
    }>;
  },
  inflight = false,
): EvalRepairActionSnapshot {
  return {
    completedMutationTurns: session.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some(
          (call) => call.success && COMPLETED_REPAIR_MUTATION_TOOLS.has(bareToolName(call.name)),
        ),
    ).length,
    inflight,
  };
}

/**
 * Eval-only switch for clean speculative-decoding A/Bs. Keeping the lever in
 * config (rather than mutating catalog manifests between arms) guarantees the
 * model weights, prompts, behaviors, and scenario stay fixed.
 */
/**
 * `GEZEL_EVAL_LLAMA_KV_CACHE` — per-arm KV-cache precision override for
 * A/Bs (`f16` | `q8_0` | `q4_0`), written into the trial config as
 * `llamaCppKvCacheType` (the same operator override the product honors,
 * so it beats the family default in kv-cache-type.ts). Exists to re-test
 * the wild-caught "gemma + q8_0 KV garbles recalled prompt text"
 * incident against current engine builds — same shape as the spec-type
 * override below.
 */
function evalLlamaKvCacheOverride(): GezelConfig['llamaCppKvCacheType'] | undefined {
  const raw = process.env.GEZEL_EVAL_LLAMA_KV_CACHE?.trim();
  if (!raw) return undefined;
  const allowed = new Set<NonNullable<GezelConfig['llamaCppKvCacheType']>>(['f16', 'q8_0', 'q4_0']);
  if (!allowed.has(raw as NonNullable<GezelConfig['llamaCppKvCacheType']>)) {
    throw new Error(
      `invalid GEZEL_EVAL_LLAMA_KV_CACHE="${raw}" (expected ${[...allowed].join(', ')})`,
    );
  }
  return raw as GezelConfig['llamaCppKvCacheType'];
}

function evalLlamaSpecTypeOverride(): GezelConfig['llamaCppSpecType'] | undefined {
  const raw = process.env.GEZEL_EVAL_LLAMA_SPEC_TYPE?.trim();
  if (!raw) return undefined;
  const allowed = new Set<NonNullable<GezelConfig['llamaCppSpecType']>>([
    'none',
    'draft-mtp',
    'draft-eagle3',
    'draft-dflash',
    'draft-simple',
    'ngram-mod',
    'ngram-simple',
    'ngram-map-k',
    'ngram-map-k4v',
    'ngram-cache',
  ]);
  if (!allowed.has(raw as NonNullable<GezelConfig['llamaCppSpecType']>)) {
    throw new Error(
      `invalid GEZEL_EVAL_LLAMA_SPEC_TYPE="${raw}" (expected ${[...allowed].join(', ')})`,
    );
  }
  return raw as NonNullable<GezelConfig['llamaCppSpecType']>;
}

/**
 * For `engine: 'mlx'` trials: where to look for an existing model dir
 * to symlink into the trial home. Defaults to `~/.gezel-dev` (the home
 * `pnpm app` writes to in dev mode), where Mac users running the app
 * already have their MLX weights at `engines/mlx/models/<modelId>/`.
 */
function defaultMlxSourceHome(): string {
  return join(homedir(), '.gezel-dev');
}

/**
 * Symlink the uv venv tree from the source home into the trial home so
 * the trial daemon's `UvRuntime.ensureVenv` short-circuits instead of
 * spending many minutes installing mlx-lm + transformers + torch from
 * scratch on every trial. Best-effort: missing source tree is OK (the
 * daemon will just install fresh — slower but functionally correct).
 *
 * We symlink the whole `engines/uv` subtree (containing `venvs/mlx/`)
 * rather than copying — copying a 3-4 GB venv would defeat the speed
 * win we're after.
 */
async function linkUvTreeIntoTrial(opts: {
  mlxSourceHome: string;
  trialHome: string;
  log: (line: string) => void;
}): Promise<void> {
  const sourceUv = join(opts.mlxSourceHome, 'engines', 'uv');
  if (!existsSync(sourceUv)) {
    opts.log(
      `[trial] uv venv tree not present at ${sourceUv} — trial daemon will provision a fresh venv (slow)`,
    );
    return;
  }
  const trialUv = join(opts.trialHome, 'engines', 'uv');
  if (existsSync(trialUv)) return; // already linked / created
  const { mkdir, symlink } = await import('node:fs/promises');
  await mkdir(join(opts.trialHome, 'engines'), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(sourceUv, trialUv, type);
  opts.log(`[trial] linked uv venv tree from ${sourceUv} into ${trialUv}`);
}

/**
 * Build the slug used both as the trial id and the on-disk run-dir
 * name. Shape: `<scenario>-<provider>-<modelSlug>-<ts>-<rand>`.
 *
 * Encoding the provider + model in the dir name makes multi-model
 * sweeps inspectable at a glance: `ls evals/runs/ | grep gpt-5.5`
 * picks out one slice of the matrix without having to grep every
 * `result.json`. The `<ts>` segment still keeps the slug unique for
 * back-to-back trials of the same `(scenario, provider, model)`.
 *
 * The provider segment is omitted only for `llama-cpp` — the
 * historical default — so existing run dirs and ad-hoc scripts that
 * grep `tictactoe-2026-...` keep matching when nothing was changed.
 */
export function makeTrialId(scenarioId: string, provider: ChatProvider, modelId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const modelSlug = slugifyForDirName(modelId);
  const providerSegment = provider === 'llama-cpp' ? '' : `-${provider}`;
  return `${scenarioId}${providerSegment}-${modelSlug}-${ts}-${rand}`;
}

/**
 * Make a model id safe for inclusion in a directory name. Model ids
 * carry filesystem-hostile characters in practice: dots in version
 * tags (`gpt-5.5`), slashes in HF-style ids (`org/repo`), occasional
 * spaces. We lowercase + replace any non-`[a-z0-9_-]` run with a
 * single `-`, then trim leading/trailing `-`.
 *
 * Capped at 40 chars to stay well clear of the 260-char Windows
 * `MAX_PATH` ceiling once joined with `evals/runs/...` plus the
 * timestamp tail. Long ids get truncated; the suffix random + ts
 * still guarantees uniqueness.
 */
export function slugifyForDirName(modelId: string): string {
  const cleaned = modelId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return 'unknown';
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

/**
 * Conservative native-device preset for unattended evals. It is intentionally
 * separate from model tuning: one slot and a smaller llama.cpp ubatch reduce
 * allocation/kernel pressure, while the shared device-health gate owns thermal
 * admission. `GEZEL_EVAL_DEVICE_SAFETY=off|observe|guard` is the operator
 * escape hatch; new local eval invocations default to guard.
 */
export function localEvalDeviceSafetyConfig(
  engine: ChatProvider,
  env: NodeJS.ProcessEnv = process.env,
): Partial<GezelConfig> {
  if (!isLocalEngine(engine)) return {};
  const rawMode = env.GEZEL_EVAL_DEVICE_SAFETY?.trim().toLowerCase();
  const mode =
    rawMode === 'off' || rawMode === 'observe' || rawMode === 'guard' ? rawMode : 'guard';
  const telemetryFailure = env.GEZEL_EVAL_DEVICE_SAFETY_TELEMETRY_FAILURE?.trim().toLowerCase();
  const onTelemetryFailure = telemetryFailure === 'block' ? 'block' : 'allow';
  return {
    deviceSafety: { mode, onTelemetryFailure },
    ...(mode === 'guard'
      ? {
          providerConcurrency: { [engine]: 1 },
          ...(engine === 'llama-cpp' ? { llamaCppUbatchSize: 512 } : {}),
        }
      : {}),
  };
}

/** Classify warm-up failures without leaving operator interrupts as infrastructure crashes. */
export function modelWarmFailure(
  error: unknown,
  signal?: AbortSignal,
): { reason: string; failureMode: 'interrupted' | 'spawn-error' } {
  if (signal?.aborted) {
    return {
      reason: 'interrupted (SIGINT/SIGTERM); cleanup ran',
      failureMode: 'interrupted',
    };
  }
  return {
    reason: `model warm failed: ${error instanceof Error ? error.message : String(error)}`,
    failureMode: 'spawn-error',
  };
}

/**
 * Run a single eval trial end-to-end. Always returns a `TrialResult` —
 * even on spawn errors, timeouts, or scenario failures — and always
 * leaves the run directory populated for postmortem.
 */
export async function runTrial(scenario: EvalScenario, opts: TrialOptions): Promise<TrialResult> {
  const engine = opts.engine ?? 'llama-cpp';
  const evalLlamaSpecType = evalLlamaSpecTypeOverride();
  const evalLlamaKvCache = evalLlamaKvCacheOverride();
  // Capability tier of the model under test (Theme E / E1-B) — stamped
  // onto every finalize so reporting can render tiny-tier cells as counts.
  const modelTier = classifyEvalModelTier({ engine, modelId: opts.modelId });
  // Local-engine eval launch overrides (env + config + timeouts). Shared shape
  // across llama-cpp and ds4 (both supervised GGUF engines), so it flows
  // through the same `evalDaemonEnvForTrial` + `updateConfig` path below.
  const defaultLlamaEvalLaunch =
    engine === 'llama-cpp'
      ? llamaCppEvalLaunchOverridesForModel(opts.modelId)
      : engine === 'ds4'
        ? ds4EvalLaunchOverridesForModel(opts.modelId)
        : undefined;
  const llamaEvalLaunch = mergeLlamaCppEvalLaunchOverrides(
    defaultLlamaEvalLaunch,
    llamaCppReasoningEvalLaunchOverrides(opts, engine),
  );
  const reasoningEffortConfig = llamaCppReasoningEffortEvalConfig(opts, engine);
  const trialId = makeTrialId(scenario.id, engine, opts.modelId);
  const runsDir = resolveEvalRunsDir(opts.runsDir);
  const runDir = join(runsDir, trialId);
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  // Progress-driven completion: the no-progress window is the primary
  // kill mechanism, the hard ceiling is the runaway safety net. See
  // `pollUntilDone` for the long-form rationale on why we moved away
  // from fixed-time per-trial budgets. `opts.timeoutMs` is treated as
  // a `maxDurationMs` override for back-compat with existing callers.
  // An explicit `opts.timeoutMs` is an operator override and stands as
  // given; only the scenario-authored ceiling gets throughput-scaled, since
  // that value was calibrated against a ~20 tok/s reference machine and
  // otherwise makes the verdict a property of the hardware.
  const authoredMaxDurationMs = scenario.timeoutMs ?? DEFAULT_MAX_DURATION_MS;
  const requestedMaxDurationMs =
    opts.timeoutMs ??
    throughputScaledMaxDurationMs({
      authoredMaxDurationMs,
      decodeRateTokensPerSec: opts.decodeRateTokensPerSec,
    });
  const maxDurationMs = Math.max(requestedMaxDurationMs, llamaEvalLaunch?.minTrialTimeoutMs ?? 0);
  // `scenario.progressTimeoutMs`, when set, acts as the HARD timeout
  // override (real-progress watchdog). Soft timeout stays at the
  // default unless we add a separate override later.
  const hardProgressTimeoutMs = Math.max(
    scenario.progressTimeoutMs ?? DEFAULT_HARD_PROGRESS_TIMEOUT_MS,
    llamaEvalLaunch?.hardProgressTimeoutMs ?? 0,
  );
  // Soft progress watchdog: fires when the daemon shows no activity
  // across our fingerprint signals (turns, tools, slot updates, stream
  // pulses) for this long. Default 5 min covers normal "model thinking
  // hard" stalls; `defaultSoftProgressTimeoutMsForModel` lifts it for very
  // large models, doubles it for MLX (slower Apple-Silicon decode), and
  // lifts it generously for self-orchestrating providers (codex-cli /
  // anthropic-cli / copilot) whose coarse turn cadence makes legitimate
  // silence look like a hang. `GEZEL_EVAL_SOFT_PROGRESS_TIMEOUT_MS`
  // overrides outright.
  const softProgressTimeoutMs = (() => {
    const env = process.env.GEZEL_EVAL_SOFT_PROGRESS_TIMEOUT_MS;
    if (env) {
      const n = Number.parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return defaultSoftProgressTimeoutMsForModel(opts.modelId, engine);
  })();
  // CLI `--image-model` is a per-scenario OVERRIDE — it only applies
  // when the scenario itself declares it needs image gen. Without this
  // gate, passing `--image-model flux` on a matrix run would force
  // every scenario (tictactoe, tankcombat, …) to spend ~minutes warming
  // an image model they never call. Wild-caught
  // qwen3.6 matrix where all 9 trials failed `model warm` for flux
  // even though only petshop needed it.
  const imageModelId =
    scenario.defaultImageModelId !== undefined
      ? (opts.imageModelId ?? scenario.defaultImageModelId)
      : undefined;
  let imageModelHome: string | undefined;

  await mkdir(runDir, { recursive: true });
  const trialHome = await mkdtemp(join(tmpdir(), `gezel-eval-${scenario.id}-`));

  const startedAt = new Date();
  const startMonotonic = Date.now();

  // Drop an early "running" marker so the live eval viewer can surface
  // this trial the moment it starts — before any `result.json` exists.
  // `finalize()` removes it once the terminal result lands. Best-effort:
  // a failed write here must never abort a trial.
  await writeTrialStatus(runDir, {
    trialId,
    scenarioId: scenario.id,
    modelId: opts.modelId,
    engine,
    startedAt: startedAt.toISOString(),
    status: 'running',
  });

  const logger = new TrialLogger({ runDir, gezelHome: trialHome });
  await logger.init();
  const log = logger.log;

  log(`[trial] id=${trialId} scenario=${scenario.id} model=${opts.modelId}`);
  log(`[trial] runDir=${runDir}`);
  log(`[trial] trialHome=${trialHome}`);
  log(`[trial] cacheRoot=${cacheRoot}`);

  // `engine` was resolved at the top of the function so the trial id
  // can encode the provider; pull category here for the gates below.
  const category = categorizeProvider(engine);
  log(`[trial] provider=${engine} category=${category}`);

  // Pre-flight auth probe for non-local providers. Catches "you forgot
  // to export OPENAI_API_KEY" before we spend minutes on warm-cache /
  // daemon boot. Local engines have no auth; this is a no-op for them.
  const authProbe = probeProviderAuth(engine);
  if (!authProbe.ok) {
    return finalize({
      trialId,
      scenarioId: scenario.id,
      modelId: opts.modelId,
      modelTier,
      startedAt,
      startMonotonic,
      runDir,
      success: false,
      reason: authProbe.message,
      failureMode: 'spawn-error',
      logger,
      trialHome,
      client: null,
    });
  }

  let llamaBin: string | undefined;
  let sdBin: string | undefined;
  let resolvedLlama: ResolvedBinary | undefined;
  try {
    if (engine === 'llama-cpp') {
      // Route --llama-bin through resolution too: an explicit path still gets
      // its build identity read and pin-checked, so no selection path reaches
      // a trial record unidentified.
      resolvedLlama = resolveLlamaBinary(opts.llamaBin);
      llamaBin = resolvedLlama.path;
      log(`[trial] llama-server=${llamaBin} ${describeResolvedLlama(resolvedLlama)}`);
      for (const warning of resolvedLlama.warnings) log(`[trial] engine-warning: ${warning}`);
    } else if (engine === 'ds4') {
      // ds4-server is a GLOBAL singleton — it refuses to start if ANY other
      // ds4 process is alive ("another ds4 process is already running; refusing
      // to start"), and its own startup orphan-reaper can race a stale server
      // left by a prior trial. The home-scoped trial reaper doesn't catch
      // cross-trial orphans, so clear the slate before spawning.
      killStaleDs4Servers(log);
    }
    if (imageModelId) {
      sdBin = opts.sdBin ?? resolveSdBinary()?.path;
      if (!sdBin) {
        throw new Error(
          'image model needed but no sd-server binary found. Build/fetch native binaries first, or pass --image-bin.',
        );
      }
      log(`[trial] sd-server=${sdBin}`);
    }
  } catch (err) {
    return finalize({
      trialId,
      scenarioId: scenario.id,
      modelId: opts.modelId,
      modelTier,
      startedAt,
      startMonotonic,
      runDir,
      success: false,
      reason: err instanceof Error ? err.message : String(err),
      failureMode: 'spawn-error',
      logger,
      trialHome,
      client: null,
    });
  }

  // Phase 1: warm cache. Llama-cpp uses the eval's cache root; MLX
  // reuses the user's existing dev-mode cache (`~/.gezel-dev/engines/mlx/`)
  // since downloading a 16+ GB nvfp4 mirror just to run a trial would
  // be silly when the user already has the same weights on disk for
  // their app. CLI-wrapper and cloud providers skip this phase entirely
  // — their "model" is remote, there's nothing on disk to warm.
  // The enricher model (when split from the executor) goes through the
  // same warm/assert + link pipeline as the primary — a partial second
  // model would otherwise surface an hour in as a wedged enrichment drive.
  const secondModelId =
    opts.enrichModelId && opts.enrichModelId !== opts.modelId ? opts.enrichModelId : null;
  try {
    if (engine === 'llama-cpp') {
      if (!llamaBin) throw new Error('llama-cpp engine selected but llamaBin is unresolved');
      for (const modelId of [opts.modelId, ...(secondModelId ? [secondModelId] : [])]) {
        await ensureWarmModel({
          cacheRoot,
          engine: 'llama-cpp',
          modelId,
          llamaBin,
          ...(opts.signal ? { signal: opts.signal } : {}),
          log,
        });
      }
    } else if (engine === 'mlx') {
      // MLX: verify the source dir is a complete install (not just present —
      // a stalled download leaves a partial, manifest-less dir that the MLX
      // engine rejects 6ms in, masked as a 300s chat-stall); we symlink it
      // in phase 2.
      const mlxSourceHome = opts.mlxSourceHome ?? defaultMlxSourceHome();
      for (const modelId of [opts.modelId, ...(secondModelId ? [secondModelId] : [])]) {
        const sourceDir = join(mlxSourceHome, 'engines', 'mlx', 'models', modelId);
        assertMlxSourceComplete(sourceDir, modelId);
        // Completeness is not currency. The llama-cpp path self-heals via
        // `ensureWarmModel` (evict + refetch), but MLX weights live in the
        // user's dev home and this harness only symlinks them — so a catalog
        // change that repoints a model has no way to fix itself here and would
        // otherwise be measured as if nothing changed. Wild-caught 2026-07-31:
        // correcting four gemma MLX sources (4-bit -> QAT-8bit, nvfp4 ->
        // 4bit) left every installed copy stale, and the re-test that was
        // supposed to VALIDATE the correction would have silently re-run the
        // old weights. Fail loudly with the pull command instead.
        const stale = await staleInstallReason({
          cacheRoot: mlxSourceHome,
          engine: 'mlx',
          modelId,
        });
        if (stale) {
          throw new Error(
            `MLX model "${modelId}" at ${sourceDir} is STALE vs the catalog (${stale}). The harness cannot refetch MLX weights (it symlinks your dev home), so re-pull first: gezel model pull --provider mlx ${modelId}`,
          );
        }
        log(`[trial] mlx source=${sourceDir}`);
      }
    } else {
      log(`[trial] ${engine} is ${category} — skipping warm-cache phase`);
    }
    if (imageModelId && sdBin) {
      // Same source-home shortcut we use for MLX chat models: if the
      // user already has the image model installed under
      // `<mlxSourceHome>/engines/sd-cpp/models/<id>` (i.e. their dev
      // app downloaded it via the catalog UI), skip the eval-cache
      // install entirely. FLUX/SDXL weights are 6–12 GB each; the
      // duplicate download was costing minutes per trial AND
      // failing the warm step outright when the eval-cache install
      // pipeline diverges from the dev app's.
      const imageSourceHome = opts.mlxSourceHome ?? defaultMlxSourceHome();
      const sdSourceDir = join(imageSourceHome, 'engines', 'sd-cpp', 'models', imageModelId);
      if (await isModelInstalled(imageSourceHome, 'sd-cpp', imageModelId)) {
        imageModelHome = imageSourceHome;
        log(`[trial] sd-cpp source=${sdSourceDir} (skipping warm-cache install)`);
      } else {
        if (existsSync(sdSourceDir)) {
          log(`[trial] sd-cpp source=${sdSourceDir} is incomplete; using the eval cache instead`);
        }
        // No complete source-home copy — fall back to the warm-cache
        // path. sd-cpp warming just spawns the daemon with the sd-server
        // binary set, no llama needed.
        await ensureWarmModel({
          cacheRoot,
          engine: 'sd-cpp',
          modelId: imageModelId,
          ...(llamaBin ? { llamaBin } : {}),
          sdBin,
          ...(opts.signal ? { signal: opts.signal } : {}),
          log,
        });
        imageModelHome = cacheRoot;
      }
    }
  } catch (err) {
    const warmFailure = modelWarmFailure(err, opts.signal);
    return finalize({
      trialId,
      scenarioId: scenario.id,
      modelId: opts.modelId,
      modelTier,
      startedAt,
      startMonotonic,
      runDir,
      success: false,
      reason: warmFailure.reason,
      failureMode: warmFailure.failureMode,
      logger,
      trialHome,
      client: null,
    });
  }

  // Phase 2: clone the model dir into the trial home. Product model stores
  // reject linked directories, so the cache helper uses copy-on-write clones
  // where the filesystem supports them. Llama-cpp clones from the eval cache;
  // MLX clones from the user's existing `engines/mlx/models/<id>` tree.
  // CLI-wrapper and cloud providers have nothing to materialize.
  if (engine === 'llama-cpp') {
    for (const modelId of [opts.modelId, ...(secondModelId ? [secondModelId] : [])]) {
      await linkModelIntoTrial({
        cacheRoot,
        trialHome,
        engine: 'llama-cpp',
        modelId,
      });
      log(`[trial] linked llama-cpp/${modelId} into ${trialHome}`);
    }
  } else if (engine === 'mlx') {
    const mlxSourceHome = opts.mlxSourceHome ?? defaultMlxSourceHome();
    for (const modelId of [opts.modelId, ...(secondModelId ? [secondModelId] : [])]) {
      await linkModelIntoTrial({
        cacheRoot: mlxSourceHome,
        trialHome,
        engine: 'mlx',
        modelId,
      });
      log(`[trial] linked mlx/${modelId} from ${mlxSourceHome} into ${trialHome}`);
      // Speculative decoding arms from the drafter's presence, so a trial
      // without it silently measures speculation OFF.
      if (await linkDrafterIntoTrial({ sourceHome: mlxSourceHome, trialHome, modelId })) {
        log(`[trial] linked mlx drafter for ${modelId} (speculative decoding armed)`);
      }
    }
    // Also link in the prebuilt uv venv tree so the trial daemon
    // doesn't have to download mlx-lm + transformers + torch from
    // scratch (a several-GB install that easily eats 10+ minutes on
    // first run). The MLX provider's UvRuntime uses the venv at
    // `<home>/engines/uv/venvs/mlx/`; if it's already present (and
    // has a manifest matching the requested package set) the
    // ensureVenv call short-circuits to an O(ms) no-op.
    await linkUvTreeIntoTrial({ mlxSourceHome, trialHome, log });
  }
  if (imageModelId) {
    // Reuse the exact complete install selected during the warm phase.
    // A merely-present source directory may hold only `.partial` files.
    const linkFrom = imageModelHome ?? cacheRoot;
    await linkModelIntoTrial({
      cacheRoot: linkFrom,
      trialHome,
      engine: 'sd-cpp',
      modelId: imageModelId,
    });
    log(`[trial] linked sd-cpp/${imageModelId} from ${linkFrom} into ${trialHome}`);
  }

  // Phase 3: spawn trial daemon.
  if (requestedMaxDurationMs !== authoredMaxDurationMs && opts.timeoutMs === undefined) {
    log(
      `[trial] throughput-scaled ceiling: ${Math.round(authoredMaxDurationMs / 60_000)}m → ${Math.round(requestedMaxDurationMs / 60_000)}m at ${opts.decodeRateTokensPerSec} tok/s (reference ${CEILING_REFERENCE_TOKENS_PER_SEC} tok/s)`,
    );
  }
  if (llamaEvalLaunch?.summary) {
    log(`[trial] ${llamaEvalLaunch.summary}`);
    if (maxDurationMs > requestedMaxDurationMs) {
      log(
        `[trial] large-model minimum timeout raised maxDuration ${requestedMaxDurationMs}ms → ${maxDurationMs}ms`,
      );
    }
  }
  // Per-run behavior overrides (A/B toggle) — injected into the daemon
  // env, read by `applyBehaviorEnvOverrides` at session build. Merged on
  // top of any llama launch env so both can coexist.
  // Keurmeester arm: force the marker behavior alongside any caller-
  // supplied overrides so the treatment is greppable in the daemon env;
  // the actual enable + frontier target land in config during Phase 4.
  const forceBehaviors = [
    ...(opts.forceBehaviors ?? []),
    ...(opts.keurmeester ? ['supervision.keurmeester'] : []),
  ];
  const mergedExtraEnv = evalDaemonEnvForTrial({
    ...(llamaEvalLaunch ? { launch: llamaEvalLaunch } : {}),
    providerLock: engine,
    ...(forceBehaviors.length > 0 ? { forceBehaviors } : {}),
    ...(opts.removeBehaviors ? { removeBehaviors: opts.removeBehaviors } : {}),
    ...(opts.craftbookDocFormat ? { craftbookDocFormat: opts.craftbookDocFormat } : {}),
    ...(opts.toolNaming ? { toolNaming: opts.toolNaming } : {}),
    ...(opts.disableBackgroundEnrich ? { disableBackgroundEnrich: true } : {}),
    ...(opts.enrichModelId ? { enrichModelId: opts.enrichModelId } : {}),
    ...(opts.enableModelRouting ? { enableModelRouting: true } : {}),
    ...(scenario.requiresEmbeddings ? { enableEmbeddings: true } : {}),
  });
  // Live mock services (craftbook test.json `mocks[]`): boot BEFORE the
  // daemon so its env can carry the trial CA + credential seed file. The
  // runtime closes in the trial's finally.
  let mockRuntime: Awaited<ReturnType<typeof startMockServices>> = null;
  if (
    scenario.mockServices?.some(
      (mock) => mock.kind === 'http' || mock.kind === 'webhook' || mock.kind === 'mcp',
    )
  ) {
    try {
      mockRuntime = await startMockServices(scenario.mockServices, {
        trialHome,
        ...(scenario.mockMcpToolArgumentSchemas
          ? { mcpToolArgumentSchemas: scenario.mockMcpToolArgumentSchemas }
          : {}),
      });
    } catch (err) {
      return finalize({
        trialId,
        scenarioId: scenario.id,
        modelId: opts.modelId,
        modelTier,
        startedAt,
        startMonotonic,
        runDir,
        success: false,
        reason: `mock services failed to start: ${err instanceof Error ? err.message : String(err)}`,
        failureMode: 'spawn-error',
        logger,
        trialHome,
        client: null,
      });
    }
  }
  if (mockRuntime) {
    const caPath = join(runDir, 'mock-ca.pem');
    const seedPath = join(runDir, 'mock-seed.json');
    await writeFile(caPath, mockRuntime.caPem, 'utf8');
    await writeFile(seedPath, JSON.stringify(mockRuntime.seedEntries()), 'utf8');
    mergedExtraEnv.NODE_EXTRA_CA_CERTS = caPath;
    mergedExtraEnv.GEZEL_SEED_SECRETS_FILE = seedPath;
    // Fake-MCP toolsets: catalog-valid ids go into the trial home's local
    // catalog and install through the ordinary rail. Runtime-managed scoped
    // ids such as @playwright/mcp are seeded into the fresh system roster so
    // a craftbook's required-toolset check sees the hermetic replacement.
    // The runner writes both because only it knows the trial home —
    // EvalContext deliberately has no home path.
    for (const file of mockRuntime.mcpToolsetFiles()) {
      const target = join(trialHome, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      log(`[mock] wrote local-catalog toolset file ${file.path}`);
    }
    for (const service of mockRuntime.services.values()) {
      log(`[mock] ${service.id} (${service.kind}) listening at ${service.baseUrl}`);
    }
  }
  const fetchUrlMockIds = scenario.allowFetchUrlMockServiceIds ?? [];
  if (fetchUrlMockIds.length > 0) {
    let originEnv: Record<string, string>;
    try {
      originEnv = evalFetchUrlMockOriginEnv(mockRuntime, fetchUrlMockIds);
    } catch (error) {
      await mockRuntime?.close().catch(() => {});
      return finalize({
        trialId,
        scenarioId: scenario.id,
        modelId: opts.modelId,
        modelTier,
        startedAt,
        startMonotonic,
        runDir,
        success: false,
        reason: error instanceof Error ? error.message : String(error),
        failureMode: 'spawn-error',
        logger,
        trialHome,
        client: null,
      });
    }
    // Two-key eval-only contract consumed by the service's fetch_url SSRF
    // guard. The marker alone grants nothing; the JSON value is an exact
    // origin list derived from this trial's ephemeral HTTPS mocks. Never
    // pass globs, hosts without ports, or every running mock implicitly.
    Object.assign(mergedExtraEnv, originEnv);
    log(`[mock] fetch_url exact-origin grant: ${originEnv.GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS}`);
  }
  let spawned: Awaited<ReturnType<typeof spawnTrialDaemon>>;
  try {
    spawned = await spawnTrialDaemon({
      home: trialHome,
      ...(llamaBin ? { llamaBin } : {}),
      ...(sdBin ? { sdBin } : {}),
      ...(Object.keys(mergedExtraEnv).length > 0 ? { extraEnv: mergedExtraEnv } : {}),
      stderrLogPath: join(runDir, 'daemon.log'),
      // 120s, not 60s: after an image scenario a native sd-server can hold
      // Metal/RAM a few seconds past its SIGKILL, and the next daemon's boot
      // races that release. See `SpawnTrialDaemonOptions.timeoutMs`. The
      // batch runner additionally retries a daemon-boot timeout once
      // (`runTrialWithSpawnRetry`), since it's unambiguously infra.
      timeoutMs: 120_000,
    });
  } catch (err) {
    await mockRuntime?.close().catch(() => {});
    return finalize({
      trialId,
      scenarioId: scenario.id,
      modelId: opts.modelId,
      modelTier,
      startedAt,
      startMonotonic,
      runDir,
      success: false,
      reason: `daemon spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      failureMode: 'spawn-error',
      logger,
      trialHome,
      client: null,
    });
  }
  log(`[trial] daemon spawned pid=${spawned.pid} port=${spawned.baseUrl}`);

  const client = spawned.client;
  // Run recording ("exhaust") — always-on, best-effort. Started the moment
  // the daemon is reachable so the meester-ensure and setup turns are on
  // tape too; a recorder fault degrades the recording, never the trial.
  let recorder: ChatEventRecorderHandle | null = null;
  let recordingStats: ChatEventRecorderStats | null = null;
  try {
    recorder = startChatEventRecorder({ client, runDir, log });
    log('[recording] chat-event tap started');
  } catch (err) {
    log(`[recording] tap failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  let success = false;
  let reason = 'trial did not produce a terminal result';
  let failureMode: FailureMode | undefined = 'crash';
  let finalSniff: TrialFinalSniff | undefined;

  // ── Performance collector + host info (Tier 5a) ─────────────────
  // Captures peak RSS / CPU / GPU util across the trial + token usage
  // at shutdown. Best-effort; samplers no-op on hosts where ps /
  // nvidia-smi are missing (Windows, GPU-less Linux).
  const hostInfo = captureHostInfo({
    framework: engine,
    frameworkBinary: llamaBin ?? null,
    frameworkVariant: resolvedLlama?.variant ?? null,
    frameworkBuild: resolvedLlama?.build ?? null,
  });
  try {
    await writeHostInfo(runDir, hostInfo);
  } catch (err) {
    log(
      `[perf] writeHostInfo failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const perf = new PerfCollector({
    log,
    client,
    enableLocalSampling: isLocalEngine(engine),
    daemonLogPath: join(runDir, 'daemon.log'),
  });
  perf.start(spawned.pid);
  let metrics: TrialMetrics | null = null;

  try {
    // Phase 4: configure provider + short-circuit first-run bootstrap.
    // `buildProviderConfig` returns the provider + defaultModel pair
    // for whichever chat provider was selected; image provider is
    // independent and always sd-cpp (the only local image provider)
    // when a scenario requests image generation. Cloud chat providers
    // can still drive sd-cpp for images via the standard image-gen
    // tool — the two pipelines are decoupled.
    await client.updateConfig({
      ...buildProviderConfig(engine, opts.modelId),
      // Eval prompts must be deterministic. Retrieval scenarios may enable
      // the embedding engine above, but no trial gets unsolicited recall.
      autoRecall: { enabled: false },
      ...(llamaEvalLaunch?.config ? llamaEvalLaunch.config : {}),
      ...(reasoningEffortConfig ? reasoningEffortConfig : {}),
      ...(evalLlamaSpecType ? { llamaCppSpecType: evalLlamaSpecType } : {}),
      ...(evalLlamaKvCache ? { llamaCppKvCacheType: evalLlamaKvCache } : {}),
      ...localEvalDeviceSafetyConfig(engine),
      // Theme-F lever probe: point `GEZEL_EVAL_SPEC_DRAFT_PATH` at a draft
      // GGUF to A/B speculative decoding on a real scenario via the
      // gezel-session path (where per-model tuning applies, unlike raw /v1).
      // The engine-flags path is identical to the shipped per-manifest
      // `spec` block; this just supplies the draft by explicit path so the
      // gate doesn't depend on the draft being installed under its catalog id.
      ...(process.env.GEZEL_EVAL_SPEC_DRAFT_PATH
        ? {
            llamaCppSpecType: 'draft-simple' as const,
            llamaCppDraftModelPath: process.env.GEZEL_EVAL_SPEC_DRAFT_PATH,
            llamaCppSpecDraftNMax: 4,
          }
        : {}),
      // KV-cache precision lever. Same shape as the spec-draft probe above:
      // an explicit A/B knob for `--cache-type-k/v` so a run can pin f16 vs
      // q8_0 vs q4_0 instead of taking `resolveLlamaCppKvCacheType`'s
      // family-aware default (q8_0 everywhere except Gemma). Spread AFTER
      // `llamaEvalLaunch.config` so it also overrides that path's q4_0.
      ...(process.env.GEZEL_EVAL_KV_CACHE_TYPE
        ? {
            llamaCppKvCacheType: process.env.GEZEL_EVAL_KV_CACHE_TYPE as 'f16' | 'q8_0' | 'q4_0',
          }
        : {}),
      ...(imageModelId ? { imageProvider: 'sd-cpp' as const } : {}),
      ...(opts.executionDensity ? { executionDensity: opts.executionDensity } : {}),
      ...(opts.keurmeester
        ? {
            keurmeester: {
              enabled: true,
              providerName: opts.keurmeester.providerName,
              ...(opts.keurmeester.model ? { model: opts.keurmeester.model } : {}),
            },
          }
        : {}),
      // Mock-enabled trials need the `network` script capability (the
      // http.authed rail) — the trial home is isolated and every
      // reachable service is a per-trial loopback fake, so the free
      // posture is the correct eval-scoped setting.
      ...(mockRuntime
        ? {
            securityPolicy: {
              level: 'free' as const,
              allowFileEdits: true,
              allowExternalChat: true,
              allowExternalServices: true,
              allowScriptExecution: true,
              allowAppNetwork: true,
            },
          }
        : {}),
      firstRunCompleted: true,
    });
    log(
      `[trial] provider=${engine}${evalLlamaSpecType ? ` llamaSpec=${evalLlamaSpecType}` : ''}${imageModelId ? ' imageProvider=sd-cpp' : ''}${opts.executionDensity ? ` executionDensity=${opts.executionDensity}` : ''}${opts.keurmeester ? ` keurmeester=${opts.keurmeester.providerName}${opts.keurmeester.model ? `/${opts.keurmeester.model}` : ''}` : ''} configured, firstRunCompleted=true`,
    );

    // Phase 5: ensure Meester exists.
    const meesterId = await ensureMeester(client);
    log(`[trial] meester=${meesterId}`);

    // Phase 5.5: optional scenario setup hook. Runs after daemon boot
    // and before the kickoff prompt — gives scenarios like
    // `self-correction-broken-js` a place to seed workspace state the
    // prompt then references. Errors bubble up and fail the trial.
    if (scenario.setup) {
      log('[trial] running scenario setup hook');
      await scenario.setup({
        client,
        meesterId,
        ...(mockRuntime ? { mocks: mockRuntime } : {}),
        log,
        // logChanged is a no-op during setup; setup is one-shot, not polled.
        logChanged: (_key, line) => log(line),
      });
      log('[trial] scenario setup complete');
    }

    // Phase 6: start the history tail, kick off the auto-answerer, send
    // the prompt. Auto-answer keeps unattended trials from stalling on
    // ask_user_question calls — without it any scenario where a gezel
    // pauses to ask a clarifying question runs out the clock.
    logger.startHistoryTail();
    const stopAutoAnswerer = startAutoAnswerer({
      client,
      meesterId,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (scenario.skipInitialPrompt) {
      log('[trial] skipped initial meester prompt (scenario setup already kicked off work)');
    } else {
      const kickoff = mockRuntime ? mockRuntime.substitute(scenario.prompt) : scenario.prompt;
      await client.sendChatMessage(meesterId, {
        message: kickoff,
        projectId: 'default',
      });
      log(`[trial] sent prompt to meester (${kickoff.length} chars)`);
    }

    try {
      // Phase 7: poll until done, stuck, hit hard ceiling, or aborted.
      // Per-model `evalHints` (from the catalog manifest) are loaded
      // here so they ride along with the EvalContext; scenarios that
      // care (interactive games today) consult them through the ctx.
      const evalHints = loadModelEvalHints(opts.modelId);
      if (evalHints) {
        log(`[trial] evalHints loaded: ${JSON.stringify(evalHints)}`);
      }
      const verdict = await pollUntilDone(scenario, {
        client,
        meesterId,
        log,
        pollIntervalMs,
        maxDurationMs,
        hardProgressTimeoutMs,
        softProgressTimeoutMs,
        inflightDeferMs: inflightDeferMsForEngine(engine),
        writeCounterTrustworthy: isLocalEngine(engine),
        daemonLogPath: join(runDir, 'daemon.log'),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(evalHints ? { evalHints } : {}),
        ...(mockRuntime ? { mocks: mockRuntime } : {}),
      });
      success = verdict.success;
      reason = verdict.reason;
      failureMode = verdict.failureMode;
      finalSniff = verdict.finalSniff;
    } finally {
      await stopAutoAnswerer();
    }
  } catch (err) {
    success = false;
    reason = `runner crashed: ${err instanceof Error ? err.message : String(err)}`;
    failureMode = 'crash';
    log(`[trial] crash: ${reason}`);
  } finally {
    // Phase 8: stop perf collector (one usage probe before the daemon
    // goes away), capture forensic state, then shut down.
    try {
      metrics = await perf.stop();
      await writeMetrics(runDir, metrics);
      log(
        `[perf] metrics: peakRss=${metrics.process.peakRssMb}MB` +
          `${
            metrics.gpu.available
              ? `, peakGpuUtil=${metrics.gpu.peakUtilPercent}%${
                  metrics.gpu.memoryModel === 'unified'
                    ? `, gpuMem=unified(peakSysMem=${metrics.systemMemory.peakUsedMb}/${metrics.systemMemory.totalMb}MB)`
                    : `, peakGpuMem=${metrics.gpu.peakMemUsedMb}/${metrics.gpu.memTotalMb}MB`
                }`
              : ', gpu=n/a'
          }` +
          `${metrics.derived.meanTokensPerSec ? `, ~${metrics.derived.meanTokensPerSec} t/s` : ''}`,
      );
    } catch (err) {
      log(
        `[perf] collector teardown failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (recorder) {
      try {
        recordingStats = await recorder.stop();
        log(
          `[recording] tap stopped: ${recordingStats.lines} line(s), ` +
            `${recordingStats.coalescedDeltas} coalesced delta(s), ${recordingStats.gaps.length} gap(s)`,
        );
      } catch (err) {
        log(`[recording] tap stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await captureFinalState({ client, trialHome, runDir, log, trialFailed: !success });
    } catch (err) {
      log(
        `[trial] capture-final-state failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let recordingCapture: Record<string, string> | undefined;
    try {
      recordingCapture = { ...(await captureRecordingState({ client, trialHome, runDir, log })) };
    } catch (err) {
      log(`[recording] capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const screenshotStatus = await captureRecordingScreenshots({ runDir, log });
      recordingCapture = { ...(recordingCapture ?? {}), screenshots: screenshotStatus };
    } catch (err) {
      log(`[recording] screenshots failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await distillRunDir(runDir, {
        trial: {
          trialId,
          scenarioId: scenario.id,
          modelId: opts.modelId,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startMonotonic,
          success,
          reason,
        },
        log,
      });
    } catch (err) {
      log(`[recording] distillation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await writeRecordingManifest({
        runDir,
        trialId,
        scenarioId: scenario.id,
        modelId: opts.modelId,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        ...(recordingStats ? { chatEvents: recordingStats } : {}),
        ...(recordingCapture ? { capture: recordingCapture } : {}),
        log,
      });
    } catch (err) {
      log(`[recording] manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await shutdownTrialDaemon(spawned);
    log('[trial] daemon shut down');
    if (mockRuntime) {
      // Persist the request logs for postmortems before closing.
      try {
        const logDump = Object.fromEntries(
          [...mockRuntime.services.values()].map((service) => [service.id, service.requests]),
        );
        await writeFile(
          join(runDir, 'mock-requests.json'),
          `${JSON.stringify(logDump, null, 1)}\n`,
          'utf8',
        );
      } catch {
        /* best-effort forensic dump */
      }
      await mockRuntime.close().catch(() => {});
      log('[mock] services closed');
    }
  }

  return finalize({
    trialId,
    scenarioId: scenario.id,
    modelId: opts.modelId,
    modelTier,
    startedAt,
    startMonotonic,
    runDir,
    success,
    reason,
    failureMode: success ? undefined : failureMode,
    ...(success || !finalSniff ? {} : { finalSniff }),
    logger,
    trialHome,
    client,
  });
}

export async function ensureMeester(client: GezelClient): Promise<string> {
  const config = await client.getConfig();
  if (config.meesterGezelId) {
    const { gezels } = await client.listGezels();
    if (gezels.some((g) => g.id === config.meesterGezelId)) {
      return config.meesterGezelId;
    }
  }
  // Service auto-creates a Meester on first boot, but only when there are
  // zero gezels — in case that didn't happen yet, force one.
  const created = await client.createNewMeester({});
  return created.gezel.id;
}

/**
 * Default hard ceiling on a trial. Set high enough that no realistic
 * local-model trial hits it; the no-progress watchdogs are the primary
 * kill mechanism. 8 hours is the band the user explicitly authorized:
 * thorough overnight reviews are valid; runaway processes consuming a
 * full day are not.
 */
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

/**
 * Default soft no-progress window. If the SOFT digest (engine-alive
 * heartbeat) hasn't moved for this long, the daemon is hung — kill.
 * 5 min is conservative enough for normal idle phases (between turns)
 * and aggressive enough to surface a real crash.
 */
const DEFAULT_SOFT_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INFLIGHT_DEFER_MS = 4 * 60 * 1000;

/**
 * MLX in-flight defer cap — larger than the 4-min default because MLX on
 * Apple Silicon prefills a large prompt markedly slower than the llama.cpp/CUDA
 * boxes that cap was tuned on. A 45K-token prefill on a 31B model can stay
 * mid-turn for 10+ minutes before the FIRST output token, and there is no soft
 * heartbeat during prefill (`stream-active` only fires once decode starts). The
 * 4-min cap then lapses while the turn is still legitimately prefilling
 * (daemon.log shows `[mlx] Prefill: 0/45163`), the soft digest is flat, and the
 * watchdog false-fires `chat-stalled` on real work — capability inverts (the
 * fast 2B clears the gate, the slow 31B "stalls"). Deferring for up to 20 min
 * covers any realistic prefill+first-token latency; the 45-min HARD progress
 * watchdog remains the real backstop for a genuinely wedged mid-turn engine.
 * Wild-caught tuning gemma4-31b-q4 on tool-routing-retrieval (45,163-
 * token prefill killed at 602s). Complements the existing MLX soft-window
 * doubling in {@link defaultSoftProgressTimeoutMsForModel}.
 */
const MLX_WATCHDOG_INFLIGHT_DEFER_MS = 20 * 60 * 1000;

/** In-flight defer cap for the soft watchdog, scaled by engine. */
export function inflightDeferMsForEngine(engine?: ChatProvider): number {
  return engine === 'mlx' ? MLX_WATCHDOG_INFLIGHT_DEFER_MS : WATCHDOG_INFLIGHT_DEFER_MS;
}

/**
 * Silence floor for self-orchestrating providers (codex-cli, anthropic-cli,
 * copilot). They run a nested agent loop inside one invocation and go
 * gezel-silent for the whole thing — minutes per turn — so the chatty-model
 * default (5 min) reads legitimate work as a hang. 20 min comfortably clears
 * the longest single-invocation builds observed (≈7 min) while staying well
 * under the 45-min HARD progress watchdog, which remains the real backstop.
 * See {@link isSelfOrchestratingProvider}.
 */
const SELF_ORCHESTRATING_MIN_SOFT_PROGRESS_MS = 20 * 60 * 1000;

/**
 * Roles that actually write workspace files, and their complement.
 *
 * The service refuses a file handoff to a coordination-only role — see the
 * pure-delegation guard in `chat/manager.ts`, which is correct: a voorman
 * routes work, it does not produce deliverables. Attaching an
 * `expectedDeliverable` to a nudge aimed at one is a guaranteed HTTP 400, and
 * the nudge then never lands at all. Wild-caught 2026-08-07 on
 * gemma4-e4b-q8 / data-wrangle, where both escalation nudges 400'd and the
 * trial still failed claiming the model had ignored them.
 */
const WRITE_CAPABLE_ROLES = /^(builder|developer|implementer|engineer)$/i;

/**
 * Default hard no-progress window. If the HARD digest (real product
 * progress: tool calls, workspace, sessions, sniff) hasn't moved for
 * this long, the model is busy but not delivering — kill.
 *
 * 45 min (was 20): the eval measures capability, which is invariant to
 * decode speed — a trial reaches the same verdict at 3 t/s or 300 t/s,
 * just over different wall-clock. At low t/s a single legitimate
 * generation phase can run well past 20 min between HARD-digest moves
 * (a slow medium model streaming a 6 KB file is real progress), so the
 * tighter window produced false "no real progress" kills. 45 min
 * matches the large-model launch override so every tier gets the same
 * generous window; the count-based retry-loop ("N re-writes without
 * sniff movement", throughput-invariant) is the primary terminator,
 * and `DEFAULT_MAX_DURATION_MS` (8 h) is the runaway backstop.
 */
const DEFAULT_HARD_PROGRESS_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_ACTIVE_TRIAL_SESSIONS = 64;

/**
 * A bounded eval task should not create an unbounded forest of active chats.
 * Session count used to count as hard progress forever; a broken craftbook
 * fanout reached 144 active sessions and thereby kept a multi-hour trial alive.
 */
export function runawaySessionFailure(
  sessionCount: number,
  maximum = MAX_ACTIVE_TRIAL_SESSIONS,
): EvalTerminalFailure | null {
  if (sessionCount < maximum) return null;
  return {
    reason: `runaway orchestration: ${sessionCount} active chat sessions reached the eval safety cap of ${maximum}; session creation is no longer forward progress`,
    failureMode: 'model-stuck',
  };
}

/**
 * Soft-clock flatness at which a hard-watchdog kill is described as an idle
 * engine rather than a busy one. Deliberately short: the soft digest moves on
 * any token stream or slot update, so a full minute of silence already means
 * no turn is producing anything. This only selects wording — it never changes
 * whether the watchdog fires.
 */
const HARD_FAIL_IDLE_SOFT_THRESHOLD_MS = 60_000;

/**
 * Build the daemon env fragment carrying per-run behavior overrides
 * (the A/B toggle). `forceBehaviors` → `GEZEL_FORCE_BEHAVIORS`,
 * `removeBehaviors` → `GEZEL_REMOVE_BEHAVIORS` (comma-joined). Exported
 * for unit testing the control-vs-treatment wiring.
 */
export function behaviorEnvForTrial(opts: {
  forceBehaviors?: string[];
  removeBehaviors?: string[];
}): NodeJS.ProcessEnv {
  return {
    ...(opts.forceBehaviors && opts.forceBehaviors.length > 0
      ? { GEZEL_FORCE_BEHAVIORS: opts.forceBehaviors.join(',') }
      : {}),
    ...(opts.removeBehaviors && opts.removeBehaviors.length > 0
      ? { GEZEL_REMOVE_BEHAVIORS: opts.removeBehaviors.join(',') }
      : {}),
  };
}

export function evalDaemonEnvForTrial(opts: {
  launch?: LlamaCppEvalLaunchOverrides;
  forceBehaviors?: string[];
  removeBehaviors?: string[];
  /** See {@link TrialOptions.craftbookDocFormat} — `GEZEL_CRAFTBOOK_DOC_FORMAT`. */
  craftbookDocFormat?: 'json' | 'md';
  /** See {@link TrialOptions.toolNaming} — `GEZEL_MCP_TOOL_NAMING`. */
  toolNaming?: 'snake' | 'legacy';
  /** See {@link TrialOptions.disableBackgroundEnrich}. */
  disableBackgroundEnrich?: boolean;
  /** See {@link TrialOptions.enrichModelId} — `GEZEL_ENRICH_MODEL`. */
  enrichModelId?: string;
  /** See {@link TrialOptions.enableModelRouting} — opt back IN to routing. */
  enableModelRouting?: boolean;
  /** Keep spawned/recovery gezels on this local provider during the trial. */
  providerLock?: ChatProvider;
  /** Opt into embeddings only for dedicated semantic-retrieval scenarios. */
  enableEmbeddings?: boolean;
}): NodeJS.ProcessEnv {
  return {
    GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    ...(opts.enableEmbeddings ? {} : { GEZEL_DISABLE_EMBEDDINGS: '1' }),
    // Capability-floor model routing is default-ON in the product but
    // MUST be off in trials: a trial home links up to three models
    // (chat + image + enrich/keurmeester), so routing would swap
    // craftbook worker steps off the model under evaluation and
    // silently corrupt every craftbook-scenario result. A future
    // routing eval opts back in via `enableModelRouting`.
    ...(opts.enableModelRouting ? {} : { GEZEL_DISABLE_MODEL_ROUTING: '1' }),
    // A local model can author a recovery gezel pinned to Copilot/OpenAI.
    // That changes the model under test (or fails on unavailable cloud auth),
    // invalidating the trial. Cloud/CLI evals intentionally do not set this.
    ...(opts.providerLock && isLocalEngine(opts.providerLock)
      ? { GEZEL_EVAL_PROVIDER_LOCK: opts.providerLock }
      : {}),
    ...(opts.disableBackgroundEnrich ? { GEZEL_DISABLE_BACKGROUND_ENRICH: '1' } : {}),
    ...(opts.enrichModelId ? { GEZEL_ENRICH_MODEL: opts.enrichModelId } : {}),
    // Diagnostics passthrough: run any eval bin with GEZEL_PROMPT_BREAKDOWN=1
    // to get the per-section prompt-size table in each trial's daemon.log.
    ...(process.env.GEZEL_PROMPT_BREAKDOWN
      ? { GEZEL_PROMPT_BREAKDOWN: process.env.GEZEL_PROMPT_BREAKDOWN }
      : {}),
    ...(opts.craftbookDocFormat ? { GEZEL_CRAFTBOOK_DOC_FORMAT: opts.craftbookDocFormat } : {}),
    // Explicit for BOTH arms of the naming A/B so each daemon.log records
    // which arm produced it (`snake` is behaviorally the same as unset).
    ...(opts.toolNaming ? { GEZEL_MCP_TOOL_NAMING: opts.toolNaming } : {}),
    ...(opts.launch?.extraEnv ?? {}),
    ...behaviorEnvForTrial(opts),
  };
}

/**
 * Decode rate the scenario ceilings were hand-authored against. Every
 * `timeoutMs` in `scenarios/` was calibrated by watching a gemma-class
 * model on a CUDA box, which measures 21-23 tok/s; 20 is that class's
 * round number.
 */
const CEILING_REFERENCE_TOKENS_PER_SEC = 20;

/**
 * Cap on the throughput multiplier. The absolute {@link DEFAULT_MAX_DURATION_MS}
 * clamp already bounds a runaway, but without a multiplier cap a single bad
 * rate measurement (a mis-parsed 0.01 tok/s) would silently lift every
 * ceiling to the 8 h backstop and disable the safety net wholesale. 8x
 * covers everything down to 2.5 tok/s linearly, which is below the
 * `DEFAULT_PREFLIGHT_MIN_TPS` admission floor.
 */
const MAX_CEILING_THROUGHPUT_SCALE = 8;

/**
 * Scale a scenario-authored hard ceiling by measured decode throughput.
 *
 * The eval measures capability, which is invariant to decode speed — a
 * trial reaches the same verdict at 5 tok/s or 50 tok/s, just over
 * different wall-clock. A fixed ceiling breaks that invariance and makes
 * the verdict a property of the hardware: `conflict-synthesis` was pinned
 * at 30 min, which gemma cleared in 1.8 min at 22.5 tok/s while qwen
 * needed 36.8 min at 4.8 tok/s and died on the wall with the harness
 * itself reporting "forward progress kept happening". Re-run with room,
 * it passed 13/13.
 *
 * Scaling is one-directional: a model faster than the reference keeps the
 * authored ceiling rather than getting a tighter one, because the authored
 * value is a runaway safety net and not a performance target. The result
 * is clamped to {@link DEFAULT_MAX_DURATION_MS} so no amount of slowness
 * defeats the 8 h backstop.
 *
 * This replaces hand-tuning ~29 constants every time a slower model joins
 * the matrix. The no-progress watchdogs remain the primary terminators.
 */
export function throughputScaledMaxDurationMs(args: {
  authoredMaxDurationMs: number;
  decodeRateTokensPerSec?: number | null;
}): number {
  const rate = args.decodeRateTokensPerSec;
  if (rate === undefined || rate === null || !Number.isFinite(rate) || rate <= 0) {
    return args.authoredMaxDurationMs;
  }
  const scale = Math.min(
    Math.max(CEILING_REFERENCE_TOKENS_PER_SEC / rate, 1),
    MAX_CEILING_THROUGHPUT_SCALE,
  );
  return Math.min(Math.round(args.authoredMaxDurationMs * scale), DEFAULT_MAX_DURATION_MS);
}

export function defaultSoftProgressTimeoutMsForModel(
  modelId: string,
  engine?: ChatProvider,
): number {
  const billions = modelBillionsForEval(modelId);
  let base: number;
  if (billions !== undefined && billions >= 120) {
    base = 12 * 60 * 1000;
  } else if (billions !== undefined && billions >= 70) {
    base = 8 * 60 * 1000;
  } else {
    base = DEFAULT_SOFT_PROGRESS_TIMEOUT_MS;
  }
  // MLX on Apple Silicon decodes markedly slower than the llama.cpp/CUDA
  // boxes these size thresholds were tuned on, so a big model's first turn on
  // a large-prompt scenario can outrun the window before any progress lands —
  // surfacing as a false `chat-stalled` where capability inverts: the fast 2B
  // clears the gate while the slow 27–35B "fails". Wild-caught on
  // bookstore-openapi (qwen3.6-27b-q4 + gemma4-31b-q4 both stalled at the
  // 300s default mid-first-turn; with the window lifted, qwen3.6-27b-q4's
  // first turn landed at 459s and it ran to an artifact at sniff 6). Double
  // the window for MLX so first-turn latency on Apple Silicon isn't read as a
  // hang. (Proper long-term fix: make the watchdog streaming-aware — don't
  // fire while the MLX server reports active token decode.)
  const sized = engine === 'mlx' ? base * 2 : base;
  // Self-orchestrating providers (codex-cli/anthropic-cli/copilot) run a
  // whole agent loop inside one invocation and stay gezel-silent for it, so
  // the chatty-model window misreads legitimate work as a hang: codex-cli
  // tankcombat false-failed at 301s, then re-ran PASS in 113s. Lift their
  // silence floor; the 45-min HARD progress watchdog stays the real backstop.
  if (engine && isSelfOrchestratingProvider(engine)) {
    return Math.max(sized, SELF_ORCHESTRATING_MIN_SOFT_PROGRESS_MS);
  }
  return sized;
}

export interface LlamaCppEvalLaunchOverrides {
  extraEnv?: NodeJS.ProcessEnv;
  config?: Partial<GezelConfig>;
  minTrialTimeoutMs?: number;
  hardProgressTimeoutMs?: number;
  summary?: string;
}

export function llamaCppReasoningEvalLaunchOverrides(
  opts: Pick<TrialOptions, 'llamaCppReasoningPreserve' | 'llamaCppReasoningBudgetTokens'>,
  engine: ChatProvider,
): LlamaCppEvalLaunchOverrides | undefined {
  const preserve = opts.llamaCppReasoningPreserve;
  const budget = opts.llamaCppReasoningBudgetTokens;
  if (preserve === undefined && budget === undefined) return undefined;
  if (engine !== 'llama-cpp') {
    throw new Error('llama.cpp reasoning launch overrides require engine=llama-cpp');
  }
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw new Error('llamaCppReasoningBudgetTokens must be a positive safe integer');
  }
  return {
    extraEnv: {
      ...(preserve !== undefined ? { GEZEL_LLAMA_REASONING_PRESERVE: preserve ? '1' : '0' } : {}),
      ...(budget !== undefined ? { GEZEL_LLAMA_REASONING_BUDGET_TOKENS: String(budget) } : {}),
    },
    summary: `reasoning experiment: preserve=${preserve ?? 'catalog/default'} budget=${budget ?? 'catalog'}`,
  };
}

export function llamaCppReasoningEffortEvalConfig(
  opts: Pick<TrialOptions, 'modelId' | 'llamaCppReasoningEffort'>,
  engine: ChatProvider,
): Partial<GezelConfig> | undefined {
  const raw = opts.llamaCppReasoningEffort;
  if (raw === undefined) return undefined;
  if (engine !== 'llama-cpp') {
    throw new Error('llama.cpp reasoning effort override requires engine=llama-cpp');
  }
  const effort = raw.trim();
  if (!/^[a-z][a-z0-9_-]*$/i.test(effort)) {
    throw new Error('llamaCppReasoningEffort must be a non-empty template token');
  }
  return {
    modelTuning: {
      [opts.modelId]: {
        reasoning: { templateKwargs: { reasoning_effort: effort } },
      },
    },
  };
}

export function mergeLlamaCppEvalLaunchOverrides(
  base: LlamaCppEvalLaunchOverrides | undefined,
  experiment: LlamaCppEvalLaunchOverrides | undefined,
): LlamaCppEvalLaunchOverrides | undefined {
  if (!base) return experiment;
  if (!experiment) return base;
  return {
    ...base,
    ...experiment,
    extraEnv: { ...base.extraEnv, ...experiment.extraEnv },
    config: { ...base.config, ...experiment.config },
    minTrialTimeoutMs: Math.max(base.minTrialTimeoutMs ?? 0, experiment.minTrialTimeoutMs ?? 0),
    hardProgressTimeoutMs: Math.max(
      base.hardProgressTimeoutMs ?? 0,
      experiment.hardProgressTimeoutMs ?? 0,
    ),
    summary: [base.summary, experiment.summary].filter(Boolean).join('; '),
  };
}

export function llamaCppEvalLaunchOverridesForModel(
  modelId: string,
): LlamaCppEvalLaunchOverrides | undefined {
  const billions = modelBillionsForEval(modelId);
  if (billions === undefined || billions < 120) return undefined;

  // Frontier-size local evals run one foreground trial at a time. The
  // production default of 2 llama-server slots × 65K context is useful
  // for background memory jobs on 7B-35B models, but on 120B+ weights it
  // can spend the entire admission budget on KV before the first turn.
  // Keep this eval-scoped. The prior 49K cap was below observed working sets:
  // Qwen 122B and Nemotron Super repeatedly reached 59–62K during deep repair.
  // One q4_0-KV slot at 65K still fits the 110 GB frontier-host budget under
  // the capacity broker's conservative weights + KV + compute-headroom model.
  const numCtx = '65536';
  return {
    extraEnv: {
      GEZEL_LLAMA_NUM_CTX: numCtx,
      GEZEL_LLAMA_STARTUP_TIMEOUT_MS: '900000',
      GEZEL_LLAMA_PRE_FIRST_BYTE_TIMEOUT_MS: '900000',
      GEZEL_CAPACITY_BUDGET_GB: '110',
    },
    config: {
      providerConcurrency: { 'llama-cpp': 1 },
      llamaCppKvCacheType: 'q4_0',
    },
    minTrialTimeoutMs: 60 * 60_000,
    hardProgressTimeoutMs: 45 * 60_000,
    summary:
      'llama-cpp large-model eval override: numCtx=65536, concurrency=1, kvCache=q4_0, capacityBudget=110GB, tuning=catalog, startup/pre-first-byte=900s, hardProgressTimeout=45m, minTrialTimeout=60m',
  };
}

/**
 * One-line engine identity for the trial log, so a run can be attributed to a
 * specific build without cross-referencing `host.json`.
 */
function describeResolvedLlama(resolved: ResolvedBinary): string {
  const parts = [`variant=${resolved.variant ?? 'none'}`];
  const build = resolved.build;
  if (build?.buildNumber) parts.push(`build=${build.buildNumber}`);
  if (build?.revision) parts.push(`rev=${build.revision.slice(0, 8)}`);
  if (build?.backend) parts.push(`backend=${build.backend}`);
  if (build?.cudaArchitectures?.length)
    parts.push(`cuda-arch=${build.cudaArchitectures.join(',')}`);
  return parts.join(' ');
}

/**
 * Kill any lingering ds4-server processes before a ds4 trial. ds4-server is a
 * global singleton (it grabs the Metal device / a process lock and refuses to
 * start when another ds4 is alive), so a stale server from a prior trial —
 * which the home-scoped {@link reapTrialNativeChildren} doesn't match — blocks
 * the new one. Best-effort SIGKILL.
 */
function killStaleDs4Servers(log: (m: string) => void): void {
  let out = '';
  try {
    out = execFileSync('pgrep', ['-f', 'ds4-server'], { encoding: 'utf8' });
  } catch {
    return; // pgrep exits 1 when there are no matches — nothing to kill.
  }
  const pids = out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
  if (pids.length === 0) return;
  log(
    `[trial] ds4: killing ${pids.length} stale ds4-server process(es) before spawn: ${pids.join(', ')}`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Resolve the ds4 (DeepSeek-V4) GGUF for an eval trial. ds4's weights are huge
 * (~80–150 GB) and model-specific, so rather than warm them into the eval
 * cache the trial points the supervised ds4-server at an explicit file.
 * Precedence: `GEZEL_DS4_MODEL` env → eval cache → the user's dev home. Returns
 * undefined when none is found (the provider then surfaces its actionable
 * "install from Settings" error and the trial fails fast with a clear reason).
 */
function resolveDs4ModelPath(modelId: string): string | undefined {
  const env = process.env.GEZEL_DS4_MODEL?.trim();
  if (env && existsSync(env)) return env;
  for (const home of [join(homedir(), '.gezel-eval-cache'), join(homedir(), '.gezel-dev')]) {
    const dir = join(home, 'engines', 'ds4', 'models', modelId);
    if (!existsSync(dir)) continue;
    const gguf = readdirSync(dir).find((f) => f.endsWith('.gguf'));
    if (gguf) return join(dir, gguf);
  }
  return undefined;
}

/**
 * ds4 (DeepSeek-V4) eval launch overrides — parallels
 * {@link llamaCppEvalLaunchOverridesForModel}. On a 128 GB-class unified-memory
 * host the model is loaded fully; smaller hosts stream MoE experts from disk,
 * so their resident footprint is the expert-cache budget (not all weights)
 * plus KV + context buffers.
 * One trial at a time; generous startup for the cold ~80 GB mmap + first-run
 * shader compile. Capability is throughput-invariant, so the trial timeouts
 * are generous (ds4 decodes ~6 tok/s on the GB10 Spark, ~10–13 on a 64 GB Mac).
 *
 * The residency + expert-cache tiers mirror `buildDs4Provider`. This is purely
 * a throughput lever (the composite is invariant to it); forcing streaming on
 * the 121 GiB GB10 measured 2.6x slower end-to-end than full residency.
 */
export function ds4EvalShouldUseSsdStreaming(opts?: {
  totalRamBytes?: number;
  modelSizeBytes?: number;
  platform?: NodeJS.Platform;
  arch?: string;
}): boolean {
  const totalRamBytes = opts?.totalRamBytes ?? totalmem();
  const modelSizeBytes = opts?.modelSizeBytes;
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const unifiedMemoryTarget = arch === 'arm64' && (platform === 'darwin' || platform === 'linux');
  const fullResidencyHeadroomBytes = 32 * 1024 ** 3;
  return !(
    unifiedMemoryTarget &&
    modelSizeBytes &&
    modelSizeBytes + fullResidencyHeadroomBytes <= totalRamBytes
  );
}

export function ds4EvalLaunchOverridesForModel(
  modelId: string,
): LlamaCppEvalLaunchOverrides | undefined {
  const bin = resolveDs4Binary();
  const model = resolveDs4ModelPath(modelId);
  // Mirror buildDs4Provider's RAM tiers for the resident expert cache, and size
  // the broker budget to cover it (cache + ~4 GiB ctx buffers + KV) with OS
  // headroom. Throughput only — does not change capability/scores.
  const totalRamGb = totalmem() / 1024 ** 3;
  const modelSizeBytes = model
    ? (() => {
        try {
          return statSync(model).size;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const ssdStreaming = ds4EvalShouldUseSsdStreaming({ modelSizeBytes });
  const cacheExpertsGb = totalRamGb >= 120 ? 64 : totalRamGb >= 88 ? 48 : 32;
  const capacityBudgetGb = totalRamGb >= 120 ? 96 : totalRamGb >= 88 ? 72 : 56;
  // ds4/DeepSeek-V4 supports ~1M context and SSD-STREAMS its KV cache to disk
  // (not RAM), so a small window throws away the engine's headline strength.
  // At 24576 a single specialist-handoff message (~36K tokens) overflowed the
  // window → ds4-server 400 context_length_exceeded → the turn errored, the
  // session was poisoned, and the trial stalled (tool-routing-image). 128K
  // matches buildDs4Provider's 64 GB device tier; KV stays ~1.8 GiB (under
  // ds4-server's 4096 MiB disk budget) and context buffers ~4 GiB fit alongside
  // the 32 GB expert cache on a 64 GB box.
  const numCtx = 131072;
  return {
    extraEnv: {
      ...(bin ? { GEZEL_DS4_SERVER_BIN: bin.path } : {}),
      ...(model ? { GEZEL_DS4_MODEL: model } : {}),
      GEZEL_DS4_STARTUP_TIMEOUT_MS: '1200000',
      GEZEL_CAPACITY_BUDGET_GB: String(capacityBudgetGb),
    },
    config: {
      providerConcurrency: { ds4: 1 },
      ds4SsdStreaming: ssdStreaming,
      ...(ssdStreaming ? { ds4CacheExpertsGb: cacheExpertsGb } : {}),
      ds4NumCtx: numCtx,
    },
    minTrialTimeoutMs: 120 * 60_000,
    hardProgressTimeoutMs: 45 * 60_000,
    summary: `ds4 eval override: bin=${bin?.path ?? 'MISSING'} model=${model ?? 'MISSING'} numCtx=${numCtx} ramGb=${Math.round(totalRamGb)} residency=${ssdStreaming ? `ssd-streaming cache=${cacheExpertsGb}GB` : 'full'} concurrency=1 capacityBudget=${capacityBudgetGb}GB tuning=catalog startup=1200s hardProgressTimeout=45m minTrialTimeout=120m`,
  };
}

export function readCapacityDenialFromLog(daemonLogPath?: string): string | null {
  if (!daemonLogPath || !existsSync(daemonLogPath)) return null;
  let text: string;
  try {
    text = readFileSync(daemonLogPath, 'utf8');
  } catch {
    return null;
  }
  // Strictest of the three denial regexes (see also failure-class.ts and
  // preflight.ts): matches the full raw reason from CapacityBroker.denialReason,
  // logged via capacityDenialLogLine in
  // packages/service/src/providers/native/provider-pool.ts. Do not reword either side.
  const match = text.match(
    /capacity broker denied [^\n]+: budget exhausted: would commit \d+ against \d+/,
  );
  return match?.[0] ?? null;
}

export function readContextOverflowFromLog(daemonLogPath?: string): string | null {
  if (!daemonLogPath || !existsSync(daemonLogPath)) return null;
  let text: string;
  try {
    text = readFileSync(daemonLogPath, 'utf8');
  } catch {
    return null;
  }
  const actionable = text.match(/On-device model ran out of working memory: [^\n]+/);
  if (actionable) return actionable[0]!;
  const raw = text.match(
    /request \(([\d,]+) tokens\) exceeds the available context size \(([\d,]+) tokens\)/,
  );
  if (!raw) return null;
  return `context overflow: ${raw[1]} tokens needed but only ${raw[2]} available`;
}

export async function pollUntilDone(
  scenario: EvalScenario,
  args: {
    client: GezelClient;
    meesterId: string;
    log: (line: string) => void;
    pollIntervalMs: number;
    /** Per-trial hard ceiling (default 8h). Survival cap, not a budget. */
    maxDurationMs: number;
    /**
     * Hard-progress no-change window: kill if real progress (tool
     * calls, workspace, sessions, sniff) hasn't moved this long.
     * Default 20m — catches "model busy but not delivering."
     */
    hardProgressTimeoutMs: number;
    /**
     * Soft-progress no-change window: kill if the daemon has emitted
     * zero observable activity (token streams, slot updates, anything)
     * for this long. Default 5m — catches dead/hung daemons.
     */
    softProgressTimeoutMs: number;
    /**
     * True when `daemonActivity.writeCalls` is meaningful for this trial.
     * Local engines route file mutations through gezel-mcp so the counter
     * is real; CLI-wrapper providers use their own built-in editors and
     * the counter is structurally 0 (see the FILE_MUTATION_TOOLS bare-name
     * set). Reporting "blind" on a LOCAL engine buries the finding — a
     * qwen3.8-27b-q4 trial of craftbook-author-gate-script made 25 tool
     * calls and zero file mutations, and the message told triage to
     * discount the zero that WAS the result.
     */
    writeCounterTrustworthy?: boolean;
    /**
     * How long a single in-flight turn may defer the SOFT watchdog. Engine-
     * scaled (MLX gets a larger cap for slow Apple-Silicon prefill — see
     * {@link inflightDeferMsForEngine}). Default {@link WATCHDOG_INFLIGHT_DEFER_MS}.
     */
    inflightDeferMs?: number;
    /** Path to daemon.log so the fingerprint can include engine activity. */
    daemonLogPath?: string;
    signal?: AbortSignal;
    /** Per-model eval-harness hints loaded by the runner from the
     *  model's catalog manifest (see `model-eval-hints.ts`). Threaded
     *  onto the EvalContext so scenarios can consult e.g.
     *  `sniffThresholds.inlineJsMinBytes` / `htmlMinBytes`. */
    evalHints?: import('@bendyline/gezel').EvalHints;
    /** Live mock-service runtime, threaded onto the EvalContext. */
    mocks?: import('./mock/mock-server.ts').MockServicesRuntime;
  },
): Promise<{
  success: boolean;
  reason: string;
  failureMode?: FailureMode;
  finalSniff?: TrialFinalSniff;
}> {
  const startedAt = Date.now();
  // Progress-aware hard ceiling. The ceiling is a runaway backstop, not a
  // budget (see "Throughput-invariance" in the eval-run skill): capability
  // is invariant to decode speed, so a slow trial that is still visibly
  // advancing must not be killed by the clock. When the deadline arrives
  // but hard progress moved within the recency window, extend in steps —
  // capped at 2× the requested ceiling so a genuinely looping trial still
  // dies. Wild-caught: 5 of the 2026-08-01 sweep "failures" were ceiling
  // kills whose own reason text admitted progress was ongoing.
  let hardDeadline = startedAt + args.maxDurationMs;
  const hardCeilingCapMs = args.maxDurationMs * 2;
  const ceilingExtendIfProgressWithinMs = 10 * 60_000;
  const ceilingExtendStepMs = 15 * 60_000;
  args.log(
    `[poll] starting (interval=${args.pollIntervalMs}ms maxDuration=${args.maxDurationMs}ms hardProgressTimeout=${args.hardProgressTimeoutMs}ms softProgressTimeout=${args.softProgressTimeoutMs}ms)`,
  );
  // Per-trial dedup map for the `logChanged` channel — scenarios use
  // this for sniff lines that repeat every poll cycle.
  const seenLines = new Map<string, string>();
  const logChanged = (key: string, line: string): void => {
    if (seenLines.get(key) === line) return;
    seenLines.set(key, line);
    args.log(line);
  };
  // Latest sniff state surfaced by the scenario via `recordSniff`.
  // Mutated on every `successCheck` that reports a sniff; the next
  // fingerprint capture reads it as one of the progress signals. The
  // assignment lives inside a closure that TS's CFA can't track, so
  // declare the type via an assertion to keep the union from collapsing
  // to `null` at usage sites further down the loop.
  type SniffRef = {
    key: string;
    score: number;
    bytes: number;
    failReason?: string;
    repairFilePath?: string;
    runtimePassed?: number;
    runtimeFailed?: number;
    milestones?: number;
  } | null;
  let latestSniff = null as SniffRef;
  const scoredSniffKeys = new Set<string>();
  const recordSniff = (state: {
    key: string;
    score: number;
    bytes: number;
    failReason?: string;
    repairFilePath?: string;
    runtimePassed?: number;
    runtimeFailed?: number;
    milestones?: number;
  }): void => {
    latestSniff = state;
    // Sticky, so a transient re-read of 0 does not disarm a guard that a
    // real artifact already armed. It must therefore be populated by the
    // SAME predicate the guard reads — recording a bare score>0 here made
    // the sticky set assert an artifact the sniff never evidenced, and no
    // later poll could take that assertion back.
    if (sniffEvidencesArtifact(state)) {
      scoredSniffKeys.add(state.key);
    }
  };
  // Structured salvage: terminal failures carry the last sniff state so
  // "killed at 6/7" is queryable from result.json without parsing
  // reason strings (near-miss accounting for failure classification).
  const finalSniffOf = (): { finalSniff?: TrialFinalSniff } =>
    latestSniff ? { finalSniff: latestSniff } : {};
  let requestedTerminalFailure = null as EvalTerminalFailure | null;
  const requestTerminalFailure = (failure: EvalTerminalFailure): void => {
    // First request wins. A scenario may run several helper checks in one
    // poll; retaining the first exhausted invariant makes the terminal reason
    // deterministic and prevents a later secondary failure from masking it.
    if (requestedTerminalFailure === null) requestedTerminalFailure = failure;
  };
  const snapshotRepairActions = async (scope: {
    sessionId: string;
    gezelId: string;
    projectId?: string;
  }): Promise<EvalRepairActionSnapshot | null> => {
    try {
      const [session, telemetry] = await Promise.all([
        args.client.getChatSession(scope.sessionId),
        args.client.getSessionTelemetry(scope.sessionId),
      ]);
      return completedRepairActionSnapshot(session, telemetry.telemetry?.inflight ?? false);
    } catch (err) {
      logChanged(
        `repair-action-snapshot:${scope.sessionId}`,
        `[poll] completed repair-action snapshot unavailable for ${scope.gezelId}/${scope.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  // Allocated ONCE per trial so any module that keys per-trial state off
  // the ctx identity (`runtime-feedback.ts`'s `WeakMap<EvalContext, Set>`)
  // sees a stable handle across all poll iterations.
  const ctx = {
    client: args.client,
    meesterId: args.meesterId,
    log: args.log,
    logChanged,
    recordSniff,
    requestTerminalFailure,
    snapshotRepairActions,
    ...(args.evalHints ? { evalHints: args.evalHints } : {}),
    ...(args.mocks ? { mocks: args.mocks } : {}),
  };

  // Progress-fingerprint state. We capture a baseline before the first
  // successCheck so the no-progress timer starts ticking only after a
  // real "no change observed" cycle. `lastFingerprintAt` is when the
  // fingerprint last changed; `lastDigest` is the digest of the
  // current state we're waiting to see move.
  let lastHardDigest: string;
  let lastSoftDigest: string;
  try {
    const initial = await captureFingerprint(
      args.client,
      args.meesterId,
      latestSniff,
      args.daemonLogPath,
    );
    const d = digestFingerprint(initial);
    lastHardDigest = d.hard;
    lastSoftDigest = d.soft;
  } catch (err) {
    args.log(
      `[poll] initial fingerprint capture failed: ${err instanceof Error ? err.message : String(err)} (continuing with empty baseline)`,
    );
    lastHardDigest = 'initial-capture-failed';
    lastSoftDigest = 'initial-capture-failed';
  }
  let lastHardChangeAt = Date.now();
  let lastSoftChangeAt = Date.now();
  args.log(`[poll] initial digests hard=${lastHardDigest} soft=${lastSoftDigest}`);

  // Retry-loop guard. Distinct from the hard/soft watchdogs above:
  //   - hard fires when NO progress (no tool calls, no sessions, no
  //     sniff) is observed for 20 min.
  //   - soft fires when the daemon is idle for 5 min.
  //   - retry-loop fires when the team has produced an artifact
  //     (sniff is non-null) but can't push it past the success bar.
  //
  // The copilot tankcombat trials reproduced two failure
  // modes this catches:
  //
  // (A) "Stubborn rewrite loop" — Sonnet rewrote a tankcombat file
  //     50 times across 21 minutes, each one failing the same runtime
  //     assertion. The first iteration of this guard used (plateau
  //     time + tool-call accumulation) which catches this cleanly.
  //
  // (B) "Stuck after one rewrite" — Sonnet wrote one tankcombat,
  //     got the runtime nudge, replied with an empty message, then
  //     the team idled while Imara kept pinging. Tool-call counts
  //     stayed flat (no rewrites), so the tool-call threshold
  //     never tripped, but sniff still plateaued at the failing
  //     8/8 for 15+ minutes.
  //
  // Three trigger paths, each matched to one real failure shape — the
  // discriminators are (1) WRITE activity vs read-only churn and (2) how
  // long the scored artifact has stalled:
  //   - FAST path: 8 min plateau + ≥3 artifact-WRITE calls (catches A —
  //     stubborn-rewriter re-emitting the same failing shape). Gated on
  //     writes, NOT total tool calls: a held sniff key with climbing
  //     read_file calls is research toward the next write (any real write
  //     moves the bytes/score and resets the key), not a rewrite loop.
  //     The old total-tool-call gate false-killed gemma4-31b squisq-review
  // (twice) on 19 read_file research calls.
  //   - LONG path: 12 min plateau AND the team has gone idle (≤4 new
  //     tool calls) (catches B — stuck-after-nudge; an idled team has
  //     nothing left to deliver). A team still CLIMBING tool calls is
  // actively working — gemma4-31b squisq-review lost a
  //     trial when the un-gated LONG path fired at 12m on a reviewer with
  //     12+ climbing read_file calls, before the prompt's own 25m "start
  //     writing" mark. The idle gate keeps mode B (the Sonnet tankcombat
  //     idle-after-nudge case had FLAT tool calls).
  //   - STALL path: 18 min plateau on a scored artifact regardless of
  //     activity (catches C — wrote a partial, then read source forever
  //     without ever completing it; slips past FAST's write gate and
  //     LONG's idle gate). Generous enough to clear the passing trials'
  //     ~10-12m partial→full rewrite arcs, finite so a read-loop can't
  //     ride the 8h hard ceiling.
  //
  // All three require a non-null sniff: "no artifact yet" is the
  // hard-progress watchdog's territory. FAST/STALL additionally require a
  // scored artifact. A first-time score-0 sniff still means "file not written
  // yet"; a later score-0 on a sniff key that previously scored means the
  // artifact regressed into a parser/shape failure and should still be guarded
  // as a stuck artifact.
  const RETRY_LOOP_FAST_WINDOW_MS = 8 * 60 * 1000;
  // FAST path gates on artifact-WRITE calls, not total tool calls. Its
  // target (mode A) is a stubborn rewriter re-emitting the same failing
  // shape; ≥3 writes of a scored artifact with no sniff movement is that
  // loop. The old total-tool-call gate (15) mistook read-only research
  // for rewriting and false-killed squisq-review (twice: a
  // 4806B/5cit and a 4088B/3cit draft, each still being researched to
  // completion when 19 read_file calls tripped the 8-min FAST path).
  const RETRY_LOOP_FAST_WRITE_THRESHOLD = 3;
  const RETRY_LOOP_LONG_WINDOW_MS = 12 * 60 * 1000;
  // LONG path only fires when the team has effectively stopped issuing
  // tool calls during the plateau. A working reviewer reading source at
  // ~15 t/s emits far more than this over 12m; an idled team emits ~0.
  const RETRY_LOOP_LONG_IDLE_TOOL_MAX = 4;
  // STALL path: a scored artifact that hasn't improved for a generous
  // window DESPITE ongoing activity — the "wrote a partial, then read
  // source forever without ever completing it" case that slips past both
  // FAST (few writes) and LONG (not idle). 18m is deliberately longer
  // than FAST/LONG: the passing squisq-review trials complete their
  // partial→full rewrite within ~10-12m plateaus, and the scenario prompt
  // budgets 45m / "start writing around 25m", so an 18m no-improvement
  // plateau on an existing artifact is a real stall — while still finite,
  // so a genuine read-loop can't ride the 8h hard ceiling.
  const RETRY_LOOP_STALL_WINDOW_MS = 18 * 60 * 1000;
  // CHATTER path: a scored artifact is flat, the team keeps starting
  // turns, but none of those turns writes an artifact. This catches the
  // "repair nudge answered in chat / coordination loop" case earlier
  // than the broad STALL backstop while still ignoring read-heavy work
  // that emits real tool calls.
  const RETRY_LOOP_CHATTER_WINDOW_MS = 10 * 60 * 1000;
  const RETRY_LOOP_CHATTER_TURN_THRESHOLD = 12;
  // Pre-trigger nudge fires at 80% of the fast-path window once the team
  // has been busy (total tool calls, read OR write). Catches "team busy
  // reading but never writing the deliverable" — qwen3.6 squisq-review
  // iter2: 19 tool calls of read_file/grep_artifact, never a
  // write_artifact for the review.md, sniff stuck at score=0 the whole
  // time. Deliberately keyed on TOTAL tool calls (unlike the FAST path's
  // write gate) — read-heavy churn is exactly when the "stop reading,
  // write/expand now" nudge is most useful. One-shot per trial,
  // independent of the soft-timeout nudge budget.
  const RETRY_LOOP_NUDGE_WINDOW_MS = Math.floor(RETRY_LOOP_FAST_WINDOW_MS * 0.8);
  const RETRY_LOOP_NUDGE_TOOL_THRESHOLD = 12;
  // See the re-engage pair below: attempted gates the budget, delivered gates
  // what the failure reason is allowed to assert.
  let retryLoopNudgeAttempted = false;
  let retryLoopNudgeDelivered = false;
  let sniffPlateauKey: string | null = null;
  let sniffPlateauStartedAt = Date.now();
  // One plateau reset per delivered escalation rung (stage 0/1/2), cleared
  // when the plateau key changes. See shouldDeferRetryLoopForRecentEscalation.
  const retryLoopGrantedNudgeStages = new Set<number>();
  let sniffPlateauStartingToolCalls = 0;
  // Parallel to sniffPlateauStartingToolCalls, but counting only
  // artifact-WRITE tool calls — the FAST retry-loop path gates on
  // re-write activity, not read-only research churn.
  let sniffPlateauStartingWriteCalls = 0;
  // Workspace file total when the current sniff plateau began — the FAST
  // path uses its growth to tell producing from re-emitting.
  let sniffPlateauStartingPathSignature = '';
  let sniffPlateauStartingTurnStarts = 0;

  // One-shot re-engage nudge. When the soft window has used ~80% of its
  // budget AND some sniff progress exists (artifact written but not
  // terminal), poke the meester once to verify against the brief before
  // failing. Catches the "team thinks it's done but sniff disagrees"
  // pattern — see petshop postmortem: meester said "the
  // project is finished" while sniff held at 4/8, then everyone went
  // idle and the soft timer killed the trial. Issued at most once per
  // trial; if it doesn't unstick the chat, the regular soft timeout
  // fires and the failure is honest.
  // `Attempted` gates the one-shot budget; `Delivered` gates what the failure
  // reason may claim. They differ when the send itself fails, and conflating
  // them is how a trial came to report "nudge was sent and ignored" about a
  // message the service had rejected with a 400.
  let reEngageNudgeAttempted = false;
  let reEngageNudgeDelivered = false;
  let reEngageNudgeDeliveredAt: number | null = null;
  let reEngageTargetGezelId: string | null = null;
  const reEngageThresholdMs = Math.floor(args.softProgressTimeoutMs * 0.8);
  let inflightSoftDeferralLoggedAt = 0;
  let inflightHardReEngageDeferralLoggedAt = 0;
  let silentRecoveryLoggedAt = 0;
  let silentRecoveryNote: string | null = null;
  let imageRetryLoopDeferralLoggedAt = 0;
  let inflightRetryLoopDeferralLoggedAt = 0;
  const poisonedSessionRecovery = new PoisonedSessionRecoveryTracker();

  while (true) {
    if (Date.now() >= hardDeadline) {
      const sinceHardMs = Date.now() - lastHardChangeAt;
      const step = Math.min(ceilingExtendStepMs, hardCeilingCapMs - (hardDeadline - startedAt));
      if (sinceHardMs <= ceilingExtendIfProgressWithinMs && step > 0) {
        hardDeadline += step;
        args.log(
          `[poll] hard ceiling reached but hard progress moved ${Math.round(sinceHardMs / 1000)}s ago — extending ${Math.round(step / 60_000)}m (${Math.round((hardDeadline - startedAt) / 60_000)}m of ${Math.round(hardCeilingCapMs / 60_000)}m cap)`,
        );
      } else {
        break;
      }
    }
    if (args.signal?.aborted) {
      args.log('[poll] aborted by signal');
      return {
        success: false,
        reason: 'interrupted (SIGINT/SIGTERM); cleanup ran',
        failureMode: 'interrupted',
      };
    }
    let result: SuccessCheckResult;
    try {
      result = await scenario.successCheck(ctx);
    } catch (err) {
      args.log(`[poll] successCheck threw: ${err instanceof Error ? err.message : String(err)}`);
      result = { done: false };
    }
    if (result.done) {
      args.log(`[poll] terminal: success=${result.success} reason=${result.reason}`);
      return {
        success: result.success,
        reason: result.reason,
        failureMode: result.success ? undefined : (result.failureMode ?? 'success-check-false'),
      };
    }
    const capacityDenial = readCapacityDenialFromLog(args.daemonLogPath);
    if (capacityDenial) {
      args.log(`[poll] terminal: capacity denied (${capacityDenial})`);
      return {
        success: false,
        reason: capacityDenial,
        failureMode: 'spawn-error',
        ...finalSniffOf(),
      };
    }
    const contextOverflow = readContextOverflowFromLog(args.daemonLogPath);
    if (contextOverflow) {
      args.log(`[poll] terminal: context overflow (${contextOverflow})`);
      return {
        success: false,
        reason: contextOverflow,
        failureMode: 'spawn-error',
        ...finalSniffOf(),
      };
    }
    // Infrastructure failures take precedence when they occur on the same
    // poll as a scenario-helper exhaustion request. Otherwise a capacity or
    // context failure would be mislabeled as model repair exhaustion.
    const terminalFailure = requestedTerminalFailure as EvalTerminalFailure | null;
    if (terminalFailure) {
      args.log(`[poll] terminal (scenario handoff): ${terminalFailure.reason}`);
      return {
        success: false,
        reason: terminalFailure.reason,
        failureMode: terminalFailure.failureMode,
        ...finalSniffOf(),
      };
    }
    let poisonedSnapshotReliable = true;
    const poisonedForRecovery = await listPoisonedSessionsForWatchdog(
      args.client,
      args.meesterId,
    ).catch(() => {
      poisonedSnapshotReliable = false;
      return [];
    });
    // Recovery is bounded by checked progress. A strictly higher sniff score
    // starts a fresh checkpoint. At the same score, one additional recovery is
    // allowed only when a successful mutation changed BOTH the checked byte
    // size and the normalized concrete failure; that catches semantic repair
    // progress which does not clear a whole gate. Byte churn or changing
    // validation timing alone cannot re-arm it, and the same score gets at
    // most two recoveries total. Once that allowance is exhausted, another
    // poison is a terminal model repair failure — waiting for the generic
    // 5-minute soft watchdog only hides the real cause as `chat-stalled`.
    // Never fail while that session still has an in-flight turn; its previous
    // error can remain visible briefly during dispatch.
    // A failed list call is not evidence that every poison cleared; skipping
    // this observation avoids a transient HTTP error arming false repeats.
    const repeatedPoisoned = poisonedSnapshotReliable
      ? poisonedSessionRecovery.observe(poisonedForRecovery, latestSniff ?? undefined)
      : [];
    let poisonInflight: InflightTurnSnapshot[] | null = null;
    if (repeatedPoisoned.length > 0) {
      poisonInflight = await listInflightTurnsForWatchdog(args.client).catch(() => null);
      // If the inflight endpoint itself failed, ownership is unknown. Defer
      // the fail-fast decision to the next poll instead of risking a false
      // terminal while a recovery turn is actually still running.
      const repeatedTarget = poisonInflight
        ? repeatedPoisoned.find(
            (session) => !poisonInflight?.some((turn) => turn.sessionId === session.sessionId),
          )
        : undefined;
      if (repeatedTarget) {
        const failure = repeatedPoisonedSessionFailure(repeatedTarget);
        args.log(`[poll] terminal: ${failure.reason}`);
        return { success: false, ...failure, ...finalSniffOf() };
      }
    }
    const poisonedTarget = poisonedSnapshotReliable
      ? poisonedForRecovery.find(
          (session) => !poisonedSessionRecovery.hasAttempted(session.sessionId),
        )
      : undefined;
    if (poisonedTarget) {
      const inflight =
        poisonInflight ?? (await listInflightTurnsForWatchdog(args.client).catch(() => null));
      // An active local-model turn can legitimately take minutes. Never
      // overlap it with a recovery send just because it crossed an arbitrary
      // age threshold; the ordinary hard watchdog owns genuinely wedged
      // in-flight work. A failed inflight snapshot is also unknown, not proof
      // that the session is idle.
      if (canDispatchPoisonedSessionRecovery(inflight, poisonedTarget.sessionId)) {
        const filePath = recoveryFilePathForSniff(latestSniff);
        args.log(
          `[poll] poisoned-session recovery: ${poisonedTarget.gezelId}/${poisonedTarget.sessionId.slice(0, 8)} last turn aborted; sending one direct repair turn${filePath ? ` for ${filePath}` : ''}`,
        );
        try {
          const abortTeaching = await lastAbortTeachingWarning(
            args.client,
            poisonedTarget.sessionId,
          );
          await args.client.sendChatMessage(poisonedTarget.gezelId, {
            projectId: poisonedTarget.projectId,
            message: buildPoisonedSessionRecoveryMessage({
              lastTurnError: poisonedTarget.lastTurnError,
              ...(abortTeaching ? { abortTeaching } : {}),
              filePath,
              sniff: latestSniff,
            }),
            ...(filePath ? { expectedDeliverable: { kind: 'file' as const, filePath } } : {}),
          });
          // Consume the one-shot only after dispatch succeeds. A transient
          // HTTP failure must not silently strand the trial with a poisoned
          // session that will never be retried.
          poisonedSessionRecovery.markAttempted(poisonedTarget, latestSniff ?? undefined);
          noteHarnessInterventionDelivered(ctx);
        } catch (err) {
          args.log(
            `[poll] poisoned-session recovery send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Capture progress fingerprint. Two-tier:
    //   - HARD digest moving = real progress (tool calls, workspace,
    //     sessions, sniff). Reset hard-clock.
    //   - SOFT digest moving = engine alive (above + token streams +
    //     slot updates). Reset soft-clock.
    // Trial dies when EITHER clock exceeds its timeout: hard catches
    // "model busy but not delivering" (20m default), soft catches
    // "daemon hung/dead" (5m default).
    try {
      const fp = await captureFingerprint(
        args.client,
        args.meesterId,
        latestSniff,
        args.daemonLogPath,
      );
      const sessionRunaway = runawaySessionFailure(fp.sessionCount);
      if (sessionRunaway) {
        args.log(`[poll] terminal: ${sessionRunaway.reason}`);
        return { success: false, ...sessionRunaway, ...finalSniffOf() };
      }
      const digest = digestFingerprint(fp);
      const daemonNote = fp.daemonActivity
        ? `daemon[src=${fp.daemonActivity.source}](turns=${fp.daemonActivity.turnStarts},tools=${fp.daemonActivity.toolCalls},slot=${fp.daemonActivity.slotUpdates},stream=${fp.daemonActivity.streamPulses}) `
        : '';
      if (digest.hard !== lastHardDigest) {
        const elapsedMs = Date.now() - lastHardChangeAt;
        args.log(
          `[poll] hard-progress: ${lastHardDigest} → ${digest.hard} after ${Math.round(elapsedMs / 1000)}s (workspaceProjects=${Object.keys(fp.workspace).length} sessions=${fp.sessionCount} ${daemonNote}sniff=${fp.sniffState ? `${fp.sniffState.score}/${fp.sniffState.bytes}B` : 'none'})`,
        );
        lastHardDigest = digest.hard;
        lastHardChangeAt = Date.now();
        // Progress is the proof a dispatched repair turn actually landed.
        poisonedSessionRecovery.confirmResponded();
        silentRecoveryNote = null;
      }
      if (digest.soft !== lastSoftDigest) {
        lastSoftDigest = digest.soft;
        lastSoftChangeAt = Date.now();
      }
      const hardStuckMs = Date.now() - lastHardChangeAt;
      const softStuckMs = Date.now() - lastSoftChangeAt;
      const lastHarnessIntervention = lastDeliveredHarnessIntervention(ctx);
      let harnessInterventionSettling = isHarnessInterventionSettling(lastHarnessIntervention);
      // An in-flight native render is legitimate non-LLM work: poking a
      // session mid-render would consume the one-shot nudges below for
      // nothing (the chat turn just queues behind the GPU lease), so
      // every nudge gate checks this flag. The retry-loop kill paths
      // further down defer on it too. Note the soft digest already
      // tracks sd-server log lines, so an actively-logging render keeps
      // softStuckMs near 0 on its own — this flag covers the gaps
      // between log lines and the nudge one-shots.
      //
      // Wedge bound: if a render crashes without its `generate_image
      // completed` line the flag sticks true (until the start line ages
      // out of the 16 MB log tail). That suppresses nudges and the
      // retry-loop paths, but the HARD watchdog and the trial ceiling
      // never defer on it, and the soft path below converts a silent
      // open render into an explicit `engine-hung` failure.
      const imageGenerationActive = fp.daemonActivity?.imageGenerationActive ?? false;
      // A recovery dispatched but never answered is the failure shape this
      // block exists to name. Probing in-flight is what separates "silent"
      // from "slow": at ~5 t/s a legitimate repair turn holds the slot for
      // minutes, and that turn IS in flight the whole time.
      const pendingRecoveries = poisonedSessionRecovery.unconfirmedRecoveries();
      const inflightTurns =
        softStuckMs >= reEngageThresholdMs ||
        pendingRecoveries.length > 0 ||
        (reEngageNudgeDeliveredAt !== null && hardStuckMs >= args.hardProgressTimeoutMs)
          ? await listInflightTurnsForWatchdog(args.client).catch(() => [])
          : [];
      const silentSummary = summarizeSilentRecoveries(
        selectSilentRecoveries(pendingRecoveries, inflightTurns),
      );
      silentRecoveryNote = silentSummary
        ? ` poisoned-session repair drew no response: ${silentSummary}`
        : null;
      if (silentSummary && Date.now() - silentRecoveryLoggedAt >= 60_000) {
        silentRecoveryLoggedAt = Date.now();
        args.log(
          `[poll] poisoned-session recovery unanswered: ${silentSummary} — repair turn dispatched, no turn in flight and no progress since; the session is not working on it`,
        );
      }
      const deferSoftForInflight = shouldDeferSoftWatchdog(inflightTurns, args.inflightDeferMs);
      if (deferSoftForInflight && Date.now() - inflightSoftDeferralLoggedAt >= 60_000) {
        inflightSoftDeferralLoggedAt = Date.now();
        args.log(
          `[poll] soft-watchdog deferred: ${summarizeInflightTurnsForLog(inflightTurns)} still mid-turn while soft digest is flat for ${Math.round(softStuckMs / 1000)}s; hard watchdog remains active`,
        );
      }

      // Pre-timeout re-engage: at 80% of the soft window, if the team
      // showed any activity earlier in the trial (hard digest moved at
      // least once after baseline), nudge once. The earlier gate
      // required sniff > 0 — too narrow: petshop iter2 hung
      // after generating an image but before writing HTML, sniff stayed
      // at 0, and the nudge skipped firing despite 104 daemon turns of
      // clear team activity. New rule: hard digest must have moved
      // after baseline (proves the team got started), then nudge.
      //
      // Target: prefer the most-recently-active downstream builder/
      // developer/voorman session over the meester. tictactoe iter5
      // showed the meester acknowledging "nothing has been
      // produced" but NOT relaying via `message_gezel` to the builder —
      // the builder kept waiting. Direct-dispatch to the downstream
      // gezel bypasses that relay failure. Falls back to meester when
      // no qualifying downstream session exists.
      // Annotate with every field the consumers below actually read.
      // The narrower { key, score, bytes } shape that used to sit here was
      // already a lie — buildReEngageNudge reads failReason — and it hid
      // deliverableMissing, the field that keeps the nudge from telling a
      // model its missing deliverable exists.
      const sniff: {
        key: string;
        score: number;
        bytes: number;
        failReason?: string;
        repairFilePath?: string;
        deliverableMissing?: boolean;
      } | null = latestSniff;
      const hadAnyProgress = lastHardChangeAt > startedAt + 5000;
      if (
        !deferSoftForInflight &&
        !imageGenerationActive &&
        !harnessInterventionSettling &&
        !reEngageNudgeAttempted &&
        softStuckMs >= reEngageThresholdMs &&
        hadAnyProgress
      ) {
        reEngageNudgeAttempted = true;
        const sniffNote = sniff
          ? `sniff=${sniff.score}/${sniff.bytes}B`
          : 'sniff=none (team active but no recognized artifact yet)';
        const reEngagePlan = buildReEngageNudge({ sniff, downstream: true });
        const downstream = await pickReEngageTarget(args.client, args.meesterId, {
          preferWritableRole: Boolean(reEngagePlan.filePath),
        }).catch(() => null);
        const targetId = downstream?.gezelId ?? args.meesterId;
        const targetLabel = downstream
          ? `${downstream.role ?? 'gezel'} ${downstream.gezelId.slice(0, 8)}`
          : 'meester';
        args.log(
          `[poll] re-engage nudge: chat idle for ${Math.round(softStuckMs / 1000)}s, ${sniffNote}; poking ${targetLabel} before soft-timeout fires`,
        );
        try {
          const { text: nudge, filePath } = buildReEngageNudge({
            sniff,
            downstream: downstream !== null,
          });
          if (downstream) {
            await args.client.messageGezel(targetId, {
              fromGezelId: args.meesterId,
              text: nudge,
              suppressReply: true,
              projectId: downstream.projectId,
              ...attachableDeliverable(filePath, downstream.role, args.log),
            });
          } else {
            await args.client.sendChatMessage(targetId, {
              message: nudge,
              projectId: 'default',
            });
          }
          reEngageNudgeDelivered = true;
          reEngageNudgeDeliveredAt = Date.now();
          reEngageTargetGezelId = targetId;
          noteHarnessInterventionDelivered(ctx, reEngageNudgeDeliveredAt);
          harnessInterventionSettling = true;
        } catch (err) {
          args.log(`[poll] re-engage nudge send failed (non-fatal): ${describeSendFailure(err)}`);
        }
        // Don't reset clocks — if the nudge produces real activity,
        // the next fingerprint cycle will move them naturally. If it
        // doesn't, the soft timeout still fires on schedule.
      }

      if (!deferSoftForInflight && softStuckMs >= args.softProgressTimeoutMs) {
        // Distinguish chat-stalled (gezeld idle, llama-server reachable
        // but receiving no work) from engine-hung (daemon unreachable).
        // captureFingerprint just succeeded above, so gezeld is alive.
        // A true engine-hung manifests as captureFingerprint throwing
        // for the whole soft window; if we got here, the chat manager
        // simply stopped issuing turns — petshop case.
        const stallSeconds = Math.round(softStuckMs / 1000);
        const nudgeNote = reEngageNudgeDelivered
          ? ' (re-engage nudge was sent and ignored)'
          : reEngageNudgeAttempted
            ? ' (re-engage nudge could not be delivered — the model never saw it)'
            : '';
        // An active render normally keeps the soft digest moving via
        // sd-server log lines; if we got here WITH a render open
        // (started, never completed) the image engine wedged mid-job.
        // Label it as such — infra failure, not a model chat stall —
        // so failure accounting doesn't blame the model.
        if (imageGenerationActive) {
          args.log(
            `[poll] no-progress (soft): image render in flight but sd-server logged nothing for ${stallSeconds}s — engine wedged mid-render; failing trial`,
          );
          return {
            success: false,
            reason: `image render wedged: generate_image started but sd-server produced no output for ${stallSeconds}s (soft digest stuck at ${digest.soft})`,
            failureMode: 'engine-hung',
            ...finalSniffOf(),
          };
        }
        const telemetry = await args.client.listSessionTelemetry().catch(() => null);
        const preProvider = describePreProviderStall(telemetry?.sessions);
        if (preProvider) {
          args.log(`[poll] no-progress (soft): ${preProvider}; failing trial as infra`);
          return {
            success: false,
            reason: `${preProvider} for ${stallSeconds}s (soft digest stuck at ${digest.soft})`,
            failureMode: 'chat-stalled',
            ...finalSniffOf(),
          };
        }
        args.log(
          `[poll] no-progress (soft): no engine activity for ${stallSeconds}s (threshold=${Math.round(args.softProgressTimeoutMs / 1000)}s); chat stalled${nudgeNote} — failing trial`,
        );
        return {
          success: false,
          reason: `chat stalled for ${stallSeconds}s — daemon reachable but issuing no model turns (soft digest stuck at ${digest.soft})${nudgeNote}`,
          failureMode: 'chat-stalled',
          ...finalSniffOf(),
        };
      }
      if (hardStuckMs >= args.hardProgressTimeoutMs) {
        const deferHardForReEngage = shouldDeferHardWatchdogForReEngage({
          deliveredAt: reEngageNudgeDeliveredAt,
          targetGezelId: reEngageTargetGezelId,
          inflightTurns,
          now: Date.now(),
        });
        if (deferHardForReEngage) {
          if (Date.now() - inflightHardReEngageDeferralLoggedAt >= 60_000) {
            inflightHardReEngageDeferralLoggedAt = Date.now();
            args.log(
              `[poll] hard-watchdog deferred: harness re-engage target is still mid-turn (${summarizeInflightTurnsForLog(inflightTurns)}); granting that dispatched recovery one bounded completion window`,
            );
          }
        } else {
          // This watchdog catches two opposite shapes, and naming the wrong one
          // sends triage after a slow model when the real fault is a session
          // that stopped responding. The soft clock is the discriminator: it
          // tracks token streams and slot updates, so a flat soft clock means
          // the engine is issuing nothing at all. Wild-caught on
          // conflict-synthesis / qwen3.6-27b-q8 (2026-08-05), where a chat idle
          // for 722s was reported as "model busy but not delivering".
          const shape = hardStallShape(softStuckMs);
          args.log(
            `[poll] no-progress (hard): no real progress for ${Math.round(hardStuckMs / 1000)}s (threshold=${Math.round(args.hardProgressTimeoutMs / 1000)}s); ${shape}${silentRecoveryNote ?? ''} — failing trial`,
          );
          return {
            success: false,
            reason: `no real progress for ${Math.round(hardStuckMs / 1000)}s — ${shape} (hard digest stuck at ${digest.hard})${silentRecoveryNote ?? ''}`,
            failureMode: 'model-stuck',
            ...finalSniffOf(),
          };
        }
      }

      // Retry-loop guard. Two trip paths — see the constants block
      // above. Both require sniff to be non-null (we only guard
      // against "produced an artifact but can't close it"; the
      // "no artifact yet" case is the hard-progress watchdog).
      const currentToolCalls = fp.daemonActivity?.toolCalls ?? 0;
      const currentWriteCalls = fp.daemonActivity?.writeCalls ?? 0;
      const currentPathSignature = workspacePathSignature(fp.workspace);
      const currentTurnStarts = fp.daemonActivity?.turnStarts ?? 0;
      // Watchdog key tracks success-relevant movement only. Byte churn
      // with the same sniff score is exactly the stubborn-rewrite loop
      // this guard is meant to catch; runtime assertion counters still
      // advance the key for trials that pass sniff and are iterating on
      // browser checks.
      const currentSniffKey = retryLoopSniffKey(latestSniff);
      if (currentSniffKey !== sniffPlateauKey) {
        sniffPlateauKey = currentSniffKey;
        sniffPlateauStartedAt = Date.now();
        sniffPlateauStartingToolCalls = currentToolCalls;
        sniffPlateauStartingWriteCalls = currentWriteCalls;
        sniffPlateauStartingTurnStarts = currentTurnStarts;
        sniffPlateauStartingPathSignature = currentPathSignature;
        retryLoopGrantedNudgeStages.clear();
      } else if (currentSniffKey !== 'none') {
        const plateauMs = Date.now() - sniffPlateauStartedAt;
        const toolCallsInPlateau = currentToolCalls - sniffPlateauStartingToolCalls;
        const writeCallsInPlateau = currentWriteCalls - sniffPlateauStartingWriteCalls;
        const turnStartsInPlateau = currentTurnStarts - sniffPlateauStartingTurnStarts;

        // Pre-trigger direct-dispatch nudge. When the plateau is 80% of
        // the way to firing the fast-path retry-loop, pick the most-
        // recently-active downstream session and tell it to stop reading
        // and write the deliverable. Catches plan-but-never-execute
        // without waiting for the harness to give up — squisq-review iter2
        // (qwen3.6) hit the retry-loop at 19 tool calls, all read_file/
        // grep_artifact, never a write_artifact for the actual review.
        // Same target-picking logic as the soft-timeout nudge, different
        // trigger condition. One-shot, independent of that nudge's flag.
        //
        // The message is state-aware. When the sniff already SCORED
        // (score > 0) the deliverable file exists and merely misses the
        // bar — telling the model to "create the file, a stub is better
        // than nothing" is actively misleading: it already wrote the
        // file and will just re-assert "I wrote it." gemma4-31b
        // squisq-review wrote a complete review at 4806 B —
        // all four sections + 5 citations, only 194 B under the 5 KB
        // floor — then got the "create the file" nudge and never expanded
        // it. The scored branch instead tells it to EXPAND/FIX the
        // existing file in place.
        const artifactExists = sniffArtifactHasScored(latestSniff, scoredSniffKeys);
        if (
          !retryLoopNudgeAttempted &&
          !imageGenerationActive &&
          !harnessInterventionSettling &&
          plateauMs >= RETRY_LOOP_NUDGE_WINDOW_MS &&
          toolCallsInPlateau >= RETRY_LOOP_NUDGE_TOOL_THRESHOLD
        ) {
          retryLoopNudgeAttempted = true;
          const downstream = await pickReEngageTarget(args.client, args.meesterId, {
            preferWritableRole: Boolean(recoveryFilePathForSniff(latestSniff)),
          }).catch(() => null);
          const targetId = downstream?.gezelId ?? args.meesterId;
          const targetLabel = downstream
            ? `${downstream.role ?? 'gezel'} ${downstream.gezelId.slice(0, 8)}`
            : 'meester';
          args.log(
            `[poll] retry-loop nudge (${artifactExists ? 'expand-existing' : 'create-file'}): sniff "${currentSniffKey}" plateaued ${Math.round(plateauMs / 60_000)}m with ${toolCallsInPlateau} tool calls; poking ${targetLabel} before retry-loop fires`,
          );
          try {
            const filePath = recoveryFilePathForSniff(latestSniff);
            const filePathClause = filePath ? ` \`${filePath}\`` : '';
            const writeCall = formatImmediateWriteFileCall(filePath);
            const nudge = artifactExists
              ? `Direct kick from the eval harness: your deliverable file${filePathClause} EXISTS but still fails the latest \`[scenario check]\`. Treat that check like a failing test: fix the specific error it names, preserve working behavior, and make the smallest targeted code/content edit that clears the gate. Do NOT recreate the file from scratch and do NOT reply that you already wrote it. If the check names a runtime/command failure, repair the file that caused it and verify with the available execution tool when practical. Your next tool call must be an edit (\`replace_in_file\`, \`append_to_file\`, \`apply_patch\`, or \`write_file\`); do not call more read-only tools until after that edit.`
              : `Direct kick from the eval harness: you've been reading and exploring for a while but the deliverable file hasn't reached its expected path yet${filePath ? ` (\`${filePath}\`)` : ''}. Stop reading. Do not end your turn until \`write_file\` has created the workspace file. Your next tool call MUST be \`${writeCall}\` creating the actual deliverable file${filePath ? ` at \`${filePath}\`` : ' (e.g. `review.md`, `index.html`)'} with whatever you can write now — a stub is better than nothing. You can refine it on the next turn. Do not use \`write_artifact\` for source or app files, and do not call any more read-only tools until the workspace file exists.`;
            if (downstream) {
              await args.client.messageGezel(targetId, {
                fromGezelId: args.meesterId,
                text: nudge,
                suppressReply: true,
                projectId: downstream.projectId,
                ...attachableDeliverable(filePath, downstream.role, args.log),
              });
            } else {
              await args.client.sendChatMessage(targetId, {
                message: nudge,
                projectId: 'default',
              });
            }
            retryLoopNudgeDelivered = true;
            noteHarnessInterventionDelivered(ctx);
          } catch (err) {
            args.log(
              `[poll] retry-loop nudge send failed (non-fatal): ${describeSendFailure(err)}`,
            );
          }
        }

        // The FAST path only applies once an artifact has actually
        // SCORED (score > 0) — its purpose is catching a stubborn-rewrite
        // loop on a file that already exists but keeps failing the bar
        // (failure mode A). A score-0 sniff means the deliverable file
        // isn't written yet: e.g. squisq-review's reviewer is still
        // reading source to gather its citations, with review.md not
        // created. That is the hard-progress watchdog's territory ("no
        // artifact yet"), NOT a stuck artifact — exactly what the
        // constants-block comment above intends by "both require a
        // non-null sniff." But a non-null sniff at score 0 slipped
        // through that gate. Without this check, the 8-min fast path
        // guillotines a legitimate research phase mid-stride: gemma4-31b
        // squisq-review lost 2/3 trials this way — each
        // killed at exactly 8m with 15 genuine read_file calls and
        // review.md never yet written, while the only surviving trial
        // wrote it at ~9m.
        //
        // The LONG path (12m) is the backstop for a genuinely-stuck team,
        // but it ALSO must distinguish "idled after a nudge" (mode B —
        // kill it) from "still actively reading toward the first write"
        // (slow dense model — leave it to the maxDuration ceiling). The
        // discriminator is tool-call activity during the plateau: an idled
        // team has gone quiet (≤RETRY_LOOP_LONG_IDLE_TOOL_MAX new calls),
        // while a reviewer gathering citations keeps climbing. Without the
        // idle gate the LONG path guillotined gemma4-31b squisq-review
        // at 12m with 12+ climbing read_file calls — the exact
        // research the ≥5-citation scenario requires, and well before the
        // prompt's own "start writing around 25m" mark.
        const artifactHasScored = sniffArtifactHasScored(latestSniff, scoredSniffKeys);
        const teamIdleInPlateau = toolCallsInPlateau <= RETRY_LOOP_LONG_IDLE_TOOL_MAX;
        // A slow local model can spend minutes streaming one tool call's
        // arguments before the completed call increments toolCalls. Treat
        // recent soft progress (stream pulses, slot updates) as non-idle;
        // the hard watchdog still catches true "busy but never delivers".
        const engineRecentlyActive = softStuckMs < 60_000;
        // FAST — stubborn rewriter: scored artifact re-emitted (≥N write
        // calls) without improving. Gated on writes so read-only research
        // doesn't trip it.
        const fastPathTripped = retryLoopFastPathTripped({
          artifactHasScored,
          plateauMs,
          writeCallsInPlateau,
          startingPathSignature: sniffPlateauStartingPathSignature,
          currentPathSignature,
          windowMs: RETRY_LOOP_FAST_WINDOW_MS,
          writeThreshold: RETRY_LOOP_FAST_WRITE_THRESHOLD,
        });
        // LONG — idled team: went quiet regardless of artifact state.
        const longPathTripped =
          teamIdleInPlateau && !engineRecentlyActive && plateauMs >= RETRY_LOOP_LONG_WINDOW_MS;
        // STALL — scored artifact not improving for a generous window
        // despite activity (read-forever-never-complete).
        const stallPathTripped = artifactHasScored && plateauMs >= RETRY_LOOP_STALL_WINDOW_MS;
        // CHATTER — scored artifact not improving while the model keeps
        // taking turns without writing anything.
        const writeCounterHasEverMoved = currentWriteCalls > 0;
        const chatterPathTripped = retryLoopChatterTripped({
          artifactHasScored,
          writeCounterHasEverMoved,
          plateauMs,
          writeCallsInPlateau,
          turnStartsInPlateau,
          windowMs: RETRY_LOOP_CHATTER_WINDOW_MS,
          turnThreshold: RETRY_LOOP_CHATTER_TURN_THRESHOLD,
        });
        if (
          imageGenerationActive &&
          (fastPathTripped || longPathTripped || stallPathTripped || chatterPathTripped) &&
          Date.now() - imageRetryLoopDeferralLoggedAt >= 60_000
        ) {
          imageRetryLoopDeferralLoggedAt = Date.now();
          args.log(
            `[poll] retry-loop deferred: sniff "${currentSniffKey}" plateaued ${Math.round(plateauMs / 60_000)}m, but native image generation is active; waiting for render completion before judging missing image asset`,
          );
        }
        if (fastPathTripped || longPathTripped || stallPathTripped || chatterPathTripped) {
          if (imageGenerationActive) continue;
          const lastNudge = lastDeliveredSniffNudge(ctx);
          if (
            shouldDeferRetryLoopForRecentEscalation({
              lastNudge,
              grantedStages: retryLoopGrantedNudgeStages,
              now: Date.now(),
            })
          ) {
            retryLoopGrantedNudgeStages.add(lastNudge!.stage);
            args.log(
              `[poll] retry-loop deferred: sniff "${currentSniffKey}" plateaued ${Math.round(plateauMs / 60_000)}m, but a stage-${lastNudge!.stage} scenario nudge landed ${Math.round((Date.now() - lastNudge!.at) / 1000)}s ago — granting one response window (granted stages: ${[...retryLoopGrantedNudgeStages].sort().join(',')})`,
            );
            sniffPlateauStartedAt = Date.now();
            sniffPlateauStartingToolCalls = currentToolCalls;
            sniffPlateauStartingWriteCalls = currentWriteCalls;
            sniffPlateauStartingTurnStarts = currentTurnStarts;
            continue;
          }
          // STALL joins LONG here: both are wall-clock-only triggers, so both
          // have to check whether a turn is still running before calling it
          // stuck. FAST and CHATTER stay out — they are count-based and hold
          // regardless of decode speed. See shouldDeferRetryLoopForInflight.
          const shouldWaitForInflightTurns =
            (longPathTripped || stallPathTripped) && !fastPathTripped && !chatterPathTripped;
          const retryLoopInflightTurns = shouldWaitForInflightTurns
            ? await listInflightTurnsForWatchdog(args.client).catch(() => [])
            : [];
          if (
            shouldDeferRetryLoopForInflight({
              fastPathTripped,
              longPathTripped,
              stallPathTripped,
              chatterPathTripped,
              inflightTurns: retryLoopInflightTurns,
              ...(args.inflightDeferMs === undefined
                ? {}
                : { inflightDeferMs: args.inflightDeferMs }),
            })
          ) {
            if (Date.now() - inflightRetryLoopDeferralLoggedAt >= 60_000) {
              inflightRetryLoopDeferralLoggedAt = Date.now();
              args.log(
                `[poll] retry-loop deferred: sniff "${currentSniffKey}" plateaued ${Math.round(plateauMs / 60_000)}m, but ${summarizeInflightTurnsForLog(retryLoopInflightTurns)} is still mid-turn; hard watchdog remains active`,
              );
            }
            // Give the active turn and any queued scenario feedback a real
            // response window after this deferral. Otherwise the long-path
            // check can fire on the very next poll if the model yields a few
            // seconds later, before the newly queued repair message is seen.
            sniffPlateauStartedAt = Date.now();
            sniffPlateauStartingToolCalls = currentToolCalls;
            sniffPlateauStartingWriteCalls = currentWriteCalls;
            sniffPlateauStartingTurnStarts = currentTurnStarts;
            continue;
          }
          const plateauMin = Math.round(plateauMs / 60_000);
          const path = fastPathTripped
            ? 'fast'
            : chatterPathTripped
              ? 'chatter'
              : longPathTripped
                ? 'long'
                : 'stall';
          const detail = fastPathTripped
            ? `${writeCallsInPlateau} re-writes (${toolCallsInPlateau} tool calls) without sniff movement`
            : chatterPathTripped
              ? `${turnStartsInPlateau} turns without artifact writes (${toolCallsInPlateau} tool calls) after scoring artifact`
              : longPathTripped
                ? `team idle (${toolCallsInPlateau} new tool calls) with no sniff movement for ${plateauMin}m`
                : `artifact scored but stalled ${plateauMin}m despite ${toolCallsInPlateau} tool calls${
                    writeCounterHasEverMoved
                      ? ` (${writeCallsInPlateau} re-writes)`
                      : args.writeCounterTrustworthy
                        ? ' (and wrote no files at all)'
                        : ' (write counter blind for this provider — re-write count unknown)'
                  }`;
          const nudgeNote = retryLoopNudgeDelivered
            ? ' (retry-loop nudge was sent and ignored)'
            : retryLoopNudgeAttempted
              ? ' (retry-loop nudge could not be delivered — the model never saw it)'
              : '';
          args.log(
            `[poll] retry-loop (${path}): sniff "${currentSniffKey}" stuck ${plateauMin}m — ${detail}${nudgeNote}; failing trial`,
          );
          return {
            success: false,
            reason: `retry loop (${path}-path): sniff "${currentSniffKey}" stuck for ${plateauMin}m — ${detail}. Artifact produced but never reached success${nudgeNote}.`,
            failureMode: 'model-stuck',
            ...finalSniffOf(),
          };
        }
      }
    } catch (err) {
      // Fingerprint capture failures shouldn't kill the trial — just
      // log and continue; the next cycle will retry.
      args.log(
        `[poll] fingerprint capture threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Sleep in small steps so an abort fires within ~250ms instead of
    // up to the full poll interval.
    const sleepDeadline = Date.now() + args.pollIntervalMs;
    while (Date.now() < sleepDeadline) {
      if (args.signal?.aborted) break;
      await wait(Math.min(250, sleepDeadline - Date.now()));
    }
  }
  args.log(`[poll] hard ceiling reached after ${args.maxDurationMs}ms`);
  // Final-check before declaring failure: a deliverable that landed in
  // the last poll window (e.g. an image render that finished
  // milliseconds before the ceiling fired) would otherwise be wasted.
  // The codex-cli matrix had a tool-routing-image trial
  // where the sunset.png landed at trial-second 484/480 and the success
  // check was 5 s stale; this final check would have promoted it.
  try {
    const finalVerdict = await Promise.race([
      scenario.successCheck(ctx),
      // Bound the final check so a hung check doesn't extend the
      // trial. 5 s mirrors the default poll interval.
      wait(5_000).then(() => ({ done: false }) as SuccessCheckResult),
    ]);
    if (finalVerdict.done && finalVerdict.success) {
      args.log(`[poll] terminal (post-ceiling check): success=true reason=${finalVerdict.reason}`);
      return { success: true, reason: finalVerdict.reason };
    }
  } catch (err) {
    args.log(
      `[poll] post-ceiling final-check threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Honest reason text: the old fixed "forward progress kept happening"
  // wording was unconditional, so a trial whose maxDuration was SHORTER
  // than the hard-progress watchdog could stall and still be reported as
  // progressing. Report what actually happened.
  const ceilingExtendedMs = hardDeadline - (startedAt + args.maxDurationMs);
  const sinceHardAtEndS = Math.round((Date.now() - lastHardChangeAt) / 1000);
  return {
    success: false,
    reason: `hit hard ceiling (${args.maxDurationMs}ms${ceilingExtendedMs > 0 ? ` + ${Math.round(ceilingExtendedMs / 60_000)}m progress extensions` : ''}) — last hard progress ${sinceHardAtEndS}s before the end; the deliverable never closed`,
    failureMode: 'timeout',
    ...finalSniffOf(),
  };
}

export async function captureFinalState(args: {
  client: GezelClient;
  trialHome: string;
  runDir: string;
  log: (line: string) => void;
  /**
   * Scopes the incomplete-transcript warning. Capture runs the instant
   * `successCheck` returns done, which is normally mid-turn on a PASS as
   * much as a FAIL — so warning unconditionally fired on 100% of trials and
   * became noise that would hide the case it exists for. The warning's only
   * job is to stop a triager concluding "the model did nothing" from an
   * empty transcript, and nobody triages a pass.
   */
  trialFailed?: boolean;
}): Promise<void> {
  const { client, trialHome, runDir, log } = args;

  // Dump every chat session via the API — gives us the same JSON the UI
  // would see, with all messages, tool calls, and provider state.
  await mkdir(join(runDir, 'sessions'), { recursive: true });
  const persistedBySession: Array<{ id: string; gezelId?: string; toolCallsPersisted: number }> =
    [];
  try {
    const { sessions } = await client.listChatSessions();
    for (const summary of sessions) {
      try {
        const full = await client.getChatSession(summary.id);
        const persistedToolCalls = (
          (full as { messages?: Array<{ toolCalls?: unknown[] }> }).messages ?? []
        ).reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0);
        persistedBySession.push({
          id: summary.id,
          ...(summary.gezelId ? { gezelId: summary.gezelId } : {}),
          toolCallsPersisted: persistedToolCalls,
        });
        await writeFile(
          join(runDir, 'sessions', `${summary.gezelId}--${summary.id}.json`),
          JSON.stringify(full, null, 2),
        );
      } catch (err) {
        log(
          `[capture] session ${summary.id} dump failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(`[capture] dumped ${sessions.length} session(s)`);
  } catch (err) {
    log(`[capture] listChatSessions failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const telemetry = await client.listSessionTelemetry();
    await writeFile(join(runDir, 'session-telemetry.json'), JSON.stringify(telemetry, null, 2));
    log(`[capture] snapshotted telemetry for ${telemetry.sessions.length} session(s)`);
    // A trial killed mid-turn persists the kickoff and nothing else, while
    // the tool calls that turn already made stay invisible — and the files
    // they wrote remain on disk. Say so, or the transcript reads as "the
    // model did nothing".
    const gaps = incompleteTranscripts(persistedBySession, telemetry.sessions);
    if (gaps.length > 0 && args.trialFailed !== false) {
      const detail = gaps
        .map((g) => `${g.gezelId ?? g.id}: ${g.persisted} persisted vs ${g.recorded} recorded`)
        .join('; ');
      log(
        `[capture] INCOMPLETE TRANSCRIPT for ${gaps.length} session(s) — ${detail}. Assistant turns commit at turn END, so a mid-turn termination loses them. Triage from session-telemetry.json and daemon.log, NOT from the empty transcript.`,
      );
    }
  } catch (err) {
    log(`[capture] session telemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Snapshot every project's artifacts/ AND workspace/ dir, plus the
  // per-project history.jsonl. Using fs.cp directly is much cheaper than
  // walking the list APIs + fetching blobs over HTTP. The developer
  // template writes to workspace/ via write_file by default — without a
  // workspace snapshot, "Vivian wrote a file" claims can't be verified.
  try {
    const { projects } = await client.listProjects();
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await mkdir(join(runDir, 'workspace'), { recursive: true });
    await mkdir(join(runDir, 'project-history'), { recursive: true });
    for (const project of projects) {
      const projectDir = join(trialHome, 'projects', project.id);

      const artifactsSrc = join(projectDir, 'artifacts');
      if (existsSync(artifactsSrc)) {
        await cp(artifactsSrc, join(runDir, 'artifacts', project.id), { recursive: true });
      }

      const workspaceSrc = join(projectDir, 'workspace');
      if (existsSync(workspaceSrc)) {
        await cp(workspaceSrc, join(runDir, 'workspace', project.id), { recursive: true });
      }

      const historySrc = join(projectDir, 'history.jsonl');
      if (existsSync(historySrc)) {
        await cp(historySrc, join(runDir, 'project-history', `${project.id}.jsonl`));
      }
    }
    log(`[capture] snapshotted artifacts/workspace/history for ${projects.length} project(s)`);
  } catch (err) {
    log(`[capture] project snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Keurmeester intervention case records (supervisor-arm trials only —
  // the dir doesn't exist otherwise). Raw JSONL is the postmortem's
  // source for consult counts, action distribution, and time-to-unblock.
  try {
    const keurmeesterSrc = join(trialHome, 'keurmeester');
    if (existsSync(keurmeesterSrc)) {
      await cp(keurmeesterSrc, join(runDir, 'keurmeester'), { recursive: true });
      log('[capture] snapshotted keurmeester case records');
    }
  } catch (err) {
    log(
      `[capture] keurmeester snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Structured native-engine exits are written separately from the rolling
  // daemon log so a crash early in a long trial cannot fall out of the log
  // tail used at finalize. They contain launch metadata and panic signatures,
  // never prompts or tool arguments.
  try {
    const nativeIncidentsSrc = join(trialHome, 'logs', 'native-incidents.jsonl');
    if (existsSync(nativeIncidentsSrc)) {
      await cp(nativeIncidentsSrc, join(runDir, 'native-incidents.jsonl'));
      log('[capture] snapshotted native engine incidents');
    }
  } catch (err) {
    log(
      `[capture] native incident snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Dump the high-level lists too — quick to read in a postmortem
  // without spinning the daemon back up.
  try {
    const [gezels, projects, tasks, config] = await Promise.all([
      client.listGezels(),
      client.listProjects(),
      client.listTasks(),
      client.getConfig(),
    ]);
    await writeFile(
      join(runDir, 'state.json'),
      JSON.stringify({ gezels, projects, tasks, config }, null, 2),
    );
  } catch (err) {
    log(`[capture] state.json failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface InflightTurnSnapshot {
  sessionId: string;
  gezelId: string;
  projectId: string;
  elapsedMs: number;
}

interface WatchdogSessionSnapshot {
  id: string;
  gezelId: string;
  projectId: string;
  lastActivityAt?: string;
  archived?: boolean;
  lastTurnError?: string;
}

export interface PoisonedSessionSnapshot {
  sessionId: string;
  gezelId: string;
  projectId: string;
  lastActivityAt?: string;
  lastTurnError: string;
}

export function canDispatchPoisonedSessionRecovery(
  inflightTurns: readonly InflightTurnSnapshot[] | null,
  sessionId: string,
): boolean {
  return inflightTurns !== null && !inflightTurns.some((turn) => turn.sessionId === sessionId);
}

async function listInflightTurnsForWatchdog(client: GezelClient): Promise<InflightTurnSnapshot[]> {
  const { inflight } = await client.listInflightTurns();
  return inflight ?? [];
}

async function listPoisonedSessionsForWatchdog(
  client: GezelClient,
  meesterId: string,
): Promise<PoisonedSessionSnapshot[]> {
  const { sessions } = await client.listChatSessions();
  return pickPoisonedSessionsForRecovery(sessions ?? [], meesterId);
}

export function pickPoisonedSessionsForRecovery(
  sessions: WatchdogSessionSnapshot[],
  meesterId: string,
): PoisonedSessionSnapshot[] {
  const tsOf = (session: WatchdogSessionSnapshot): number => {
    if (!session.lastActivityAt) return 0;
    const ts = Date.parse(session.lastActivityAt);
    return Number.isFinite(ts) ? ts : 0;
  };
  return sessions
    .filter(
      (session) =>
        !session.archived &&
        session.gezelId &&
        session.gezelId !== meesterId &&
        session.projectId &&
        typeof session.lastTurnError === 'string' &&
        session.lastTurnError.trim().length > 0,
    )
    .sort((a, b) => tsOf(b) - tsOf(a))
    .map((session) => ({
      sessionId: session.id,
      gezelId: session.gezelId,
      projectId: session.projectId,
      ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
      lastTurnError: session.lastTurnError!.trim(),
    }));
}

/**
 * Tracks the poisoned-session recovery lifecycle. A strictly higher sniff
 * score starts a fresh recovery checkpoint. Within one score, at most one
 * semantic-progress re-arm is allowed after the first recovery, and it
 * requires both a changed byte count (mutation evidence) and a changed
 * normalized validation failure. This admits a real repair that exposes the
 * next failing assertion without allowing byte churn or timing-only output
 * changes to loop forever.
 *
 * A repeated poison is observable after the session disappeared from the
 * poisoned list (the recovery cleared it), reports a different error, or has
 * newer session activity after dispatch. That last discriminator matters when
 * consecutive provider turns abort with identical stable error text. The
 * runner's in-flight check still defers termination while the newer turn runs.
 */
export interface PoisonedRecoveryCheckpoint {
  score?: number;
  bytes?: number;
  failReason?: string;
}

const MAX_RECOVERIES_PER_SCORE_CHECKPOINT = 2;

export function poisonedRecoveryFailureFingerprint(failReason?: string): string | null {
  const normalized = (failReason ?? '')
    // Test runners commonly vary only wall-clock timings between identical
    // failures. Those are not a new semantic validation result.
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '<duration>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized.slice(0, 4_000) : null;
}

/**
 * Grace period before a dispatched recovery that produced no in-flight turn is
 * called silent. A repair turn registers as in-flight the moment it starts, so
 * this only needs to cover dispatch + scheduling latency — it is NOT a decode
 * budget. Slow turns are handled by the in-flight check, not by waiting longer.
 */
export const POISONED_RECOVERY_RESPONSE_GRACE_MS = 120_000;

/**
 * A dispatched recovery that never draws a response is invisible today: the
 * session clears from the poisoned list, so {@link
 * PoisonedSessionRecoveryTracker.observe} filters it out, and the trial then
 * idles until the generic no-progress watchdog fires with an unrelated
 * explanation. Wild-caught on conflict-synthesis / qwen3.6-27b-q8 (2026-08-05):
 * the repair turn drew nothing, the chat sat idle 12 minutes, and the trial
 * died reporting "model busy but not delivering".
 */
export interface UnconfirmedRecovery {
  sessionId: string;
  gezelId: string;
  ageMs: number;
}

export class PoisonedSessionRecoveryTracker {
  private readonly attempts = new Map<
    string,
    {
      initialError: string;
      initialLastActivityAt: string | null;
      observedClear: boolean;
      scoreCheckpoint: number | null;
      bytesCheckpoint: number | null;
      failReasonFingerprint: string | null;
      gezelId: string;
      attemptedAtMs: number;
      confirmed: boolean;
    }
  >();
  private readonly recoveryCounts = new Map<
    string,
    { scoreCheckpoint: number | null; count: number }
  >();

  hasAttempted(sessionId: string): boolean {
    return this.attempts.has(sessionId);
  }

  markAttempted(
    session: PoisonedSessionSnapshot,
    checkpoint?: PoisonedRecoveryCheckpoint,
    nowMs: number = Date.now(),
  ): void {
    const scoreCheckpoint = finiteRecoveryCheckpointNumber(checkpoint?.score);
    const priorCount = this.recoveryCounts.get(session.sessionId);
    const count = priorCount?.scoreCheckpoint === scoreCheckpoint ? priorCount.count + 1 : 1;
    this.recoveryCounts.set(session.sessionId, { scoreCheckpoint, count });
    this.attempts.set(session.sessionId, {
      initialError: session.lastTurnError,
      initialLastActivityAt: session.lastActivityAt ?? null,
      observedClear: false,
      scoreCheckpoint,
      bytesCheckpoint: finiteRecoveryCheckpointNumber(checkpoint?.bytes),
      failReasonFingerprint: poisonedRecoveryFailureFingerprint(checkpoint?.failReason),
      gezelId: session.gezelId,
      attemptedAtMs: nowMs,
      confirmed: false,
    });
  }

  /**
   * Real progress after a dispatch proves the recovery landed. Called on every
   * hard-digest move, which is the same signal the watchdog treats as progress.
   */
  confirmResponded(): void {
    for (const attempt of this.attempts.values()) attempt.confirmed = true;
  }

  /**
   * Recoveries dispatched at least `graceMs` ago with no observed response.
   * The caller must exclude sessions with a turn in flight — a slow turn is
   * working, not silent.
   */
  unconfirmedRecoveries(
    nowMs: number = Date.now(),
    graceMs: number = POISONED_RECOVERY_RESPONSE_GRACE_MS,
  ): UnconfirmedRecovery[] {
    const out: UnconfirmedRecovery[] = [];
    for (const [sessionId, attempt] of this.attempts) {
      if (attempt.confirmed) continue;
      const ageMs = nowMs - attempt.attemptedAtMs;
      if (ageMs < graceMs) continue;
      out.push({ sessionId, gezelId: attempt.gezelId, ageMs });
    }
    return out;
  }

  observe(
    current: readonly PoisonedSessionSnapshot[],
    checkpoint?: PoisonedRecoveryCheckpoint,
  ): PoisonedSessionSnapshot[] {
    const currentScore = finiteRecoveryCheckpointNumber(checkpoint?.score);
    const currentBytes = finiteRecoveryCheckpointNumber(checkpoint?.bytes);
    const currentFailureFingerprint = poisonedRecoveryFailureFingerprint(checkpoint?.failReason);
    const byId = new Map(current.map((session) => [session.sessionId, session]));
    for (const [sessionId, attempt] of this.attempts) {
      if (
        currentScore !== null &&
        attempt.scoreCheckpoint !== null &&
        currentScore > attempt.scoreCheckpoint
      ) {
        this.attempts.delete(sessionId);
        this.recoveryCounts.set(sessionId, { scoreCheckpoint: currentScore, count: 0 });
        continue;
      }
      const recoveryCount = this.recoveryCounts.get(sessionId)?.count ?? 0;
      const sameScoreSemanticProgress =
        currentScore !== null &&
        currentScore === attempt.scoreCheckpoint &&
        currentBytes !== null &&
        attempt.bytesCheckpoint !== null &&
        currentBytes !== attempt.bytesCheckpoint &&
        currentFailureFingerprint !== null &&
        attempt.failReasonFingerprint !== null &&
        currentFailureFingerprint !== attempt.failReasonFingerprint &&
        recoveryCount < MAX_RECOVERIES_PER_SCORE_CHECKPOINT;
      if (sameScoreSemanticProgress) {
        this.attempts.delete(sessionId);
        continue;
      }
      if (!byId.has(sessionId)) attempt.observedClear = true;
    }
    return current.filter((session) => {
      const attempt = this.attempts.get(session.sessionId);
      const activityAdvanced =
        attempt !== undefined &&
        session.lastActivityAt !== undefined &&
        (attempt.initialLastActivityAt === null ||
          Date.parse(session.lastActivityAt) > Date.parse(attempt.initialLastActivityAt));
      return (
        attempt !== undefined &&
        (attempt.observedClear ||
          session.lastTurnError !== attempt.initialError ||
          activityAdvanced)
      );
    });
  }
}

export function repeatedPoisonedSessionFailure(session: PoisonedSessionSnapshot): {
  reason: string;
  failureMode: 'model-stuck';
} {
  const error = session.lastTurnError.replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    reason: `repair-aborted: ${session.gezelId}/${session.sessionId.slice(0, 8)} exhausted its bounded automatic recovery allowance at the current checked progress; last error: ${error}`,
    failureMode: 'model-stuck',
  };
}

/**
 * Which of the two shapes a hard-watchdog kill actually is. The soft clock is
 * the discriminator: it moves on any token stream or slot update, so flatness
 * means the engine is issuing nothing — an idle or dead session rather than a
 * working one. Naming the wrong shape sends triage after a slow model.
 */
export function hardStallShape(
  softStuckMs: number,
  idleThresholdMs: number = HARD_FAIL_IDLE_SOFT_THRESHOLD_MS,
): string {
  return softStuckMs >= idleThresholdMs
    ? `engine idle — no token stream or slot update for ${Math.round(softStuckMs / 1000)}s`
    : 'model busy but not delivering';
}

/**
 * Drop recoveries whose session has a turn in flight. That turn IS the
 * response, however slow it decodes — treating it as silence is the same
 * mistake as the 0.1.29 STALL false-fire, in a new place.
 */
export function selectSilentRecoveries(
  pending: readonly UnconfirmedRecovery[],
  inflightTurns: readonly InflightTurnSnapshot[],
): UnconfirmedRecovery[] {
  return pending.filter(
    (recovery) => !inflightTurns.some((turn) => turn.sessionId === recovery.sessionId),
  );
}

export function summarizeSilentRecoveries(silent: readonly UnconfirmedRecovery[]): string | null {
  if (silent.length === 0) return null;
  return silent
    .map(
      (recovery) =>
        `${recovery.gezelId}/${recovery.sessionId.slice(0, 8)} (${Math.round(recovery.ageMs / 1000)}s ago)`,
    )
    .join(', ');
}

export function shouldDeferSoftWatchdog(
  inflightTurns: InflightTurnSnapshot[],
  deferMs: number = WATCHDOG_INFLIGHT_DEFER_MS,
): boolean {
  return inflightTurns.some((turn) => turn.elapsedMs < deferMs);
}

/**
 * In-flight defer window for the retry-loop STALL path.
 *
 * The 4-min default was tuned on llama.cpp/CUDA hosts running small models,
 * where a turn is over in seconds. A 27B model at ~4.6 t/s is a different
 * regime: one repair turn that rewrites a 9 KB artifact decodes 3,000+ tokens
 * and legitimately holds the slot for 8-11 minutes. Under the 4-min cap such a
 * turn reads as "not deferrable" and the STALL path kills it mid-stream.
 *
 * Wild-caught on incident-postmortem / qwen3.6-27b-q8 (2026-08-01): the trial
 * was failed at 04:23:17 as "stalled 18m ... 0 re-writes" while the engine was
 * 2,275 tokens into a turn at 4.62 t/s that released 1.6 s later. Same failure
 * shape as {@link MLX_WATCHDOG_INFLIGHT_DEFER_MS}, different engine.
 *
 * 15 min clears realistic slow-model turns while staying well under the 45-min
 * HARD progress watchdog, which remains the backstop for a genuinely wedged
 * engine.
 */
const STALL_INFLIGHT_DEFER_MS = 15 * 60 * 1000;

/**
 * A re-engage turn is work the harness itself dispatched. Do not launch it
 * late in the hard-progress window and then kill the same actively decoding
 * target before it can produce a mutation. This is a one-shot, target-bound
 * grace, not a general "busy means progress" exemption: it ends as soon as
 * the target turn ends and is capped at the same slow-turn budget used by the
 * retry-loop STALL path.
 */
export function shouldDeferHardWatchdogForReEngage(args: {
  deliveredAt: number | null;
  targetGezelId: string | null;
  inflightTurns: InflightTurnSnapshot[];
  now?: number;
  graceMs?: number;
}): boolean {
  if (args.deliveredAt === null || args.targetGezelId === null) return false;
  const now = args.now ?? Date.now();
  const graceMs = args.graceMs ?? STALL_INFLIGHT_DEFER_MS;
  if (now - args.deliveredAt >= graceMs) return false;
  return args.inflightTurns.some(
    (turn) => turn.gezelId === args.targetGezelId && turn.elapsedMs < graceMs,
  );
}

/** Do not stack a generic watchdog nudge on a just-delivered scenario repair. */
export function isHarnessInterventionSettling(
  lastDeliveredAt: number | null,
  now = Date.now(),
): boolean {
  return lastDeliveredAt !== null && now - lastDeliveredAt < HARNESS_INTERVENTION_SETTLE_MS;
}

/**
 * Should a tripped retry-loop watchdog hold off because a turn is still
 * running?
 *
 * Only the wall-clock-only paths defer. FAST ("N re-writes without sniff
 * movement") and CHATTER ("N turn starts, no artifact write") both carry a
 * count component, so they stay throughput-invariant: a model that re-wrote
 * three times without moving the sniff is looping whether it decodes at 5 t/s
 * or 50. STALL is a pure elapsed-time plateau with no count component at all —
 * it cannot distinguish "wedged" from "slow", so it must ask.
 */
/**
 * One bounded plateau reset per delivered escalation rung. Count-based
 * retry-loop paths are throughput-invariant on purpose, but they must not
 * fire while the intervention they would be judged by is still landing:
 * on slow local models each sniff-feedback rung takes minutes to DELIVER
 * (the target is perpetually mid-turn), and plateau-validate run 3 died
 * exactly there — killed at 3 rewrites/8m with the handlers.ts nudge
 * delivered 3 minutes earlier and the next rung still queued. The grace
 * is intervention-based, not clock-based: each stage (0/1/2) earns at
 * most ONE reset per plateau window, so a model that ignores every rung
 * still dies after ≤3 extra windows.
 */
export function shouldDeferRetryLoopForRecentEscalation(args: {
  lastNudge: { at: number; stage: number } | null;
  grantedStages: ReadonlySet<number>;
  now: number;
  graceMs?: number;
}): boolean {
  if (!args.lastNudge) return false;
  if (args.grantedStages.has(args.lastNudge.stage)) return false;
  const grace = args.graceMs ?? RETRY_LOOP_ESCALATION_GRACE_MS;
  return args.now - args.lastNudge.at < grace;
}

const RETRY_LOOP_ESCALATION_GRACE_MS = 4 * 60_000;

export function shouldDeferRetryLoopForInflight(args: {
  fastPathTripped: boolean;
  longPathTripped: boolean;
  stallPathTripped: boolean;
  chatterPathTripped: boolean;
  inflightTurns: InflightTurnSnapshot[];
  inflightDeferMs?: number;
}): boolean {
  if (args.fastPathTripped || args.chatterPathTripped) return false;
  if (!args.longPathTripped && !args.stallPathTripped) return false;
  const base = args.inflightDeferMs ?? WATCHDOG_INFLIGHT_DEFER_MS;
  const deferMs = args.stallPathTripped ? Math.max(base, STALL_INFLIGHT_DEFER_MS) : base;
  return shouldDeferSoftWatchdog(args.inflightTurns, deferMs);
}

export function summarizeInflightTurnsForLog(inflightTurns: InflightTurnSnapshot[]): string {
  if (inflightTurns.length === 0) return 'no turns';
  const sorted = [...inflightTurns].sort((a, b) => b.elapsedMs - a.elapsedMs);
  const top = sorted[0]!;
  const seconds = Math.max(0, Math.round(top.elapsedMs / 1000));
  const suffix = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '';
  return `${top.gezelId}/${top.sessionId.slice(0, 8)} in ${top.projectId} for ${seconds}s${suffix}`;
}

/**
 * Pull the aborting guard's own teaching text off the poisoned session's
 * last `turn-aborted` message. The session-level `lastTurnError` is the
 * user-facing toast ("The model got stuck… Try sending your message again,
 * or rephrase your request") — advice for a human, useless to the gezel we
 * are about to re-drive. The guard that killed the turn wrote its
 * actionable version ("You already have what you need. Your next message
 * MUST start with a single action-tool call…") onto the aborted message's
 * `warnings`; wild-caught on ops-runbook-anomaly, where every recovery
 * nudge quoted the toast and every model re-died the same way.
 */
async function lastAbortTeachingWarning(
  client: GezelClient,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const full = await client.getChatSession(sessionId);
    for (let i = full.messages.length - 1; i >= 0; i--) {
      const m = full.messages[i]!;
      if (m.role !== 'assistant' || m.synthetic !== 'turn-aborted') continue;
      const teaching = (m.warnings ?? []).find((w) => typeof w === 'string' && w.trim().length > 0);
      return teaching ? teaching.replace(/\s+/g, ' ').trim().slice(0, 600) : undefined;
    }
  } catch {
    // Snapshot fetch is best-effort; the toast-based fallback still sends.
  }
  return undefined;
}

export function buildPoisonedSessionRecoveryMessage(args: {
  lastTurnError?: string;
  /** The aborting guard's teaching text — preferred over the toast. */
  abortTeaching?: string;
  filePath?: string | null;
  sniff?: {
    key: string;
    score: number;
    bytes: number;
    failReason?: string;
    repairFilePath?: string;
    runtimePassed?: number;
    runtimeFailed?: number;
  } | null;
}): string {
  const error = args.lastTurnError?.trim();
  const teaching = args.abortTeaching?.trim();
  const filePath = args.filePath ?? null;
  const sniff = args.sniff ?? null;
  const scoreLine = sniff
    ? `Latest scenario check: score ${sniff.score}, bytes ${sniff.bytes}${sniff.failReason ? `, failure: ${sniff.failReason}` : ''}.`
    : 'Latest scenario check has not identified a scored deliverable yet.';
  const taskGraphLine = taskGraphPoisonedSessionRecoveryLine(sniff?.failReason);
  // Strategy detection scans the teaching text too — the guard's version
  // names the failing tool where the toast often doesn't.
  const errorForStrategy = [error, teaching].filter(Boolean).join(' ');
  // Two shapes demand a strategy change away from line edits: the edit was
  // explicitly rejected, or the SAME edit call was repeated verbatim until
  // the repeat guard killed the turn (repeating it once more is the one
  // move guaranteed not to work).
  const explicitLineEditFailure =
    errorForStrategy.length > 0 &&
    /(?:\b(?:replace_lines|replace_in_file|apply_patch)\b.{0,160}\b(?:fail(?:ed|ure)?|reject(?:ed|ion)?|invalid|atomic|(?:same|exact|identical)\s+arguments|repeat(?:ed|ing)?)\b|\b(?:fail(?:ed|ure)?|reject(?:ed|ion)?|invalid|atomic)\b.{0,160}\b(?:replace_lines|replace_in_file|apply_patch)\b)/i.test(
      errorForStrategy,
    );
  const existingCheckedFile = !!filePath && !!sniff && sniff.bytes > 0;
  const editLine =
    taskGraphLine ??
    (filePath
      ? explicitLineEditFailure || !existingCheckedFile
        ? `Your next tool call should repair \`${filePath}\`. ${explicitLineEditFailure ? 'The prior line-based edit was explicitly rejected, so change strategy: ' : ''}use \`write_file\` to write a complete corrected version at exactly \`${filePath}\`.`
        : `Your next tool call should make the smallest targeted repair in \`${filePath}\` using \`replace_in_file\` or \`replace_lines\` for the latest concrete validator failure. Preserve the file's existing public exports, signatures, state shape, and already-passing behavior. If you need exact source text, read \`${filePath}\` once, then patch only the failing logic. Do not replace the complete file.`
      : 'Your next tool call should write or repair the requested workspace deliverable. Prefer `write_file` for recovery after a failed line-based edit.');
  const closingLine = taskGraphLine
    ? 'Do not answer only in prose. Make the named task-tool calls, then stop with a short status note.'
    : existingCheckedFile && !explicitLineEditFailure
      ? 'Do not answer only in prose. Make one concrete targeted workspace edit, then stop with a short status note.'
      : 'Do not answer only in prose. Do not retry the same malformed `replace_lines` or `replace_in_file` call. Make one concrete workspace edit, then stop with a short status note.';
  return [
    '[eval recovery]',
    'Your previous turn aborted, so the scheduler stopped automatic follow-up for this project.',
    teaching ? `Why the turn was stopped: ${teaching}` : error ? `Abort reason: ${error}` : null,
    scoreLine,
    editLine,
    closingLine,
  ]
    .filter((line): line is string => !!line)
    .join('\n');
}

function finiteRecoveryCheckpointNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function taskGraphPoisonedSessionRecoveryLine(failReason?: string): string | null {
  const reason = failReason ?? '';
  const ungated = reason.match(/draft\s+(\S+)\s+has ungated build steps:\s+(.+)$/i);
  if (!ungated) return null;
  const draftRef = ungated[1]!;
  const stepIds = ungated[2]!
    .split(',')
    .map((step) => step.trim().replace(/[.;:]$/, ''))
    .filter(Boolean);
  if (stepIds.length === 0) return null;
  const calls = stepIds
    .map(
      (stepId) =>
        `set_step_deliverable({ task: ${JSON.stringify(draftRef)}, stepId: ${JSON.stringify(stepId)}, path: "index.html", kind: "html-page" })`,
    )
    .join('\n');
  return [
    'This is a task-graph repair, not a workspace-file repair.',
    `Your next tool calls MUST attach gates to the existing ungated build steps on draft ${draftRef}:`,
    calls,
    'Do not call `set_task_status`, `activate_task`, `write_file`, `add_task_step`, or `message_gezel` for this recovery.',
  ].join('\n');
}

export function recoveryFilePathForSniff(
  sniff:
    | {
        key: string;
        failReason?: string;
        repairFilePath?: string;
      }
    | null
    | undefined,
): string | null {
  const explicitRepairPath = sniff?.repairFilePath?.trim();
  if (
    explicitRepairPath &&
    sniffKeyToWorkspaceFilePath(explicitRepairPath) === explicitRepairPath
  ) {
    return explicitRepairPath;
  }

  const reason = sniff?.failReason ?? '';
  if (
    /\bopenapi\.ya?ml\b|yaml-parses|openapi-3\.1|all-paths-present|schemas-named|auth-on-mutations/i.test(
      reason,
    )
  ) {
    return 'openapi.yaml';
  }
  if (/\bserver\.mjs\b|evaluator smoke|pagination\.|GET\s+\/books|GET\s+\/authors/i.test(reason)) {
    return 'server.mjs';
  }
  if (
    /\bcontract-test\.mjs\b|contract-test-passes|server port|fetch URLs|process\.exit|passed = false/i.test(
      reason,
    )
  ) {
    return 'contract-test.mjs';
  }
  if (/\bREADME\.md\b|readme-present/i.test(reason)) return 'README.md';
  const keyPath = sniffKeyToWorkspaceFilePath(sniff?.key);
  if (keyPath) return keyPath;
  return null;
}

function formatImmediateWriteFileCall(filePath: string | null): string {
  const path = filePath ? JSON.stringify(filePath) : '"<workspace-relative-file>"';
  return `write_file({ path: ${path}, content: <the full deliverable contents> })`;
}

export function buildReEngageNudge(args: {
  sniff: {
    key: string;
    score: number;
    bytes: number;
    failReason?: string;
    repairFilePath?: string;
    deliverableMissing?: boolean;
  } | null;
  downstream: boolean;
}): { text: string; filePath: string | null } {
  const { sniff, downstream } = args;
  const filePath = recoveryFilePathForSniff(sniff);
  // `bytes` is the PRIMARY deliverable's size on a multi-deliverable
  // scenario, so it can be large while the file this nudge NAMES does not
  // exist. Getting this wrong is not a cosmetic mislabel: the branch below
  // tells the model its file "EXISTS" and to "NOT recreate the file from
  // scratch" — forbidding the one action the gate requires, and then the
  // trial is failed for not taking it. craftbook-route-multi was told
  // exactly that about a 0-byte out/press-release.md, ten minutes before
  // it was failed for never writing out/press-release.md. Same class as
  // the McKinley Park incident in ADR 0001: an instruction the roster
  // cannot satisfy, delivered with full confidence.
  const artifactExists = sniff?.deliverableMissing === true ? false : (sniff?.bytes ?? 0) > 0;
  const failure = sniff?.failReason?.replace(/\s+/g, ' ').trim().slice(0, 700);

  if (artifactExists) {
    const path = filePath ? ` \`${filePath}\`` : '';
    const failureText = failure ? ` Latest checker failure: ${failure}` : '';
    if (downstream) {
      return {
        filePath,
        text: `Direct kick from the eval harness: the existing checked workspace file${path} is on disk (${sniff?.bytes ?? 0} bytes) but has not passed yet.${failureText} Treat that failure like a failing test: edit the existing file in place, preserve behavior that already passes, and make the smallest targeted change that clears it. Do NOT recreate the file or replace it with a new draft. Your next tool call must be an edit (prefer \`replace_in_file\`, \`replace_lines\`, or \`apply_patch\`; use \`write_file\` only if a complete rewrite is explicitly required). Do not answer only in prose.`,
      };
    }
    return {
      filePath,
      text: `Quick check: the existing checked workspace file${path} is on disk but has not reached success.${failureText} Continue a targeted in-place repair yourself or hand the exact checker failure to the right specialist. Preserve the behavior that already passes; do not tell them to recreate the deliverable from scratch.`,
    };
  }

  if (!downstream) {
    return {
      filePath,
      text: "Quick check: I see your team has been active but no final deliverable has reached the project workspace yet. Use list_artifacts to confirm what's been produced, then make sure the final artifact (HTML page, game file, etc.) is written to the project's workspace — that's what the user is waiting on. If a specialist is blocked or waiting for input, surface that now.",
    };
  }

  const filePathClause = filePath ? ` at \`${filePath}\`` : '';
  const writeCall = formatImmediateWriteFileCall(filePath);
  return {
    filePath,
    text: `Direct kick from the eval harness: the deliverable hasn't landed in the project's workspace yet${filePathClause}. Do not write more planning documents, do not ask for confirmation. Do not end your turn until \`write_file\` has landed the workspace file. Your next tool call MUST be \`${writeCall}\` creating the actual deliverable file${filePath ? ` at \`${filePath}\`` : ' (e.g. `index.html`)'} in the project's workspace. Use \`copy_artifact_to_workspace\` only for binary assets that already exist in artifacts. Do not use \`write_artifact\` for source or app files.`,
  };
}

const SNIFF_KEY_WORKSPACE_FILE_PATHS: Record<string, string> = {
  bookstore: 'openapi.yaml',
  'constrained-comms': 'customer-notice.md',
  'data-wrangle': 'out/customers.json',
  'failing-tests-spec': 'src/machine.ts',
  'fictional-sdk': 'worker.mjs',
  'incident-postmortem': 'postmortem.md',
  'ops-runbook-anomaly': 'runlog.md',
  'symptom-debug': 'lib/paginate.mjs',
};

/**
 * Write the early `status.json` marker. Best-effort — a failure here is
 * logged by the caller's try/catch (or swallowed) and never fails a trial,
 * since the marker is purely for the live viewer.
 */
export function sniffKeyToWorkspaceFilePath(key: string | null | undefined): string | null {
  if (!key) return null;
  let firstSegment = key.split(':')[0]?.trim();
  if (!firstSegment) return null;
  const mapped = SNIFF_KEY_WORKSPACE_FILE_PATHS[firstSegment.toLowerCase()];
  if (mapped) return mapped;
  const workspaceMarker = '/workspace/';
  const markerIndex = firstSegment.toLowerCase().indexOf(workspaceMarker);
  if (markerIndex >= 0) {
    firstSegment = firstSegment.slice(markerIndex + workspaceMarker.length);
  } else if (firstSegment.toLowerCase().startsWith('workspace/')) {
    firstSegment = firstSegment.slice('workspace/'.length);
  }
  if (
    firstSegment.includes('..') ||
    firstSegment.startsWith('/') ||
    firstSegment.startsWith('\\') ||
    firstSegment.split(/[\\/]/).some((part) => part.length === 0)
  ) {
    return null;
  }
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(firstSegment) ? firstSegment : null;
}

/**
 * CHATTER path: a scored artifact stopped improving while the team kept
 * taking turns and wrote nothing.
 *
 * `writeCounterHasEverMoved` is the load-bearing guard. The daemon
 * classifies a file mutation by BARE tool name, so a provider that
 * namespaces gezel-mcp (`mcp__gezel__append_to_file`) or edits with its
 * own built-ins (`Write`/`Edit`) reports `fileMutations: 0` for the
 * entire trial — every anthropic-cli trial across the first hard-suite
 * runs did, at 3 to 273 tool calls apiece. Without the guard this
 * watchdog is permanently armed against exactly the teams that ARE
 * writing, and its evidence ("0 re-writes") is not evidence of anything:
 * craftbook-author-fanout x claude-sonnet-4-6 shipped
 * "stalled 18m despite 57 tool calls (0 re-writes)" over a trial with 9
 * successful `mcp__gezel__append_to_file` calls and 5 `Write`s.
 */
/**
 * Total workspace files the fingerprint can see, across every project.
 *
 * The retry loop's FAST path needs to tell a stubborn rewriter from a team
 * working through a queue of deliverables, and the write counter alone
 * cannot: `daemonActivity.writeCalls` is a bare sum over the six mutation
 * tools with no path in it, so a write to a NEW file is indistinguishable
 * from the fourth re-emission of a failing one.
 */
/**
 * Sessions whose persisted transcript carries far fewer tool calls than the
 * daemon's telemetry recorded for them.
 *
 * Assistant messages are committed at TURN END. A trial killed mid-turn —
 * which is every watchdog termination — therefore persists the kickoff user
 * message and nothing else, while the tool calls that turn already made are
 * invisible. The workspace still holds the files they wrote, so the trial
 * dir tells two contradictory stories.
 *
 * Wild-caught triaging the qwen3.8-27b-q4 re-baseline of
 * `craftbook-author-linear`: telemetry recorded 15 and 7 tool calls across
 * two sessions (3 file mutations, `notes/anomalies.md` on disk), and both
 * dumped transcripts contained exactly one message — the kickoff. Read
 * naively that says the model did nothing, which is the opposite of true.
 *
 * This does not recover the lost turns; it labels the gap, so a triager
 * reaches for `session-telemetry.json` and `daemon.log` instead of
 * concluding from an empty transcript.
 */
export function incompleteTranscripts(
  sessions: ReadonlyArray<{ id: string; gezelId?: string; toolCallsPersisted: number }>,
  telemetry: ReadonlyArray<{ sessionId: string; toolCalls?: number }>,
): Array<{ id: string; gezelId?: string; persisted: number; recorded: number }> {
  const recordedBy = new Map(telemetry.map((row) => [row.sessionId, row.toolCalls ?? 0]));
  const gaps = [];
  for (const s of sessions) {
    const recorded = recordedBy.get(s.id) ?? 0;
    if (recorded > s.toolCallsPersisted) {
      gaps.push({
        id: s.id,
        ...(s.gezelId ? { gezelId: s.gezelId } : {}),
        persisted: s.toolCallsPersisted,
        recorded,
      });
    }
  }
  return gaps;
}

export function totalWorkspaceFileCount(
  workspace: Record<string, { fileCount?: number }> | undefined,
): number {
  if (!workspace) return 0;
  return Object.values(workspace).reduce((sum, entry) => sum + (entry?.fileCount ?? 0), 0);
}

/**
 * Stable signature of WHICH files exist across every project workspace.
 *
 * The FAST path needs "did the team produce anything new during this
 * plateau", and a COUNT answers that badly. It can fall as well as rise —
 * a deleted or renamed file, or a single transient `listProjectWorkspace`
 * failure, which the fingerprint deliberately swallows per project rather
 * than poisoning the whole poll. A negative delta then reads as "no
 * growth" and the guard waves the kill through.
 *
 * Wild-caught on the qwen3.8-27b-q4 sweep of `craftbook-refactor-module`:
 * `tasks/eval/baseline.md` was created at 16:28:00, inside a plateau
 * running 16:24:43 to 16:33:04, and the FAST path fired anyway.
 *
 * A path-set signature has none of those failure modes. A stubborn
 * rewriter re-emits the same paths, so its signature is stable and the
 * path still fires; anything that adds, removes or renames a file changes
 * it and suppresses. A listing failure also changes it, which fails SAFE —
 * declining to kill on incomplete information is the right default for a
 * terminator whose false positives book as model failures.
 */
export function workspacePathSignature(
  workspace: Record<string, { pathsHash?: string; fileCount?: number }> | undefined,
): string {
  if (!workspace) return '';
  return Object.keys(workspace)
    .sort()
    .map((id) => `${id}:${workspace[id]?.pathsHash ?? workspace[id]?.fileCount ?? '?'}`)
    .join('|');
}

/**
 * FAST path — the stubborn rewriter: a scored artifact re-emitted without
 * improving.
 *
 * `filesAddedInPlateau` is what makes that claim honest. The path fires on
 * "N writes, no sniff movement", and its own comment names its target as
 * "a stubborn rewriter re-emitting the same failing shape" — but writes to
 * DIFFERENT files climb the same counter. On a multi-deliverable scenario
 * that reads as looping while the team is in fact producing.
 *
 * Wild-caught on the qwen3.8-27b-q4 re-baseline of `craftbook-invoice-run`:
 * killed at 8m on "4 re-writes ... without sniff movement", where the four
 * writes were four DISTINCT paths — `invoices/2026-042.html`,
 * `invoices/2026-043.html`, `tasks/eval/scope.md`, `tasks/eval/billables.json`.
 * Nothing was rewritten even once. Two of the three required invoices were
 * produced inside the very window being judged as a loop.
 *
 * A genuine rewriter leaves the file set flat, so requiring it costs that
 * case nothing. Same failure family as the two documented squisq-review
 * false kills this path was already narrowed once to avoid.
 */
export function retryLoopFastPathTripped(input: {
  artifactHasScored: boolean;
  plateauMs: number;
  writeCallsInPlateau: number;
  /** Workspace path signature when this plateau began. */
  startingPathSignature: string;
  /** Workspace path signature now. */
  currentPathSignature: string;
  windowMs: number;
  writeThreshold: number;
}): boolean {
  if (!input.artifactHasScored) return false;
  if (input.plateauMs < input.windowMs) return false;
  if (input.writeCallsInPlateau < input.writeThreshold) return false;
  // The file SET moved while the sniff held: a queue being worked, not one
  // artifact re-emitted. Only a stable path set is the stubborn-rewriter
  // shape this path exists to catch.
  return input.currentPathSignature === input.startingPathSignature;
}

export function retryLoopChatterTripped(args: {
  artifactHasScored: boolean;
  writeCounterHasEverMoved: boolean;
  plateauMs: number;
  writeCallsInPlateau: number;
  turnStartsInPlateau: number;
  windowMs: number;
  turnThreshold: number;
}): boolean {
  return (
    args.artifactHasScored &&
    args.writeCounterHasEverMoved &&
    args.plateauMs >= args.windowMs &&
    args.writeCallsInPlateau === 0 &&
    args.turnStartsInPlateau >= args.turnThreshold
  );
}

export function retryLoopSniffKey(
  sniff:
    | Pick<
        TrialFinalSniff,
        | 'key'
        | 'score'
        | 'bytes'
        | 'failReason'
        | 'repairFilePath'
        | 'runtimePassed'
        | 'runtimeFailed'
        | 'milestones'
      >
    | null
    | undefined,
): string {
  if (!sniff) return 'none';
  // `bytes` is deliberately absent: byte churn at a frozen score is the
  // stubborn-rewrite loop this watchdog exists to catch. `milestones` is
  // the opposite signal — a unit of work the scenario declares FINISHED —
  // and is appended only when a scenario reports one, so every existing
  // key string stays byte-identical.
  const milestones = sniff.milestones === undefined ? '' : `:m${sniff.milestones}`;
  return `${sniff.key}:${sniff.score}:target${sniff.repairFilePath ?? 'none'}:fr${retryLoopFailReasonKey(sniff.failReason)}:rp${sniff.runtimePassed ?? 0}:rf${sniff.runtimeFailed ?? 0}${milestones}`;
}

export function sniffArtifactHasScored(
  sniff:
    | (Pick<TrialFinalSniff, 'key' | 'score' | 'repairFilePath'> &
        Partial<Pick<TrialFinalSniff, 'bytes' | 'deliverableMissing'>>)
    | null
    | undefined,
  scoredSniffKeys: ReadonlySet<string>,
): boolean {
  if (!sniff) return false;
  // A driver that just looked and found nothing outranks the sticky set:
  // that set exists so a transient 0-read cannot disarm a guard a real
  // artifact armed, and this is not an inference from a re-read — it is
  // the scenario reporting what it found. An emptied or never-written
  // deliverable is not something a model can be stubbornly rewriting,
  // whatever an earlier poll believed.
  if (sniff.deliverableMissing) return false;
  return sniffEvidencesArtifact(sniff) || scoredSniffKeys.has(sniff.key);
}

/**
 * Does this sniff prove a deliverable EXISTS to be stubborn about?
 *
 * Every retry-loop path gates on this, so a false positive kills a trial
 * that is still doing legitimate first-draft work, and reports it as
 * "Artifact produced but never reached success" — a sentence that sends
 * triage looking for a bad artifact that was never written.
 *
 * Two independent kinds of evidence, and NEITHER of the raw signals is
 * sufficient on its own:
 *
 *   - A named repair target. The scenario has identified a specific file
 *     it wants fixed, which is as direct as this gets.
 *   - Bytes AND a non-zero score together. Bytes alone are not enough: on
 *     a multi-deliverable scenario the written thing is routinely a
 *     DIFFERENT file, which read as 0/2728 on powerpoint-deck (sources.md
 *     and outline.md existed, deck.md never did) and failed six of
 *     fifteen trials whose models were still actively calling tools.
 *
 * And score alone is not enough either, which is what this replaced. On a
 * craftbook scenario `score` counts deterministic checks, and the early
 * ones are PRECONDITIONS — seeded inputs read, task created from the
 * right recipe — that clear long before any deliverable exists.
 * craftbook-refactor-module sat at checks=7/30 with bytes=0 and no repair
 * target and was killed by the 8-minute stubborn-rewriter path 28 minutes
 * inside its own ceiling, while it was still reading its seeded inputs.
 * Its three "re-writes" were the first drafts of files nothing had
 * written before.
 */
function sniffEvidencesArtifact(
  sniff: Pick<TrialFinalSniff, 'score' | 'repairFilePath'> &
    Partial<Pick<TrialFinalSniff, 'bytes' | 'deliverableMissing'>>,
): boolean {
  // A driver that looked and found nothing outranks both inferences below.
  if (sniff.deliverableMissing) return false;
  if (sniff.repairFilePath) return true;
  return sniff.score > 0 && (sniff.bytes ?? 0) > 0;
}

function retryLoopFailReasonKey(reason: string | undefined): string {
  if (!reason) return 'none';
  const normalized = reason
    .toLowerCase()
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:bytes?|kb|mb|ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/g,
      '#',
    )
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function writeTrialStatus(runDir: string, status: TrialStatus): Promise<void> {
  try {
    await writeFile(join(runDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    // Non-fatal: the viewer just won't see this trial until result.json lands.
  }
}

async function finalize(args: {
  trialId: string;
  scenarioId: string;
  modelId: string;
  modelTier: import('@bendyline/gezel').ModelTier;
  startedAt: Date;
  startMonotonic: number;
  runDir: string;
  success: boolean;
  reason: string;
  failureMode?: FailureMode;
  finalSniff?: TrialFinalSniff;
  logger: TrialLogger;
  trialHome: string;
  client: GezelClient | null;
}): Promise<TrialResult> {
  const finishedAt = new Date();
  const durationMs = Date.now() - args.startMonotonic;
  // Tag the trial with who-broke-it accountability so pass-rate tables
  // can separate model failures from infra/operator noise. Log-signature
  // rules read the daemon log; classification must never block finalize.
  let classification = classifyTrial({ success: args.success, reason: args.reason });
  let nativeIncidentLog: string | null = null;
  let sessionTelemetry: SessionTelemetryListResponse | null = null;
  let engineContext: EngineContextRecord | null = null;
  try {
    const daemonLog = readDaemonLogTailSync(join(args.runDir, 'daemon.log'));
    const nativeIncidentPath = join(args.runDir, 'native-incidents.jsonl');
    nativeIncidentLog = existsSync(nativeIncidentPath)
      ? readFileSync(nativeIncidentPath, 'utf8')
      : null;
    const sessionTelemetryPath = join(args.runDir, 'session-telemetry.json');
    if (existsSync(sessionTelemetryPath)) {
      try {
        sessionTelemetry = JSON.parse(
          readFileSync(sessionTelemetryPath, 'utf8'),
        ) as SessionTelemetryListResponse;
      } catch {
        sessionTelemetry = null;
      }
    }
    classification = classifyTrial({
      success: args.success,
      reason: args.reason,
      failureMode: args.failureMode ?? null,
      daemonLog,
      nativeIncidentLog,
      sessionTelemetry: sessionTelemetry?.sessions,
    });
    // Granted-context provenance (Theme E / E4): the engine's actual
    // context window per slot, plus any clamp/denial/swa-decline evidence,
    // so the 64K admission policy is queryable from result.json instead of
    // grep-only. Never blocks finalize.
    engineContext = extractEngineContext(daemonLog);
  } catch {
    // Reason-only classification (already computed) stands.
  }
  const nativeEngineIncidents = summarizeNativeEngineIncidents(nativeIncidentLog);
  const effectiveFailureMode =
    !args.success &&
    (classification.rule === 'cuda-engine-crash' || classification.rule === 'native-engine-crash')
      ? ('engine-crash' as const)
      : args.failureMode;
  // Supervisor-arm trials: summarize the harvested intervention case
  // records (captureFinalState ran before finalize, so the dir exists
  // by now). Never blocks finalize; null = control arm.
  const keurmeesterSummary = await summarizeKeurmeesterCases(args.runDir).catch(() => null);
  const result: TrialResult = {
    trialId: args.trialId,
    scenarioId: args.scenarioId,
    modelId: args.modelId,
    modelTier: args.modelTier,
    startedAt: args.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    success: args.success,
    reason: args.reason,
    runDir: args.runDir,
    ...(effectiveFailureMode ? { failureMode: effectiveFailureMode } : {}),
    ...(nativeEngineIncidents ? { nativeEngineIncidents } : {}),
    ...(engineContext ? { engineContext } : {}),
    ...(args.finalSniff ? { finalSniff: args.finalSniff } : {}),
    ...(keurmeesterSummary ? { keurmeester: keurmeesterSummary } : {}),
    ...(classification.failureClass !== 'pass'
      ? {
          failureClass: classification.failureClass,
          failureClassRule: classification.rule,
          ...(classification.evidence ? { failureClassEvidence: classification.evidence } : {}),
        }
      : {}),
  };
  args.logger.log(
    `[trial] ${args.success ? 'PASS' : 'FAIL'} duration=${durationMs}ms reason=${args.reason}`,
  );
  await args.logger.stop();
  await writeFile(join(args.runDir, 'result.json'), JSON.stringify(result, null, 2));

  // facts.json on every trial (Theme E / E1-A): the observable-facts layer
  // used to be saved by hand via the eval-run skill (only ~58% coverage).
  // `score()` reads the just-written result.json + log.txt (flushed by
  // logger.stop() above) + the capture/perf outputs written before
  // finalize, so calling it here gives it everything. Failure-isolated:
  // the logger is stopped, so a score() throw uses console.warn and never
  // fails the trial.
  try {
    await writeTrialFacts(args.runDir);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[trial] facts.json write skipped (score failed): ${String(err)}`);
  }

  // result.json is now the authoritative terminal artifact; drop the early
  // "running" marker so the live viewer no longer treats this as in-flight.
  await rm(join(args.runDir, 'status.json'), { force: true }).catch(() => {});

  // Cleanup trial temp dir. Run dir is preserved.
  try {
    await rm(args.trialHome, { recursive: true, force: true });
  } catch {
    // Best-effort — Windows can hold file handles for a beat after kill.
  }

  return result;
}

/**
 * Pick the most-recently-active downstream gezel to receive a direct
 * re-engage nudge, bypassing the meester relay. Returns null when no
 * qualifying session exists (single-gezel trial, or only the meester is
 * registered) — caller falls back to nudging the meester.
 *
 * "Qualifying" means: non-archived, non-meester session whose owner's
 * role is builder/developer/voorman (the gezels expected to write the
 * actual deliverable). Falls through to "any non-meester session" if no
 * role match — better to nudge the wrong specialist than no one.
 */
async function pickReEngageTarget(
  client: GezelClient,
  meesterId: string,
  args?: { preferWritableRole?: boolean },
): Promise<{ gezelId: string; projectId: string; role: string | null } | null> {
  let sessions: Array<{
    gezelId: string;
    projectId: string;
    lastActivityAt?: string;
    archived?: boolean;
  }> = [];
  try {
    const r = await client.listChatSessions();
    sessions = r.sessions ?? [];
  } catch {
    return null;
  }
  if (sessions.length === 0) return null;

  let gezelRoles: Map<string, string | null>;
  try {
    const { gezels } = await client.listGezels();
    gezelRoles = new Map(gezels.map((g) => [g.id, g.role ?? null]));
  } catch {
    gezelRoles = new Map();
  }

  const candidates = sessions.filter((s) => !s.archived && s.gezelId && s.gezelId !== meesterId);
  if (candidates.length === 0) return null;

  const tsOf = (s: { lastActivityAt?: string }): number => {
    if (!s.lastActivityAt) return 0;
    const t = Date.parse(s.lastActivityAt);
    return Number.isFinite(t) ? t : 0;
  };
  const byRecency = [...candidates].sort((a, b) => tsOf(b) - tsOf(a));

  const builderRoles = /^(builder|developer|voorman)$/i;
  const roleOf = (s: { gezelId: string }): string | null => gezelRoles.get(s.gezelId) ?? null;
  const matches = (s: { gezelId: string }, re: RegExp): boolean => {
    const role = roleOf(s);
    return role !== null && re.test(role);
  };
  // A nudge that names a deliverable file has to reach someone who can write
  // one. `voorman` is coordination-only, so preferring it for a file nudge
  // guarantees an HTTP 400 from the service's pure-delegation guard and the
  // nudge silently never lands. Prefer a write-capable role when a file is in
  // play; otherwise keep the original recency-with-builder-preference order.
  const writableHit = args?.preferWritableRole
    ? byRecency.find((s) => matches(s, WRITE_CAPABLE_ROLES))
    : undefined;
  const builderHit = byRecency.find((s) => matches(s, builderRoles));
  const chosen = writableHit ?? builderHit ?? byRecency[0];
  if (!chosen) return null;
  return {
    gezelId: chosen.gezelId,
    projectId: chosen.projectId,
    role: gezelRoles.get(chosen.gezelId) ?? null,
  };
}
