/**
 * LlamaCppProvider — talks to a local `llama-server` binary over HTTP.
 * The server speaks OpenAI-compatible `/v1/chat/completions` with SSE
 * streaming and standard tool-calling when launched with `--jinja`.
 *
 * Session model is stateless (like Ollama): we keep the full transcript
 * in memory and resend it each turn. `ProviderSessionState` is empty —
 * the session record on disk is the source of truth.
 *
 * Lifecycle of the llama-server process itself is managed by a
 * {@link NativeEngineSupervisor}: lazy-start on first turn, idle-stop,
 * health-watch, restart budget. The provider asks `ensureRunning()`
 * before each turn and `markUsed()` afterwards. A dev / LAN mode
 * without a supervisor (just a `baseUrl`) is also supported for when
 * the user runs their own llama-server.
 *
 * Each provider INSTANCE serves a single model (one llama-server
 * process); multi-model is handled a layer up by the engine pool
 * (`providers/native/provider-pool.ts`), which keys instances by
 * `{provider, modelId, replicaIdx}` and spools/evicts them under a
 * memory budget. An evicted instance is `disposed` — it must never
 * lazily respawn its process (see {@link shutdown}).
 */

import * as os from 'node:os';
import { createLogger } from '@bendyline/gezel';
import {
  type ChatMessage,
  DEFAULT_NUM_CTX,
  type DisableThinkingRequestShape,
  LlamaCppSession,
  NativeEngineCrashedError,
  type ReasoningEffortRequestShape,
  TOOL_GRAMMAR_FALLBACK_ORDER,
  type ToolGrammarFallback,
  constrainedToolNoSignalMsForModel,
  engineRequestAbortError,
  parseEnvMs,
} from '@bendyline/gezel/local-loop';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { McpBridgePool } from '../mcp-bridge-pool.js';
import type {
  NativeEngineLaunch,
  NativeEngineLifecycleSnapshot,
  NativeEngineSupervisor,
} from '../native/supervisor.js';
import { ProviderDisposedError } from '../provider-disposal.js';
import {
  ProviderQueue,
  QUEUE_WAIT_NOTICE_DELAY_MS,
  QUEUE_WAIT_NOTICE_REPEAT_MS,
  backgroundLaneCap,
  defaultAmbientQuietMs,
} from '../queue.js';
import type { EnginePhaseEvent } from '../streaming-session.js';
import type {
  BatchCapability,
  EngineLaunchSnapshot,
  LLMProvider,
  LLMSession,
  ModelInfo,
  SessionOpts,
} from '../types.js';
import type { LlamaCppLogFile } from './log.js';
import { type StartupPhase, classifyStartupLine } from './stdout-parser.js';

// The session and its helpers live in core so a phone runs the same loop.
export * from '@bendyline/gezel/local-loop';
export { isFileRepairTurn as isScenarioFileRepairTurn } from '@bendyline/gezel/local-loop';

const log = createLogger('llama-cpp');

export class LlamaCppProvider implements LLMProvider {
  readonly name = 'llama-cpp' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  readonly supportsPriorMessages = true;
  /**
   * What this engine build's aggregate tool-grammar converter has already
   * proven it cannot take, remembered across sessions.
   *
   * The rejection is deterministic — a fixed build applied to a tool
   * payload of a given size either compiles or doesn't — but the recovery
   * ladder in `runSend` used to start from `'none'` on every turn, so a
   * roster that fails re-paid two rejected round-trips *per turn*, forever.
   * On one install that was 16 rejections in a single afternoon, every one
   * of them re-deriving the same answer.
   *
   * Keyed on tool count rather than remembered flat, because the limit the
   * failures actually hit is grammar SIZE ("number of repetitions exceeds
   * sane defaults"): a 48-tool roster blowing up says nothing about a
   * 5-tool one, and degrading the small roster's schemas would cost real
   * tool-argument fidelity for no reason. A request at or above the
   * smallest count known to fail starts at the tier that recovered it.
   */
  private toolGrammarFloor: { minToolCount: number; tier: ToolGrammarFallback } | null = null;
  private readonly supervisor?: NativeEngineSupervisor;
  /** Explicit base URL when no supervisor is managing the process. */
  private readonly externalBaseUrl?: string;
  private readonly defaultModel: string;
  /**
   * Catalog model id for the on-disk weights llama-server is serving —
   * `qwen3.5-9b-llama-cpp`, `gemma4-e4b-llama-cpp`, etc. Distinct from
   * `defaultModel`, which holds the placeholder string llama-server
   * accepts in the `model` request field (the engine ignores it when
   * only one model is loaded). Surfaced via {@link getEffectiveModelId}
   * so the chat manager can resolve a tier for sessions that don't
   * have an explicit model selection (`record.model` undefined AND
   * `config.defaultModel.llama-cpp` undefined). Without this, those
   * sessions classify as `tier:tiny` because the tier resolver has
   * nothing to parse — and the debug bundle can't print the model
   * name either, so an engineer reading it sees `tier: tiny` against
   * a 9B Qwen and is left guessing what model is actually loaded.
   *
   * Empty when the provider was constructed in external-baseUrl mode
   * (we don't know what the user's llama-server is serving) or before
   * the catalog has resolved a default model. Mirrors the same field
   * on `MlxProvider`.
   */
  private readonly catalogModelId?: string;
  /**
   * Catalog manager — when set, `listModels()` enumerates every model
   * the user has installed (so `/v1/models` + Settings pickers see the
   * full set the engine pool can serve), not just the resident one.
   * Optional because external-baseUrl mode has no local catalog.
   * Mirrors the same field on `MlxProvider`.
   */
  private readonly modelManager?: import('./models.js').LlamaCppModelManager;
  /** Owner key of our `'llm'` evictor registration; see constructor opts. */
  private evictorOwnerId?: string;
  /**
   * Set once {@link shutdown} runs. A disposed provider must never
   * lazily respawn its llama-server: the engine pool evicts replicas
   * by calling `shutdown()`, and any session still holding the old
   * instance would otherwise resurrect the process via
   * `ensureRunning()` — a zombie engine outside the pool's capacity
   * accounting.
   */
  private disposed = false;
  private readonly numCtx: number;
  private readonly plannedReservation?: number;
  /**
   * When true, append `stream_options:{include_usage:true}` to chat requests so
   * the engine emits a final usage chunk. Off for llama-server (it surfaces its
   * own custom timings/usage the session already parses); ds4-server emits
   * usage ONLY when asked, so {@link buildDs4Provider} opts in — without this,
   * ds4 turns record zero tokens and tok/s telemetry is null.
   */
  private readonly includeUsageInStream: boolean;
  /**
   * When true, assistant turns committed to the session transcript carry
   * their verbatim SSE `reasoning_content` so later requests replay it.
   * Off for llama-server (its templates drop reasoning on re-render, and
   * echoing it back would *change* the rendered prompt on templates that
   * honor the field). On for ds4-server, whose DeepSeek-V4 render replays
   * `<think>{reasoning_content}</think>` for every assistant turn in tool
   * context and keeps exact per-call DSML by tool-call id: with the
   * reasoning echoed, the re-rendered history is byte-identical to what
   * was generated, the engine's live-KV prefix match survives each tool
   * iteration, and a continuation prefills only the new tool results.
   * Without it, every iteration logs `live kv cache miss … reason=
   * token-mismatch`, falls back to the system-prefix disk snapshot, and
   * re-prefills the whole conversation tail (minutes per turn at DS4's
   * SSD-streamed prefill speeds).
   */
  private readonly replayReasoningContent: boolean;
  /**
   * Whether this engine was launched with `--mmproj`, i.e. whether the server
   * can actually decode an image. Gates the typed-content message shape:
   * sending image parts to a text-only server just inflates the prompt with
   * base64 the model can't interpret.
   *
   * Sourced from the installed model's projector path plus the user's
   * per-model opt-in, resolved in `buildLlamaCppProvider`.
   */
  private readonly visionEnabled: boolean;
  /** Read by the machine engine's `/v1/remote/infer`, which refuses image history otherwise. */
  get supportsImageInput(): boolean {
    return this.visionEnabled;
  }
  private readonly disableThinkingRequestShape: DisableThinkingRequestShape;
  /** Request-scoped effort shape for compatible wrappers such as ds4-server. */
  private readonly reasoningEffortRequestShape: ReasoningEffortRequestShape;
  /** Engine batch width; see the `batchMaxConcurrency` constructor opt. */
  private readonly batchMaxConcurrency: number;
  /**
   * Number of real llama-server request slots (`--parallel`). The provider
   * queue can intentionally be wider than this by one reserved background
   * lane so an in-turn one-shot can dispatch without deadlocking behind the
   * foreground turn that awaits it. This gate is the separate physical
   * boundary: cache slot save/restore plus the streamed engine request must
   * never exceed the slots the native server actually owns.
   */
  private readonly engineRequestWidth: number;
  private engineRequestsActive = 0;
  private readonly engineRequestWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  /**
   * Mid-stream silence cap (ms). After this many ms with no SSE chunk,
   * the in-flight `/v1/chat/completions` request is aborted with an
   * idle-stall error so the runtime publishes `done`, the engine pill
   * clears, and the user can retry. Without this cap a hung llama-cpp
   * turn (model stalled, llama-server thread wedged, GPU eviction mid-
   * generation) would hold the runtime's `await sendAndWait` forever.
   * Mirrors Ollama's same-named knob (default 5 min); see Ollama's
   * `streamingIdleMs` for the design notes.
   */
  private readonly streamingIdleMs: number;
  /**
   * Pre-first-byte cap (ms). Covers cold model load, prompt prefill,
   * and the first-token wait. Separate from `streamingIdleMs` so a
   * legitimately slow first-chunk on a 30B-class model doesn't trip
   * the streaming-idle watchdog set for active-generation silence.
   */
  private readonly preFirstByteIdleMs: number;
  /**
   * Tight post-reasoning silent-stall cap (ms). Armed when the engine
   * signals it finished thinking; fires if no SSE delta arrives within
   * the window AND a `/slots` liveness probe shows the KV cache is not
   * growing. Default 30s; overridable for tests. See the watchdog in
   * `sendAndWaitInner`.
   */
  private readonly postReasoningWatchdogMs: number;
  /**
   * Constrained mutation turns should produce a tool signal quickly after
   * the model has already inspected inputs. DS4 can otherwise burn the full
   * turn in hidden/tool thinking with no SSE signal; this timer converts that
   * into the existing no-mutation corrective retry.
   */
  private readonly constrainedToolNoSignalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logFile?: LlamaCppLogFile;
  /**
   * Cross-engine GPU coordinator. When set (and we're running a
   * supervised local llama-server, not an external base URL),
   * `resolveBaseUrl` acquires the `'llm'` slot before each request,
   * which evicts the image engine in `swap` mode. The provider also
   * registers its supervisor's `stop()` as the `'llm'` evictor so
   * image-gen requests can swap us out symmetrically.
   */
  private readonly arbiter?: GpuArbiter;
  /**
   * Sessions currently inside `sendAndWaitInner` — used to fan-out
   * supervisor-side phase events (model load progress parsed from
   * llama-server stdout) to every caller waiting on the same engine
   * startup. Sessions add themselves on turn entry and remove in the
   * finally block. Empty when the engine is idle.
   */
  private readonly activeSessions = new Set<LlamaCppSession>();
  /**
   * Last phase observed from the stdout classifier, kept so newly-
   * starting sessions can pick up the current state instead of waiting
   * for the next log line. Cleared on `ready`.
   */
  private lastStartupPhase: EnginePhaseEvent | null = null;
  /**
   * Running total of bytes allocated across every `load_tensors:` /
   * `llama_kv_cache_init:` line the stdout classifier has seen since
   * the current engine start. Reset on `ready` so a later restart's
   * allocation doesn't double-count. Published once per engine start
   * as an `engine_stats` event fanning out to active sessions.
   */
  private accumulatedRamBytes = 0;
  /**
   * Most recent ram total published — used so new sessions joining
   * mid-lifecycle get the figure replayed (same pattern as
   * `lastStartupPhase`).
   */
  private lastEngineStats: { ramAllocBytes: number } | null = null;
  /**
   * Stdout line → phase classifier used by {@link onStdoutLine}.
   * Defaults to the llama-server classifier; engine wrappers that
   * reuse this turn loop against a different binary (ds4-server via
   * {@link Ds4Provider}) inject their own so phase events reflect
   * that engine's actual log wording instead of silently matching
   * nothing.
   */
  private readonly classifyLine: (line: string) => StartupPhase | null;

  constructor(opts: {
    /**
     * Supervisor that owns the llama-server child. When set, each
     * turn calls `supervisor.ensureRunning()` to get the live base
     * URL and `markUsed()` after. Mutually exclusive with
     * `baseUrl`.
     */
    supervisor?: NativeEngineSupervisor;
    /**
     * Fixed base URL of an already-running llama-server. Used in
     * dev iteration and LAN-shared setups. Mutually exclusive with
     * `supervisor`.
     */
    baseUrl?: string;
    defaultModel?: string;
    /** See {@link LlamaCppProvider.catalogModelId} for the contract. */
    catalogModelId?: string;
    /** See {@link LlamaCppProvider.modelManager} for the contract. */
    modelManager?: import('./models.js').LlamaCppModelManager;
    /**
     * Context window (tokens) llama-server was booted with. The
     * supervisor-owned launch path is responsible for matching this
     * to the `--ctx-size` it passed; the external-baseUrl path
     * trusts the caller. Surfaced on every session so ChatManager
     * can pressure-check. Default 16384 when omitted.
     */
    numCtx?: number;
    /**
     * Broker-ledger reservation for this replica: resident weights plus
     * the KV the engine will allocate at the granted window and cache
     * mode, computed by the launch admission pass. The pool builder
     * prefers this over the catalog/weights-multiplier fallback so
     * co-residency admission can see KV (M1).
     */
    plannedReservationBytes?: number;
    /** See {@link LlamaCppProvider.includeUsageInStream}. Default false. */
    includeUsageInStream?: boolean;
    /** See {@link LlamaCppProvider.replayReasoningContent}. Default false. */
    replayReasoningContent?: boolean;
    /** See {@link LlamaCppProvider.visionEnabled}. Default false. */
    visionEnabled?: boolean;
    /**
     * Request fields used when constrained local turns need thinking disabled.
     * llama-server honors chat_template_kwargs.enable_thinking; ds4-server
     * needs DeepSeek-compatible top-level thinking fields.
     */
    disableThinkingRequestShape?: DisableThinkingRequestShape;
    /**
     * Forward `SessionOpts.reasoningEffort` on each request. DS4 accepts both
     * the top-level OpenAI field and Qwen-style chat-template kwargs; ordinary
     * llama-server providers retain their existing catalog-only behavior.
     */
    reasoningEffortRequestShape?: ReasoningEffortRequestShape;
    concurrency?: number;
    /**
     * Keep the queue's normal spare background lane. Defaults to true because
     * llama-server can accept a queued second request while a foreground turn
     * releases/reacquires its slot between tool iterations. Specialized
     * single-tenant wrappers such as ds4 disable this so expensive SSD-streamed
     * inference is strictly serial and cannot double its I/O pressure.
     */
    reserveBackgroundSlot?: boolean;
    /**
     * Engine batch width — how many sequences the server can generate at
     * once. The supervised path passes its `--parallel` slot count, so this
     * equals {@link concurrency} there; chats may fill all of it, with one
     * slot withheld from background work so a live turn never waits behind a
     * background cohort. Default 1, which is what the external-baseUrl path
     * takes: we don't control that server's `--parallel` and it may be
     * single-slot. See {@link LLMProvider.batch}.
     */
    batchMaxConcurrency?: number;
    affinity?: boolean;
    /**
     * Override the default mid-stream silence cap (ms). Set lower for
     * tests; raise via `config.llamaCppStreamingIdleSec` for users with
     * legitimately slow models that need more headroom mid-generation.
     */
    streamingIdleMs?: number;
    /** Override the default pre-first-byte cap (ms). */
    preFirstByteIdleMs?: number;
    /** Override the default post-reasoning silent-stall cap (ms). Set lower for tests. */
    postReasoningWatchdogMs?: number;
    /** Override the constrained mutation no-tool-signal cap (ms). Set lower for tests. */
    constrainedToolNoSignalMs?: number;
    fetchImpl?: typeof fetch;
    /**
     * Rolling log-file sink capturing raw llama-server stdout/stderr.
     * Surfaced via {@link getLogFile} so the Settings → On-device log
     * viewer can tail it. Only set on the supervised path.
     */
    logFile?: LlamaCppLogFile;
    /**
     * Cross-engine GPU coordinator. Optional: cloud-LLM installs and
     * tests don't need it. When supplied alongside a supervisor, the
     * provider registers its `stop()` so image generation can evict
     * llama-server in `swap` mode, and acquires the `'llm'` slot
     * before each request so a still-running image engine gets
     * evicted first.
     */
    arbiter?: GpuArbiter;
    /**
     * Owner key for the arbiter's `'llm'`-slot evictor registration.
     * The engine pool passes the engine key (`llama-cpp/<model>#<n>`)
     * so concurrently-resident replicas don't clobber each other's
     * registration; singleton boots omit it and use the arbiter's
     * `'default'` owner. Unregistered automatically in
     * {@link shutdown}.
     */
    evictorOwnerId?: string;
    /**
     * Directory passed to llama-server's `--slot-save-path`. Non-null
     * only on the supervised path (we know what we passed); the cache
     * adapter reads it via {@link getSlotSavePath} to wire its disk-
     * persistence flow.
     */
    slotSavePath?: string;
    /** See {@link LlamaCppProvider.classifyLine}. Default: `classifyStartupLine`. */
    classifyLine?: (line: string) => StartupPhase | null;
  }) {
    if (!opts.supervisor && !opts.baseUrl) {
      throw new Error('[llama-cpp] need either a supervisor or baseUrl');
    }
    if (opts.supervisor && opts.baseUrl) {
      throw new Error('[llama-cpp] supervisor and baseUrl are mutually exclusive');
    }
    if (opts.supervisor) this.supervisor = opts.supervisor;
    if (opts.baseUrl) this.externalBaseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Only register an evictor when we own the lifecycle. External-baseUrl
    // mode targets a llama-server the user runs themselves; we don't get
    // to stop their process.
    if (opts.arbiter && opts.supervisor) {
      this.arbiter = opts.arbiter;
      if (opts.evictorOwnerId) this.evictorOwnerId = opts.evictorOwnerId;
      this.arbiter.registerEvictor(
        'llm',
        () => opts.supervisor!.stop(),
        opts.evictorOwnerId ?? 'default',
      );
    }
    // llama-server ignores the `model` field when only one model is
    // loaded; use a short placeholder that still shows up sensibly in
    // usage logs. Real per-install default comes from config.
    this.defaultModel = opts.defaultModel ?? 'llama-cpp';
    if (opts.catalogModelId) this.catalogModelId = opts.catalogModelId;
    if (opts.modelManager) this.modelManager = opts.modelManager;
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
    this.plannedReservation = opts.plannedReservationBytes;
    this.includeUsageInStream = opts.includeUsageInStream ?? false;
    this.replayReasoningContent = opts.replayReasoningContent ?? false;
    this.visionEnabled = opts.visionEnabled ?? false;
    this.disableThinkingRequestShape = opts.disableThinkingRequestShape ?? 'chat-template';
    this.reasoningEffortRequestShape = opts.reasoningEffortRequestShape ?? 'none';
    this.classifyLine = opts.classifyLine ?? classifyStartupLine;
    // 5-minute defaults match Ollama. Generous enough to cover a 30B
    // model's cold load + prefill on a single-GPU consumer box, tight
    // enough that a wedged stream doesn't strand the runtime and the
    // user retries within a coffee break. The `GEZEL_LLAMA_CPP_STREAMING_IDLE_MS`
    // env var lets the eval harness (which has its own retry-loop watchdog
    // that fires at ~3 min of sniff-plateau) tighten this without changing
    // the production default — wild-caught squisq-review:
    // qwen3.6 stream went silent mid-generation, harness retry-loop killed
    // the trial 2m 45s later, well before the 5-min provider watchdog had
    // a chance to abort and salvage the buffered content.
    const envIdleMs = parseEnvMs(process.env.GEZEL_LLAMA_CPP_STREAMING_IDLE_MS);
    this.streamingIdleMs = opts.streamingIdleMs ?? envIdleMs ?? 300_000;
    // Pre-first-byte budget covers KV-cold prefill + engine warm-up.
    // Hardware tiering empirically calibrated against the qwen3.5-9b
    // matrix runs:
    //   - default 600s — adequate for x64 + non-Apple ARM and for warm
    //     Apple Silicon with the prompt cache hit.
    //   - 1500s on darwin-arm64 with ≤16 GB unified memory — cold-prefill
    //     of a 9B Q4 model with a ~16K-token system prompt on M2 Air
    //     blew through 600s AND 900s on every fresh gezel session in
    // the matrix. Same machine, same Q4 9B, cold KV,
    //     16K prefill → measured ~12-15 min. 1500s gives a 5-min
    //     headroom over the observed cliff without masking genuine
    //     hangs (the streaming-idle watchdog still catches mid-turn
    //     stalls at 300s).
    // `GEZEL_LLAMA_CPP_PRE_FIRST_BYTE_IDLE_MS` overrides both for ops
    // who need to tune further (e.g. 30B-class models on weaker hosts).
    const envPreFirstByteMs = parseEnvMs(process.env.GEZEL_LLAMA_CPP_PRE_FIRST_BYTE_IDLE_MS);
    const lowRamAppleSilicon =
      process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      os.totalmem() <= 17 * 1024 * 1024 * 1024;
    const platformDefaultPreFirstByteMs = lowRamAppleSilicon ? 1_500_000 : 600_000;
    this.preFirstByteIdleMs =
      opts.preFirstByteIdleMs ?? envPreFirstByteMs ?? platformDefaultPreFirstByteMs;
    this.postReasoningWatchdogMs = opts.postReasoningWatchdogMs ?? 30_000;
    const envConstrainedNoSignalMs = parseEnvMs(
      process.env.GEZEL_LLAMA_CPP_CONSTRAINED_TOOL_NO_SIGNAL_MS,
    );
    this.constrainedToolNoSignalMs =
      opts.constrainedToolNoSignalMs ??
      envConstrainedNoSignalMs ??
      constrainedToolNoSignalMsForModel(opts.catalogModelId ?? opts.defaultModel);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.logFile) this.logFile = opts.logFile;
    if (opts.slotSavePath) this.slotSavePath = opts.slotSavePath;
    const slots = opts.concurrency ?? 2;
    this.launchedSlots = slots;
    this.engineRequestWidth = slots;
    // A supervised engine's `concurrency` is the exact `--parallel` launch
    // width, so it is also the safe interactive batch width. Keep external
    // base-URL mode conservative: we may be configured with several client
    // queue sockets without knowing how many native slots that server owns.
    const batchMax = Math.max(1, opts.batchMaxConcurrency ?? (opts.supervisor ? slots : 1));
    this.batchMaxConcurrency = batchMax;
    // Slots are one fungible pool: chats may fill all of them. Background work
    // is the only capped lane (`backgroundLaneCap` = width - 1), so a live turn
    // can always start. Reserve at least ONE queue slot above the interactive
    // cap for the background lane so a mid-turn one-shot pinned to this provider
    // (compaction / memory extraction / summarization) can't deadlock behind a
    // full interactive lane — without it, a lone slot plus a synchronous
    // mid-turn compaction wedges the turn, the same failure the MLX
    // single-slot path hit. See the matching note in the MLX provider.
    const interactiveConcurrency = batchMax;
    const queueConcurrency =
      opts.reserveBackgroundSlot === false ? slots : Math.max(slots, interactiveConcurrency + 1);
    this.queue = new ProviderQueue({
      // llama-server is launched with `--parallel ${slots}` (see
      // `buildLlamaCppProvider` in chat/manager.ts) so the engine has matching
      // KV slots. The queue may have one extra logical background lane, while
      // `acquireExclusiveEngineRequest` caps actual cache+generation work at
      // `slots`. A background chore the foreground awaits can therefore enter
      // this queue and claim the physical slot between tool-loop round-trips,
      // without two sessions ever pinning the same native slot concurrently.
      concurrency: queueConcurrency,
      interactiveConcurrency,
      // Keyed to `slots` — the width `acquireExclusiveEngineRequest`
      // enforces — not to the queue's deadlock reserve. This is a no-op
      // for the serial and ds4 paths, where the old expression already
      // came out to `slots - 1`; it only widens the batched path, which
      // was pinned at 1. See `backgroundLaneCap`.
      backgroundConcurrency: backgroundLaneCap(slots),
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
      // A single local GPU: hold ambient housekeeping (nudges,
      // extraction, icon/about) while the user is actively engaged, so
      // a multi-minute chore turn never lands right before their next
      // move. Applies to ds4 too — its provider wraps this class.
      ambientQuietMs: defaultAmbientQuietMs(),
    });
  }

  /**
   * Record that a tool payload of `toolCount` was rejected by the engine's
   * grammar converter and needed `tier` to get through. See
   * {@link toolGrammarFloor}.
   *
   * Both fields widen monotonically: the smallest failing count (so the
   * floor covers every payload at least that large) and the most permissive
   * tier we have had to reach (so a later turn never starts below a rung
   * already known to be insufficient).
   */
  noteToolGrammarFloor(toolCount: number, tier: ToolGrammarFallback): void {
    if (tier === 'none' || toolCount <= 0) return;
    const prev = this.toolGrammarFloor;
    const prevRank = prev ? TOOL_GRAMMAR_FALLBACK_ORDER.indexOf(prev.tier) : -1;
    this.toolGrammarFloor = {
      minToolCount: Math.min(prev?.minToolCount ?? toolCount, toolCount),
      tier: TOOL_GRAMMAR_FALLBACK_ORDER.indexOf(tier) > prevRank ? tier : (prev?.tier ?? tier),
    };
  }

  /** Tier a request carrying `toolCount` tools should START at. */
  toolGrammarFloorFor(toolCount: number): ToolGrammarFallback {
    const floor = this.toolGrammarFloor;
    return floor && toolCount >= floor.minToolCount ? floor.tier : 'none';
  }

  /**
   * Set once the engine has rejected a forced tool call for this model, so
   * every later constrained turn — in this session and every sibling on the
   * same engine — advertises tools without `tool_choice: "required"` rather
   * than replaying a rejection the payload cannot fix.
   *
   * Engine-scoped and monotonic for the same reason as
   * {@link toolGrammarFloor}: the incompatibility is a property of the model
   * plus the server build, not of one turn's tools, so re-probing per turn
   * would burn a request each time a rescue fires — and rescues fire exactly
   * when the turn is already in trouble.
   */
  private forcedToolChoiceUnsupported = false;

  /** Record that this engine rejected `tool_choice: "required"`. */
  noteForcedToolChoiceUnsupported(): void {
    this.forcedToolChoiceUnsupported = true;
  }

  /** Whether a constrained turn may ask the engine to force a tool call. */
  get supportsForcedToolChoice(): boolean {
    return !this.forcedToolChoiceUnsupported;
  }

  /**
   * Batch capability — llama-server serves `--parallel N` concurrent KV
   * slots, so when batched inference is enabled `maxConcurrency` is that
   * slot count; otherwise 1 (we don't opt into co-batching). See
   * {@link LLMProvider.batch}.
   */
  get batch(): BatchCapability {
    return { maxConcurrency: this.batchMaxConcurrency };
  }

  /**
   * Cache adapter (Phase 1+) — set by ChatManager after construction
   * and read by sessions on every send to derive `cache_prompt` +
   * `id_slot` extras. Null when no controller is wired (cloud-only
   * install, tests).
   */
  private cacheAdapter: import('./cache-adapter.js').LlamaCppCacheAdapter | null = null;
  private slotSavePath?: string;
  private readonly launchedSlots: number;

  setCacheAdapter(adapter: import('./cache-adapter.js').LlamaCppCacheAdapter): void {
    this.cacheAdapter = adapter;
  }

  getCacheAdapter(): import('./cache-adapter.js').LlamaCppCacheAdapter | null {
    return this.cacheAdapter;
  }

  /**
   * Directory passed to llama-server's `--slot-save-path` on launch.
   * The cache adapter reads this to wire slot save/restore I/O.
   * Undefined on external-baseUrl mode (we don't control the launch).
   */
  getSlotSavePath(): string | undefined {
    return this.slotSavePath;
  }

  /**
   * The `--parallel` slot count this provider was constructed for — the
   * ENGINE's slot space, which is what the cache adapter must size its
   * slot model to. Deliberately NOT `queue.concurrency`: the queue
   * reserves a background lane ABOVE the engine slots
   * (`max(slots, interactive+1)`), so on a single-slot launch the queue
   * reads 2 — and an adapter sized off it binds sessions to slot ids the
   * server doesn't have. Wild-caught 2026-08-03: the adapter "bound"
   * slot 1 on a `--parallel 1` server; every save/restore against it
   * would 400 silently, and the debug probe's slot narration was fiction.
   */
  getLaunchedSlots(): number {
    return this.launchedSlots;
  }

  /**
   * Claim one physical llama-server request slot.
   *
   * This is deliberately narrower than {@link queue}: a logical turn holds its
   * ProviderQueue lease across the whole tool loop, while this lease covers one
   * cache-prepare + `/v1/chat/completions` round-trip. On a one-slot launch that
   * lets a synchronous background one-shot run between foreground iterations,
   * but prevents the wild-caught failure where a recovery nudge saved/restored
   * slot 0 while another session was still generating on slot 0, leaving the
   * native prompt processor stuck forever.
   */
  async acquireExclusiveEngineRequest(
    label: string,
    signal?: AbortSignal,
    onWait?: (info: { aheadOf: number }) => void,
  ): Promise<() => void> {
    if (signal?.aborted) throw engineRequestAbortError(label);
    if (this.supervisor?.coordinatesCapacity) await this.supervisor.yieldForWaitingCapacity(signal);

    const waitStartedAt = Date.now();
    if (this.engineRequestsActive < this.engineRequestWidth) {
      this.engineRequestsActive++;
    } else {
      let waitNotice: ReturnType<typeof setInterval> | null = null;
      let waitNoticeDelay: ReturnType<typeof setTimeout> | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter: (typeof this.engineRequestWaiters)[number] = {
            resolve,
            reject,
            ...(signal ? { signal } : {}),
          };
          if (signal) {
            waiter.onAbort = () => {
              const idx = this.engineRequestWaiters.indexOf(waiter);
              if (idx === -1) return;
              this.engineRequestWaiters.splice(idx, 1);
              signal.removeEventListener('abort', waiter.onAbort!);
              reject(engineRequestAbortError(label));
            };
            signal.addEventListener('abort', waiter.onAbort, { once: true });
          }
          this.engineRequestWaiters.push(waiter);
          // This wait was invisible to everything above it. A logical turn
          // holds its ProviderQueue lease across the whole tool loop, so a
          // turn that already cleared that queue can still park HERE for the
          // full length of another session's round-trip — on a one-slot
          // launch, minutes — emitting nothing but a debug line. The user
          // saw a turn with no queue badge and no tokens, which the silence
          // banner then reported as a wedged model.
          if (onWait) {
            const publish = () => {
              const idx = this.engineRequestWaiters.indexOf(waiter);
              if (idx === -1) return;
              onWait({ aheadOf: this.engineRequestsActive + idx });
            };
            waitNoticeDelay = setTimeout(() => {
              publish();
              waitNotice = setInterval(publish, QUEUE_WAIT_NOTICE_REPEAT_MS);
              waitNotice.unref?.();
            }, QUEUE_WAIT_NOTICE_DELAY_MS);
            waitNoticeDelay.unref?.();
          }
        });
      } finally {
        if (waitNoticeDelay) clearTimeout(waitNoticeDelay);
        if (waitNotice) clearInterval(waitNotice);
      }
    }

    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs > 1_000) {
      log.debug(`[llama-cpp] engine request ${label} waited ${waitedMs}ms for a physical slot`);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.engineRequestWaiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        // Hand the physical slot straight to the next waiter. The active count
        // stays unchanged across the handoff, so it can never exceed width.
        next.resolve();
      } else {
        this.engineRequestsActive--;
      }
    };
  }

  /**
   * Current base URL (when supervised) or the externally-configured
   * one. `undefined` when the supervised engine hasn't started yet —
   * the cache adapter treats that as "engine not ready, return empty
   * usage."
   */
  currentBaseUrl(): string | null {
    if (this.externalBaseUrl) return this.externalBaseUrl;
    return this.supervisor?.currentBaseUrl() ?? null;
  }

  /** True only while this native engine is serving or queuing a physical request. */
  isEngineBusy(): boolean {
    return this.engineRequestsActive > 0 || this.engineRequestWaiters.length > 0;
  }

  engineLifecycleSnapshot(): NativeEngineLifecycleSnapshot | undefined {
    return this.supervisor?.lifecycleSnapshot();
  }

  async initialize(): Promise<void> {
    // No client object to construct. The supervisor starts the child
    // lazily on the first `sendAndWait` — keeping initialize() a
    // no-op avoids spinning up the engine just because someone asked
    // the provider to exist.
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async shutdown(): Promise<void> {
    // Poison FIRST so a turn racing the shutdown can't lazily respawn
    // llama-server after the stop below (see `disposed` field doc).
    this.disposed = true;
    // Only pool replicas (explicit ownerId) unregister: a singleton's
    // 'default' registration may have been replaced by a successor
    // instance, and unregistering here would drop the successor's.
    if (this.arbiter && this.supervisor && this.evictorOwnerId) {
      this.arbiter.unregisterEvictor('llm', this.evictorOwnerId);
    }
    // Flush slot caches BEFORE stopping the supervisor — once
    // llama-server exits the slot save endpoint is gone. flushAll is
    // best-effort; failures during shutdown shouldn't block the stop.
    if (this.cacheAdapter) {
      try {
        await this.cacheAdapter.flushAll();
      } catch {
        // Best-effort persistence — failure here just means the next
        // boot pays the prefill cost on resume, same as before.
      }
    }
    await this.supervisor?.stop();
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    if (this.disposed) {
      throw new ProviderDisposedError('llama-cpp');
    }
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[llama-cpp]');
    return new LlamaCppSession({
      resolveBaseUrl: () => this.resolveBaseUrl(),
      acquireGpuLease: () => this.acquireGpuLease(),
      markUsed: () => this.supervisor?.markUsed(),
      ...(this.supervisor
        ? {
            waitForNativeEngineExit: async (sinceMs: number) =>
              await this.supervisor?.waitForUnexpectedExitSince?.(sinceMs),
          }
        : {}),
      fetchImpl: this.fetchImpl,
      model: opts.model ?? this.defaultModel,
      numCtx: this.numCtx,
      includeUsageInStream: this.includeUsageInStream,
      replayReasoningContent: this.replayReasoningContent,
      visionEnabled: this.visionEnabled,
      disableThinkingRequestShape: this.disableThinkingRequestShape,
      reasoningEffortRequestShape: this.reasoningEffortRequestShape,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      reasoningBudgetOverride: () => process.env.GEZEL_LLAMA_REASONING_BUDGET_TOKENS,
      systemMessage: opts.systemMessage,
      ...(opts.systemPromptLayers ? { systemPromptLayers: opts.systemPromptLayers } : {}),
      ...(opts.volatileContext ? { volatileContext: opts.volatileContext } : {}),
      // Pass widened priorMessages through — the session translates
      // tool-role entries into ChatMessage tool_calls / role:'tool'
      // entries at construction time.
      priorMessages: opts.priorMessages ?? [],
      bridges,
      queue: this.queue,
      provider: this,
      streamingIdleMs: this.streamingIdleMs,
      preFirstByteIdleMs: this.preFirstByteIdleMs,
      postReasoningWatchdogMs: this.postReasoningWatchdogMs,
      constrainedToolNoSignalMs: this.constrainedToolNoSignalMs,
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
      ...(opts.requestCompaction ? { requestCompaction: opts.requestCompaction } : {}),
      ...(opts.forceDirectFileWork ? { forceDirectFileWork: true } : {}),
      ...(opts.directFileWorkTargetPath
        ? { directFileWorkTargetPath: opts.directFileWorkTargetPath }
        : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.activeCraftbookStep ? { activeCraftbookStep: opts.activeCraftbookStep } : {}),
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
      ...(opts.terminalToolPolicy ? { terminalToolPolicy: opts.terminalToolPolicy } : {}),
    });
  }

  getContextWindow(): number {
    return this.numCtx;
  }

  /**
   * Live engine launch provenance (granted context, slots, KV dtype) from
   * the supervisor — undefined in external base-URL mode or when no child
   * process is up. See `LLMProvider.engineLaunchSnapshot`.
   */
  engineLaunchSnapshot(): EngineLaunchSnapshot | undefined {
    return this.supervisor?.launchSnapshot();
  }

  /**
   * Weights + KV at the granted window/cache mode, from the launch
   * admission pass. See `LLMProvider.plannedReservationBytes`.
   */
  plannedReservationBytes(): number | undefined {
    return this.plannedReservation;
  }

  /**
   * Classifier hook the supervisor wires into its `onRawLine`. Runs
   * on every stdout/stderr line from llama-server; when the line
   * maps to a known startup phase, fans the descriptor out to every
   * currently-waiting session so the UI surfaces "loading model 42%"
   * instead of a silent spinner.
   *
   * Public so `buildLlamaCppProvider` can register it on the
   * supervisor it constructs; not something external callers should
   * invoke directly.
   */
  onStdoutLine(line: string): void {
    // Reasoning-budget transitions are out-of-band engine signals,
    // not startup-phase events. When the engine reports the natural
    // end of its reasoning budget, fan the signal to every active
    // session so each can arm its post-reasoning silent-stall
    // watchdog. Slot-id attribution isn't available on these lines
    // (they're emitted before the next `slot ...` line carrying the
    // id), so we fan out; sessions that ARE streaming content will
    // cancel their watchdog on the next `delta.content` and the
    // fan-out is harmless for them.
    //
    // Match the exact upstream wording — line shape has been stable
    // across recent llama.cpp versions, and a loose regex risks
    // false-positives on test logs or future format changes.
    if (line.includes('reasoning-budget: deactivated (natural end)')) {
      for (const s of this.activeSessions) {
        try {
          s.notifyReasoningEnded();
        } catch (err) {
          log.warn(
            `[llama-cpp] notifyReasoningEnded threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const phase = this.classifyLine(line);
    if (!phase) return;

    // Accumulate memory footprint from every buffer-allocation line
    // the classifier identifies. Runs BEFORE the dedupe check below
    // so two tensor-load lines with identical "size =" text still
    // both count (different buffers usually have distinct sizes, but
    // an edge case shouldn't silently discard memory).
    if (phase.bufferBytes !== undefined && phase.bufferBytes > 0) {
      this.accumulatedRamBytes += phase.bufferBytes;
    }

    // On `ready` — engine has finished loading. Publish the total
    // RAM figure to every active session, remember it for late
    // joiners, and reset the counter for the next engine lifecycle
    // (idle-stop + restart = fresh allocation).
    if (phase.phase === 'ready' && this.accumulatedRamBytes > 0) {
      const stats = { ramAllocBytes: this.accumulatedRamBytes };
      this.lastEngineStats = stats;
      for (const s of this.activeSessions) s.publishEngineStats(stats);
      this.accumulatedRamBytes = 0;
    }

    // Dedupe against the last seen phase so a burst of `load_tensors:`
    // lines doesn't flood the event bus. Same phase + same detail =
    // don't republish. A counter-carrying line (ds4's decode ticker) has
    // no detail at all, so the token count joins the key — otherwise
    // every tick after the first would dedupe away and the live counter
    // would freeze at its opening value.
    if (
      this.lastStartupPhase &&
      this.lastStartupPhase.phase === phase.phase &&
      this.lastStartupPhase.detail === phase.detail &&
      this.lastStartupPhase.outputTokens === phase.outputTokens
    ) {
      return;
    }
    const phaseEvent: EnginePhaseEvent = {
      provider: 'llama-cpp',
      phase: phase.phase,
      ...(phase.detail ? { detail: phase.detail } : {}),
      ...(typeof phase.progress === 'number' ? { progress: phase.progress } : {}),
      ...(typeof phase.outputTokens === 'number' ? { outputTokens: phase.outputTokens } : {}),
      ...(typeof phase.tokensPerSec === 'number' ? { tokensPerSec: phase.tokensPerSec } : {}),
    };
    this.lastStartupPhase = phase.phase === 'ready' ? null : phaseEvent;
    for (const s of this.activeSessions) s.publishEnginePhase(phaseEvent);
  }

  /**
   * Surface the rolling log-file handle so the service's HTTP layer
   * can tail it for the Settings → On-device log viewer. Returns
   * undefined when no supervised process is running (external
   * baseUrl mode — there's no stdout for us to capture).
   */
  getLogFile(): LlamaCppLogFile | undefined {
    return this.logFile;
  }

  /** Internal — called by LlamaCppSession to register itself for startup fan-out. */
  _registerActiveSession(session: LlamaCppSession): void {
    this.activeSessions.add(session);
    // If we already have a startup phase in-flight (another session
    // triggered the engine boot), replay it to the new session so it
    // isn't stuck on a bare spinner until the next log line.
    if (this.lastStartupPhase) session.publishEnginePhase(this.lastStartupPhase);
    // Same replay for engine stats — a session opened after the
    // engine is warm still deserves to know the RAM footprint for
    // its UI dropdown, without waiting for a restart.
    if (this.lastEngineStats) session.publishEngineStats(this.lastEngineStats);
  }

  _deregisterActiveSession(session: LlamaCppSession): void {
    this.activeSessions.delete(session);
  }

  async listModels(): Promise<ModelInfo[]> {
    // Enumerate every installed model so pickers and `/v1/models`
    // advertise the full set the engine pool can actually serve —
    // not just the one currently resident. Mirrors MlxProvider.
    if (this.modelManager) {
      try {
        const installed = await this.modelManager.listInstalled();
        if (installed.length > 0) {
          return installed.map((m) => {
            const sizeGb = m.approxSizeBytes / (1024 * 1024 * 1024);
            const sizeLabel = sizeGb >= 0.1 ? ` · ${sizeGb.toFixed(1)} GB` : '';
            const ctxLabel = m.contextWindow ? ` · ${Math.round(m.contextWindow / 1024)}k ctx` : '';
            return {
              id: m.id,
              name: `${m.name}${sizeLabel}${ctxLabel}`,
              supportsTools: true,
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            };
          });
        }
      } catch {
        // Fall through to the default-only entry — enumeration is a
        // UI/discovery nicety, not load-bearing for chat.
      }
    }
    // No manager wired (external-baseUrl mode) or nothing installed:
    // a single entry describing the running config.
    return [
      {
        id: this.defaultModel,
        name: this.defaultModel,
        supportsTools: true,
      },
    ];
  }

  getEffectiveModelId(): string | undefined {
    return this.catalogModelId;
  }

  private async resolveBaseUrl(): Promise<string> {
    if (this.externalBaseUrl) return this.externalBaseUrl;
    if (this.disposed) {
      throw new Error('[llama-cpp] provider disposed (engine was evicted) — re-resolve it');
    }
    if (!this.supervisor) throw new Error('[llama-cpp] no base URL resolver configured');
    // Acquire the GPU slot BEFORE asking the supervisor to start. In
    // `swap` policy this evicts a running image engine so its VRAM is
    // released by the time llama-server tries to load weights. In
    // `coexist` policy the call returns immediately. The arbiter is
    // only set on the supervised path (see constructor).
    if (this.arbiter) await this.arbiter.acquire('llm');
    const ensureStartedAt = Date.now();
    let launch: NativeEngineLaunch;
    try {
      launch = await this.supervisor.ensureRunning();
    } catch (err) {
      const nativeExit = this.supervisor.lastExitSnapshot?.();
      if (nativeExit && !nativeExit.expected && nativeExit.exitedAt >= ensureStartedAt) {
        throw new NativeEngineCrashedError(nativeExit, err);
      }
      throw err;
    }
    return launch.baseUrl.replace(/\/+$/, '');
  }

  private async acquireGpuLease(): Promise<(() => void) | undefined> {
    if (this.externalBaseUrl || !this.arbiter) return undefined;
    return this.arbiter.acquireLease('llm');
  }
}
