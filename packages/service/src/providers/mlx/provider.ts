/**
 * MlxProvider — talks to a local `mlx_lm.server` subprocess over HTTP.
 * The server speaks OpenAI-compatible `/v1/chat/completions` with SSE
 * streaming; tool calling rides the standard OpenAI function-tool
 * shape, same as llama-cpp.
 *
 * Platform: **darwin-arm64 only**. Apple Silicon's unified memory +
 * Metal Performance Shaders are what make MLX fast; there's no MLX
 * backend for Intel Mac, Linux, or Windows. `ChatManager.ensureProvider`
 * gates the branch on platform; this file assumes Apple Silicon.
 *
 * Session model is stateless (same as llama-cpp / Ollama): full
 * transcript lives in memory and is re-sent per turn.
 * `ProviderSessionState` is empty — the session record on disk is the
 * source of truth.
 *
 * Lifecycle of the mlx_lm.server process is managed by a
 * {@link NativeEngineSupervisor}: lazy-start on first turn, idle-stop,
 * health-watch, restart budget. Startup is usually slower than
 * llama-cpp (Python import + PyTorch/MLX init) so we give it a 180s
 * startup budget.
 *
 * First-time install of mlx-lm itself is handled outside this file —
 * `buildMlxProvider` in ChatManager calls `UvRuntime.ensureVenv('mlx',
 * [mlxLmSpec])` before spawning the supervisor, ensuring the venv +
 * packages exist.
 */

import { randomUUID } from 'node:crypto';

import { createLogger, leaksUntaggedReasoning } from '@bendyline/gezel';
import type { ToolsMlxTemplateFixConfig } from '../../model-profile/behaviors/tools-mlx-template-fix.js';
import type { TurnRambleDetectionConfig } from '../../model-profile/behaviors/turn-ramble-detection.js';
import {
  extractReasoningWithProfile,
  profileBehaviorConfig,
  profileHasBehavior,
} from '../../model-profile/runtime.js';
import { familyToToolGrammarHint } from '../../model-profile/tool-grammar.js';
import { MLX_TUNING_MAP, applyTuning } from '../../model-profile/tuning.js';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import { prepareSalvagedCodeBlocks } from '../code-block-salvage.js';
import { DeliverableReadPaceTracker } from '../deliverable-read-pacing.js';
import {
  appendTruncationHintToToolResult,
  buildUnknownToolNudge,
  describeMalformation,
  findBareInvokeToolCallSpans,
  findClaudeInvokeToolCallSpans,
  findGlmToolCallSpans,
  findHermesFunctionToolCallSpans,
  findHermesFunctionToolCallSpansLenient,
  findProseToolCallSpans,
  findShellToolCallSpans,
  findTruncatedJsonEnvelope,
  findTruncatedProseToolCall,
  findUnrecognizedFunctionMarkup,
  findUnrecognizedToolEnvelope,
  findXmlTagToolCallSpans,
  foldPostActionRumination,
  foldPreToolPreamble,
  formatToolMenu,
  parseGemmaNativeToolCall,
  parseGemmaToolCall,
  parseJsonEnvelopeToolCalls,
  salvageWriteShapedTruncation,
  stripBareInvokeToolCallsFromText,
  stripClaudeInvokeToolCallsFromText,
  stripGlmToolCallsFromText,
  stripHermesFunctionToolCallsFromText,
  stripJsonEnvelopesFromText,
  stripProseToolCallsFromText,
  stripShellToolCallsFromText,
  stripXmlTagToolCallsFromText,
  uniqueWantedToolNames,
} from '../local-tool-call-salvage.js';
import { McpBridgePool } from '../mcp-bridge-pool.js';
import { computeToolBudgetChars } from '../mcp-bridge.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { readSseEvents } from '../openai-compatible/sse.js';
import { ProviderQueue, defaultAmbientQuietMs, runInQueue } from '../queue.js';
import { RambleDetector } from '../ramble-detector.js';
import {
  type EnginePhaseEvent,
  type EngineStatsEvent,
  StreamingSessionBase,
} from '../streaming-session.js';
import { terminalToolClosingText } from '../terminal-tool-policy.js';
import { ToolFailureTracker } from '../tool-failure-tracker.js';
import { ToolRepeatTracker } from '../tool-repeat-tracker.js';
import type {
  BatchCapability,
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMProvider,
  LLMSession,
  ModelInfo,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
  TurnUsage,
} from '../types.js';
import {
  PROJECT_MACRO_INTERCEPT_CAP,
  deriveProjectMacroClosing,
} from './project-macro-loop-bail.js';
import {
  type MlxFatalError,
  classifyMlxFatalErrorLine,
  classifyMlxStartupLine,
} from './stdout-parser.js';
import { LeakyToolCallStripper } from './tool-call-stripper.js';

const MAX_TOOL_LOOP_TURNS = 96;
// Hard per-turn ceiling when the caller doesn't pass `opts.timeoutMs`.
// 10 minutes matches what the manager passes for local providers in
// short-form sessions; the original 3-minute floor was too tight for
// 26B+ models doing heavy reasoning. Manager calls always override
// this with `OLLAMA_TURN_TIMEOUT_MS` (30 min); the constant here is
// only the fallback for one-shot / test paths.
const DEFAULT_TIMEOUT_MS = 600_000;
// Fallback for direct/external provider construction where no catalog model
// metadata is available. Supervised catalog models pass their native context
// window explicitly from buildMlxProvider.
const DEFAULT_NUM_CTX = 65_536;
// File-producing turns need enough room for the tool arguments themselves.
// The Developer template selects `thinking-coding`, whose normal 2,048-token
// budget truncated single-file HTML games mid-script. Treat 4,096 as a floor,
// matching llama.cpp's immediate-write path; user/model tuning may still grant
// more. This is intentionally not a cap.
const FILE_WRITE_MIN_TOKENS = 4_096;
// Max automatic append_to_file continuations after an immediate-write
// truncation before we bail with the partial. Each continuation is one
// bounded turn that writes the next chunk — comfortably above any
// single-file scenario deliverable while preventing a runaway. Replaces
// the old "bail after one truncated write and hope the next turn appends"
// path: the weak model had no append_to_file in its surface and just rambled
// instead (wild-caught tankcombat: a 5.8 KB game truncated at the former
// short output budget and the model never continued it).
const MAX_IMMEDIATE_WRITE_CONTINUATIONS = 6;
// Minimal `append_to_file` surfaced ONLY during a write-continuation. The
// base immediate-write surface is write_file-only; on truncation we add
// this so the model can emit the file's missing tail instead of
// re-writing the whole thing (which would just truncate again).
// Constructed inline so it doesn't depend on the role-filtered bridge
// surface, which deliberately hides append_to_file from builders.
const APPEND_TO_FILE_CONTINUATION_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'append_to_file',
    description:
      'Append text to the END of an existing workspace file. Use this to write the remaining tail of a file whose previous write_file was truncated mid-content. Do not repeat content already on disk — start exactly where the file currently ends.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file to append to.' },
        content: {
          type: 'string',
          description: 'Text appended verbatim at the current end of the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
};
const IMMEDIATE_FILE_WRITE_PROMPT_SUFFIX =
  '\n\n[Local-model rescue: make this a compact first pass. Your entire visible output should be one `write_file` tool call. Prioritize a complete, runnable file over decorative extras; include every requested behavior and any named asset path. Do not include planning prose.]';

const log = createLogger('mlx');
/**
 * Cap on how many times we'll nudge the model to retry a malformed
 * tool call within a single turn before giving up. Two attempts is
 * enough that a model with a transient slip can correct itself, low
 * enough that a model that just can't form structured calls (small
 * quants, certain Gemma variants) doesn't burn the whole turn budget.
 */
const MAX_MALFORMED_RETRIES = 2;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  images?: string[];
}

interface ChatCompletionTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    index: number;
    delta: { role?: string; content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  /**
   * mlx_vlm.server emits Responses-API field names (`input_tokens` /
   * `output_tokens`) while older OpenAI-compatible servers (including
   * llama.cpp's, ollama's, and the Chat Completions reference shape)
   * use `prompt_tokens` / `completion_tokens`. We accept both so this
   * type can flex across engines if we ever point the provider at
   * a different OpenAI-compatible host. mlx_vlm also ships
   * `prompt_tps` (prefill speed, set on first chunk) and
   * `generation_tps` (running decode speed, updated per chunk).
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tps?: number;
    generation_tps?: number;
    /** Prompt tokens actually served from the MLX KV cache. */
    cached_tokens?: number;
  };
}

function chatCompletionToolName(tool: ChatCompletionTool): string | undefined {
  return tool.function.name;
}

function isImmediateFileWriteTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (!tools || tools.length !== 1) return false;
  if (chatCompletionToolName(tools[0]!) !== 'write_file') return false;
  return (
    prompt.includes('There is still **no `index.html`** in the workspace') ||
    prompt.includes('Do not end your turn until `write_file`') ||
    prompt.includes('write_file({ path:')
  );
}

function setChatTemplateKwarg(body: Record<string, unknown>, key: string, value: unknown): void {
  const existing = body.chat_template_kwargs;
  if (existing && typeof existing === 'object' && existing !== null) {
    (existing as Record<string, unknown>)[key] = value;
    return;
  }
  body.chat_template_kwargs = { [key]: value };
}

function expectedDeliverableIsFile(value: unknown): boolean {
  let deliverable = value;
  if (typeof deliverable === 'string') {
    const trimmed = deliverable.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      deliverable = JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  if (!deliverable || typeof deliverable !== 'object') return false;
  return (deliverable as { kind?: unknown }).kind === 'file';
}

function asyncFileHandoffClosing(count: number): string {
  return count === 1
    ? 'I sent the file handoff. The specialist has the project context and should write the deliverable to disk.'
    : `I sent ${count} file handoffs. The specialists have the project context and should write the deliverables to disk.`;
}

function immediateFileWriteClosing(paths: string[]): string {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) return 'I wrote the requested file to the workspace.';
  if (unique.length === 1) return `I wrote \`${unique[0]}\` to the workspace.`;
  return `I wrote ${unique.map((path) => `\`${path}\``).join(', ')} to the workspace.`;
}

export class MlxProvider implements LLMProvider {
  readonly name = 'mlx' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  readonly supportsPriorMessages = true;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly externalBaseUrl?: string;
  private readonly defaultModel: string;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;
  /** Set in {@link shutdown}; a disposed provider must never respawn its engine. */
  private disposed = false;
  /**
   * Catalog manager — when set, `listModels()` enumerates every model
   * the user has installed via Settings → This Mac so the model picker
   * in Settings → AI can pick from the full list. Optional because
   * external-baseUrl mode (`GEZEL_MLX_SERVER_URL`) skips the catalog
   * entirely. The picker selection writes back to
   * `config.defaultModel.mlx` as a catalog id; `buildMlxProvider`
   * resolves the id to a `modelDir` on the next provider rebuild.
   */
  private readonly modelManager?: import('./models.js').MlxModelManager;
  /**
   * Friendly model name for the engine pill — e.g. "Qwen 3.5 8B".
   * Surfaced in `loading_model` phase events as "Loading model
   * (<name>)" so the user knows *which* MLX model is loading. Empty
   * when the catalog manager wasn't wired in (external base URL mode)
   * or when the runtime path doesn't map to a catalog entry — the
   * pill falls back to the bare "Loading model" label in those cases.
   */
  private readonly modelDisplayName?: string;
  /**
   * Catalog model id for the on-disk model the provider is serving —
   * `qwen3.6-27b-mlx`, `gemma4-e4b-mlx`, etc. Distinct from
   * `defaultModel`, which holds the absolute model directory path
   * (mlx_vlm.server's PRELOAD_MODEL value). Surfaced via
   * {@link getEffectiveModelId} so the chat manager can resolve a
   * tier for sessions that don't have an explicit model selection
   * (`record.model` undefined AND `config.defaultModel.mlx`
   * undefined). Without this, those sessions classify as
   * `tier:tiny` because the tier resolver gets a path it can't parse.
   *
   * Empty when the provider was constructed in external-baseUrl mode
   * (we don't know what the user's mlx-server is serving) or before
   * the catalog has resolved a default model.
   */
  private readonly catalogModelId?: string;
  private readonly activeSessions = new Set<MlxSession>();
  private lastStartupPhase: EnginePhaseEvent | null = null;
  // Replayed to sessions that register after the engine finishes
  // loading — same pattern as llama-cpp's `lastEngineStats` — so a
  // chat started mid-run can surface the memory footprint in the
  // pill dropdown without restarting the engine.
  private lastEngineStats: EngineStatsEvent | null = null;
  // Guards against multiple RSS samples from a single "ready" line
  // (e.g. when uvicorn logs both "Application startup complete" and
  // "Uvicorn running" — both classify as `ready`).
  private engineStatsPending = false;
  // Latest fatal error seen on mlx_lm.server's stderr — the server's
  // httpd keeps accepting connections after `_generate` dies, so we
  // can't trust /health. When this is non-null, `sendAndWait` short-
  // circuits with this error instead of letting requests hang on an
  // unresponsive completions endpoint. Cleared on supervisor restart.
  private fatalError: MlxFatalError | null = null;
  /**
   * Width-N gate over actual engine requests. The width is the engine's
   * batch capability ({@link batchMaxConcurrency}). At width 1 — MLX today,
   * one stream at a time — this behaves exactly like the old serial
   * promise chain: strict FIFO, a single engine request in flight. When
   * the wrapped server gains batched generation, a wider gate lets up to N
   * requests run concurrently for the server to coalesce, with no other
   * scheduler change.
   */
  private engineGateActive = 0;
  private readonly engineGateWaiters: Array<() => void> = [];
  private readonly batchMaxConcurrency: number;

  constructor(opts: {
    supervisor?: NativeEngineSupervisor;
    baseUrl?: string;
    defaultModel?: string;
    numCtx?: number;
    concurrency?: number;
    /**
     * Engine batch width — how many sequences the wrapped MLX server can
     * generate truly concurrently. Today the server is single-stream, so
     * this defaults to 1 (serial) and {@link acquireExclusiveEngineRequest}
     * behaves exactly like the old serial gate. Raising it (once the server
     * gains batched generation) widens the gate and switches the queue to
     * the adaptive interactive policy — no scheduler change.
     */
    batchMaxConcurrency?: number;
    affinity?: boolean;
    fetchImpl?: typeof fetch;
    modelManager?: import('./models.js').MlxModelManager;
    modelDisplayName?: string;
    /** See {@link MlxProvider.catalogModelId} for the contract. */
    catalogModelId?: string;
  }) {
    if (!opts.supervisor && !opts.baseUrl) {
      throw new Error('[mlx] need either a supervisor or baseUrl');
    }
    if (opts.supervisor && opts.baseUrl) {
      throw new Error('[mlx] supervisor and baseUrl are mutually exclusive');
    }
    if (opts.supervisor) this.supervisor = opts.supervisor;
    if (opts.baseUrl) this.externalBaseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.defaultModel = opts.defaultModel ?? 'mlx';
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.modelManager) this.modelManager = opts.modelManager;
    if (opts.modelDisplayName) this.modelDisplayName = opts.modelDisplayName;
    if (opts.catalogModelId) this.catalogModelId = opts.catalogModelId;
    const batchMax = Math.max(1, opts.batchMaxConcurrency ?? 1);
    this.batchMaxConcurrency = batchMax;
    const batching = batchMax > 1;
    // Interactive turns are capped at the memory-safe engine width (`batchMax`);
    // the engine gate below (`acquireExclusiveEngineRequest`) enforces the same
    // bound on real generation. The queue itself, though, must run at least ONE
    // slot ABOVE that cap, reserved for the background lane — otherwise a
    // mid-turn one-shot pinned to THIS provider (in-flight compaction, memory
    // extraction, summarization; all `lane: 'background'`) can't dispatch while
    // the foreground turn awaits it. At width 1 without the reserve, the turn
    // holds the only slot and its own compaction one-shot deadlocks behind it
    // forever: the turn awaits a job that can't start, and the one-shot's
    // timeout only arms AFTER it acquires a slot. That is exactly what wedged
    // sessions "mid-turn" once the memory ceiling clamped a big model to width 1.
    // The +1 admits the chore WITHOUT ever running a 2nd concurrent generation —
    // the engine gate, not queue width, is the OOM guard.
    const interactiveConcurrency = batching ? batchMax : 1;
    const queueConcurrency = Math.max(opts.concurrency ?? 1, interactiveConcurrency + 1);
    this.queue = new ProviderQueue({
      concurrency: queueConcurrency,
      interactiveConcurrency,
      backgroundConcurrency: Math.max(1, queueConcurrency - interactiveConcurrency),
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
      // Single local GPU — same ambient admission control as llama-cpp:
      // housekeeping turns wait for a quiet window so they never wedge
      // the lane right before the user's next message.
      ambientQuietMs: defaultAmbientQuietMs(),
    });
  }

  /**
   * Batch capability — the wrapped MLX server generates one sequence at a
   * time today, so `maxConcurrency` is 1 (serial) unless raised once it
   * gains batched generation. See {@link LLMProvider.batch}.
   */
  get batch(): BatchCapability {
    return { maxConcurrency: this.batchMaxConcurrency };
  }

  /**
   * Cache adapter (Phase 1+). Set by ChatManager after construction.
   * Phase 2 wires the real `MlxCacheAdapter` that talks to the
   * wrapped `gezel_mlx_server.py`. Sessions call its
   * `buildRequestExtras` on every send to derive `cache_id`.
   */
  private cacheAdapter: import('./cache-adapter.js').MlxCacheAdapter | null = null;

  setCacheAdapter(adapter: import('./cache-adapter.js').MlxCacheAdapter): void {
    this.cacheAdapter = adapter;
  }

  getCacheAdapter(): import('./cache-adapter.js').MlxCacheAdapter | null {
    return this.cacheAdapter;
  }

  /**
   * Current engine base URL — `null` when the supervised engine
   * hasn't started yet. Cache adapter polls treat null as "not
   * ready" and return empty stats.
   */
  currentBaseUrl(): string | null {
    if (this.externalBaseUrl) return this.externalBaseUrl;
    return this.supervisor?.currentBaseUrl() ?? null;
  }

  async acquireExclusiveEngineRequest(label: string): Promise<() => void> {
    const width = this.batchMaxConcurrency;
    const waitStartedAt = Date.now();
    if (this.engineGateActive < width) {
      this.engineGateActive++;
    } else {
      // Park FIFO until a release hands us its slot. The active count
      // stays at `width` across the handoff, so we never exceed it — at
      // width 1 this is exactly the old serial promise chain.
      await new Promise<void>((resolve) => this.engineGateWaiters.push(resolve));
    }
    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs > 1_000) {
      log.debug(`engine request ${label} waited ${waitedMs}ms for an MLX engine slot`);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.engineGateWaiters.shift();
      if (next) {
        // Hand our slot straight to the next waiter — active count unchanged.
        next();
      } else {
        this.engineGateActive--;
      }
    };
  }

  async runExclusiveEngineRequest<T>(label: string, work: () => Promise<T>): Promise<T> {
    const release = await this.acquireExclusiveEngineRequest(label);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async initialize(): Promise<void> {
    // No-op — supervisor starts the child lazily on first sendAndWait.
  }

  async shutdown(): Promise<void> {
    // Poison FIRST so a turn racing the shutdown can't lazily respawn
    // the engine after the stop below. The engine pool evicts replicas
    // by calling `shutdown()`; a session still holding this instance
    // must error out instead of resurrecting a zombie process outside
    // the pool's capacity accounting.
    this.disposed = true;
    await this.supervisor?.stop();
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    if (this.disposed) {
      throw new Error('[mlx] provider disposed (engine was evicted) — re-resolve it');
    }
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[mlx]');
    return new MlxSession({
      resolveBaseUrl: () => this.resolveBaseUrl(),
      markUsed: () => this.supervisor?.markUsed(),
      fetchImpl: this.fetchImpl,
      model: opts.model ?? this.defaultModel,
      numCtx: this.numCtx,
      systemMessage: opts.systemMessage,
      ...(opts.systemPromptLayers ? { systemPromptLayers: opts.systemPromptLayers } : {}),
      ...(opts.volatileContext ? { volatileContext: opts.volatileContext } : {}),
      // Pass widened priorMessages through — the session translates
      // tool-role entries into ChatMessage tool_calls / role:'tool'
      // entries in its constructor.
      priorMessages: opts.priorMessages ?? [],
      bridges,
      queue: this.queue,
      provider: this,
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
      ...(opts.debug ? { debug: opts.debug } : {}),
      ...(opts.requestCompaction ? { requestCompaction: opts.requestCompaction } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.activeCraftbookStep ? { activeCraftbookStep: opts.activeCraftbookStep } : {}),
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
      ...(opts.forceDirectFileWork ? { forceDirectFileWork: true } : {}),
      ...(opts.terminalToolPolicy ? { terminalToolPolicy: opts.terminalToolPolicy } : {}),
    });
  }

  /** Classifier hook wired into the supervisor's `onRawLine`. */
  onStdoutLine(line: string): void {
    // Fatal error takes precedence over phase classification — one
    // `ValueError: ...` leaf line in a traceback is enough to mark
    // the engine broken. We kill the supervisor so a subsequent
    // `ensureRunning()` respawns fresh (and hits the same error if
    // nothing's changed, but at least surfaces it immediately rather
    // than hanging for the full turn-timeout window).
    const fatal = classifyMlxFatalErrorLine(line);
    if (fatal) {
      this.handleFatalError(fatal);
      return;
    }
    const phase = classifyMlxStartupLine(line);
    if (!phase) return;
    // Surface the model name in the engine pill during the long
    // weight-load window so the user sees "Loading model — Qwen 3.5"
    // instead of a bare "Loading weights". Only augments when we
    // actually know the friendly name — otherwise the classifier's
    // generic "Loading weights" stands.
    if (phase.phase === 'loading_model' && this.modelDisplayName) {
      phase.detail = `Loading model — ${this.modelDisplayName}`;
    }
    // A fresh child — clear any stale fatal error from the previous
    // lifecycle so this spawn gets a clean slate. If it errors again
    // during boot, handleFatalError will capture the new one.
    if (phase.phase === 'starting') this.fatalError = null;
    if (
      this.lastStartupPhase &&
      this.lastStartupPhase.phase === phase.phase &&
      this.lastStartupPhase.detail === phase.detail
    ) {
      return;
    }
    this.lastStartupPhase = phase.phase === 'ready' ? null : phase;
    for (const s of this.activeSessions) s.publishEnginePhase(phase);
    if (phase.phase === 'ready') this.scheduleEngineStatsSample();
  }

  /**
   * Called by MlxSession before each send so it fails fast when the
   * supervised engine is known-broken instead of queuing a request
   * that will hang on the dead httpd. Returns the error to throw, or
   * null when the engine looks healthy.
   *
   * Consumes on read — the caller still throws the returned error, so
   * the *current* send fails fast, but subsequent sends get a fresh
   * shot at respawning the engine. Without this, a fix the user made
   * out-of-process (reinstalled missing Python deps, swapped to a
   * working model in Settings, ran a Reset venv) wouldn't take effect
   * until the whole gezeld process restarted — every send would keep
   * replaying the cached error from the failed startup. The next
   * `starting` phase from a successful respawn re-clears via
   * `onStdoutLine`; this is the bridge for the in-between window.
   */
  takeFatalError(): MlxFatalError | null {
    const fatal = this.fatalError;
    this.fatalError = null;
    return fatal;
  }

  private handleFatalError(fatal: MlxFatalError): void {
    // First-seen wins — subsequent traceback frames shouldn't
    // overwrite the leaf exception with something further up the
    // stack. Also avoids thrashing the supervisor if the server
    // spams the same error repeatedly before we kill it.
    if (this.fatalError) return;
    this.fatalError = fatal;
    log.error(`fatal engine error detected: ${fatal.message}`);
    // If a session is blocked inside `supervisor.ensureRunning()`
    // waiting on `/health`, abortStartup rejects that wait with the
    // real error right now instead of letting it run the full
    // startup-timeout budget (up to 5 minutes). The subsequent
    // session-level catch turns this into the red error bubble in
    // chat. If we're not currently starting, abortStartup is a
    // no-op and the next send hits `takeFatalError()` on entry.
    const hintSuffix = fatal.hint ? `\n\n${fatal.hint}` : '';
    const err = new Error(`[mlx] engine failed to start: ${fatal.message}${hintSuffix}`);
    this.supervisor?.abortStartup(err);
    // Tear the child down so the next `ensureRunning()` respawns
    // fresh. abortStartup handles in-flight startups; this cleans
    // up the already-running-but-broken case.
    void this.supervisor?.stop().catch(() => {});
  }

  /**
   * Sample mlx_lm.server's resident-set size a moment after it reports
   * itself ready — mlx_lm doesn't log buffer allocations the way
   * llama.cpp does, so RSS is the cheapest proxy for "how much RAM
   * is this engine using". We delay 2s so memory-mapped weights have
   * settled; earlier samples undercount.
   */
  private scheduleEngineStatsSample(): void {
    if (this.engineStatsPending) return;
    if (!this.supervisor) return;
    this.engineStatsPending = true;
    setTimeout(async () => {
      try {
        const pid = this.supervisor?.currentChildPid();
        if (!pid) return;
        const rssBytes = await readProcessRssBytes(pid);
        if (rssBytes === null) return;
        const stats: EngineStatsEvent = { provider: 'mlx', ramAllocBytes: rssBytes };
        this.lastEngineStats = stats;
        for (const s of this.activeSessions) s.publishEngineStats(stats);
      } finally {
        this.engineStatsPending = false;
      }
    }, 2_000).unref?.();
  }

  _registerActiveSession(session: MlxSession): void {
    this.activeSessions.add(session);
    if (this.lastStartupPhase) session.publishEnginePhase(this.lastStartupPhase);
    if (this.lastEngineStats) session.publishEngineStats(this.lastEngineStats);
  }

  _deregisterActiveSession(session: MlxSession): void {
    this.activeSessions.delete(session);
  }

  async listModels(): Promise<ModelInfo[]> {
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
            };
          });
        }
      } catch {
        // Fall through to the default-only entry below — model
        // enumeration is a UI nicety, not load-bearing for chat.
      }
    }
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
      throw new Error('[mlx] provider disposed (engine was evicted) — re-resolve it');
    }
    if (!this.supervisor) throw new Error('[mlx] no base URL resolver configured');
    const launch = await this.supervisor.ensureRunning();
    return launch.baseUrl.replace(/\/+$/, '');
  }
}

interface MlxSessionDeps {
  resolveBaseUrl: () => Promise<string>;
  markUsed: () => void;
  fetchImpl: typeof fetch;
  model: string;
  numCtx: number;
  systemMessage: string;
  /** Layered prefix-cache keys (flag ON only). See {@link SystemPromptLayers}. */
  systemPromptLayers?: import('../../cache/adapter.js').SystemPromptLayers;
  /** Volatile band seeded as a frozen system message after messages[0] (flag ON only). */
  volatileContext?: string;
  priorMessages: Array<
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  bridges: McpBridgePool;
  /**
   * Caller-supplied external tool definitions. Advertised to mlx-lm's
   * OpenAI-compatible endpoint alongside any bridge tools; calls
   * against these names halt the loop rather than executing — captured
   * via {@link LLMSession.capturedToolCalls}.
   */
  externalTools?: ExternalToolSpec[];
  queue: ProviderQueue;
  provider: MlxProvider;
  debug?: { isEnabled(): boolean };
  /**
   * Mid-tool-loop compaction hook — see {@link SessionOpts.requestCompaction}.
   * Same shape as the llama-cpp + ollama paths; the manager wires it
   * to a one-shot synthesis call when the active provider is local.
   */
  requestCompaction?: NonNullable<SessionOpts['requestCompaction']>;
  /**
   * Resolved per-model behavior profile. Same role as Ollama's: gates
   * the ramble detector + pre-tool preamble fold on profile opt-in.
   */
  profile?: ResolvedModelProfile;
  /** Active craftbook step — passed to anti-spin abort messages. */
  activeCraftbookStep?: NonNullable<SessionOpts['activeCraftbookStep']>;
  /**
   * Resolved sampling / reasoning / output / tool-choice knobs. Built
   * by ChatManager from `gezel.tuning` + `catalog.manifest.tuning` and
   * applied to the request body via `MLX_TUNING_MAP`. When unset, the
   * provider sends only the request shape's required fields and lets
   * mlx-vlm fall back to its own defaults.
   */
  tuning?: import('../../model-profile/index.js').ResolvedTuning;
  /** Manager-authoritative direct file-work classification. */
  forceDirectFileWork?: boolean;
  terminalToolPolicy?: NonNullable<SessionOpts['terminalToolPolicy']>;
}

/** See `MID_LOOP_COMPACT_RATIO` in llama-cpp/provider.ts. */
const MID_LOOP_COMPACT_RATIO = 0.7;
const MID_LOOP_COMPACT_MIN_PRIOR = 4;

class MlxSession extends StreamingSessionBase implements LLMSession {
  private readonly messages: ChatMessage[];
  /**
   * Direct provider callers and ephemeral one-shot work do not always have a
   * persisted chat-session id to put in `opts.queue.sessionId`. The wrapped
   * MLX server treats a missing `cache_id` as an instruction to clear the KV
   * cache after every request, which makes every tool-loop continuation pay a
   * full re-prefill. Keep a stable id for this MlxSession as the fallback;
   * normal chats still override it with their durable Gezel session id.
   */
  private readonly fallbackCacheId = `mlx-session-${randomUUID()}`;
  private fallbackCacheUsed = false;
  // Monotonic counter across `sendAndWait` calls on this session. Used as a
  // tag in diagnostic logs so the per-turn lifecycle (queue dispatch → fetch
  // → SSE start → SSE end) can be reassembled even when overlapping with
  // other sessions in the daemon log. Helped diagnose mlx_vlm.server SSE
  // termination issues where turn N completed cleanly but turn N+1 hung.
  private sendSeq = 0;
  /** See LlamaCppSession.currentTurnStartIdx — same role here. */
  private currentTurnStartIdx = 0;
  private compactedThisTurn = false;
  /**
   * Aggregated `<think>` / `<reasoning>` text captured this turn,
   * across every iteration of the tool loop. Reset at the top of each
   * `sendAndWaitInner`. ChatManager reads it via
   * `getLastTurnReasoning()` after the turn resolves and stashes the
   * trace on the assistant message so the chat bubble can render it
   * behind a collapsed expander.
   */
  private lastTurnReasoning = '';

  /**
   * Tool-call bodies the salvage layer couldn't parse on the most
   * recent turn after the retry budget exhausted. Captured at the
   * budget-exhausted branch and read by ChatManager via
   * `getLastTurnAttemptedToolCalls()` to stash on the assistant
   * message for the debug bundle. Reset at the top of `sendAndWaitInner`.
   */
  private lastTurnAttemptedToolCalls: Array<{ body: string; reason?: string }> = [];

  /**
   * Watchdog reset hook owned by the in-flight `sendAndWaitInner`. Set
   * just before the fetch fires; cleared in the turn's cleanup. While
   * non-null, any engine-phase event arriving via `publishEnginePhase`
   * counts as "the model is making progress" and resets the idle timer.
   * Without this, large-prompt prefill (e.g. 30K tokens at 230 tok/s ≈
   * 2 minutes) trips the pre-first-byte watchdog even though the
   * python child is happily chunking through prefill — the SSE stream
   * is silent until the very first generated token.
   */
  private currentTurnIdleReset: (() => void) | null = null;

  /**
   * Last prefill phase event seen during the current turn — captured
   * for the abort message so the user sees "aborted at prefill 47% /
   * 14336 of 29930 tokens" instead of just "no first byte." Cleared
   * at the start of every send.
   */
  private lastPrefillEvent: { progress: number; detail: string; at: number } | null = null;

  private readonly externalToolNames: Set<string>;
  private capturedCalls: ExternalToolCall[] = [];

  constructor(private readonly deps: MlxSessionDeps) {
    super();
    this.externalToolNames = new Set((deps.externalTools ?? []).map((t) => t.name));
    this.messages = [{ role: 'system', content: deps.systemMessage }];
    // Layered prefix caching (flag ON): the volatile band rides as a
    // SEPARATE frozen system message after the stable system message, so
    // the stable `[system][tools]` wire prefix stays reusable.
    if (deps.volatileContext) {
      this.messages.push({ role: 'system', content: deps.volatileContext });
    }
    for (const m of deps.priorMessages) {
      if (m.role === 'tool') {
        this.messages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId,
        });
        continue;
      }
      if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        continue;
      }
      this.messages.push({ role: m.role, content: m.content });
    }
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this.capturedCalls];
  }

  get numCtx(): number {
    return this.deps.numCtx;
  }

  estimatePromptChars(): number {
    let total = 0;
    for (const m of this.messages) {
      if (typeof m.content === 'string') total += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls)
          total += tc.function.arguments.length + tc.function.name.length;
      }
    }
    if (!this.deps.bridges.isEmpty()) {
      for (const t of this.deps.bridges.getOpenAITools()) {
        total += JSON.stringify(t).length;
      }
    }
    return total;
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  getLastTurnAttemptedToolCalls(): Array<{ body: string; reason?: string }> | undefined {
    return this.lastTurnAttemptedToolCalls.length > 0 ? this.lastTurnAttemptedToolCalls : undefined;
  }

  publishEnginePhase(ev: EnginePhaseEvent): void {
    // Capture the latest prefill state so the pre-first-byte abort
    // message (when it does fire) can attribute the stall to a real
    // observed point in the prefill arc.
    if (ev.phase === 'prefill' && typeof ev.progress === 'number') {
      this.lastPrefillEvent = {
        progress: ev.progress,
        detail: ev.detail ?? '',
        at: Date.now(),
      };
    }
    // Reset the in-flight turn's idle watchdog. Any engine-phase event
    // (prefill chunk, model-load tick, ready signal) is real evidence
    // the python child is making progress, even though the SSE stream
    // hasn't yielded its first token yet.
    this.currentTurnIdleReset?.();
    this.emitEnginePhase(ev);
  }

  publishEngineStats(ev: EngineStatsEvent): void {
    this.emitEngineStats(ev);
  }

  /**
   * See {@link LlamaCppSession.maybeCompactMidLoop} — same contract.
   * MLX shares the same in-memory transcript pattern, so the same
   * pressure-and-swap logic applies.
   */
  private async maybeCompactMidLoop(): Promise<void> {
    if (this.compactedThisTurn) return;
    if (!this.deps.requestCompaction) return;
    const estimatedTokens = Math.ceil(this.estimatePromptChars() / 4);
    const ratio = estimatedTokens / this.deps.numCtx;
    if (ratio < MID_LOOP_COMPACT_RATIO) return;
    const prior: Array<{ role: string; content: string }> = [];
    for (let i = 1; i < this.currentTurnStartIdx; i++) {
      const m = this.messages[i]!;
      if (typeof m.content === 'string' && m.content.length > 0) {
        prior.push({ role: m.role, content: m.content });
      }
    }
    if (prior.length < MID_LOOP_COMPACT_MIN_PRIOR) return;
    let result: { syntheticContent: string } | null = null;
    try {
      result = await this.deps.requestCompaction({
        priorMessages: prior,
        estimatedTokens,
        numCtx: this.deps.numCtx,
      });
    } catch (err) {
      log.warn(
        `[mlx] mid-loop compaction request failed (continuing un-compacted): ${err instanceof Error ? err.message : String(err)}`,
      );
      this.compactedThisTurn = true;
      return;
    }
    if (!result) {
      this.compactedThisTurn = true;
      return;
    }
    const removed = this.currentTurnStartIdx - 1;
    this.messages.splice(1, removed, {
      role: 'assistant',
      content: result.syntheticContent,
    });
    this.currentTurnStartIdx = 2;
    this.compactedThisTurn = true;
    log.info(
      `mid-loop compacted ${removed} prior message(s) → 1 synthesis (${result.syntheticContent.length} chars)`,
    );
    this.emitWarning(
      'Compacted earlier conversation to free up working window for the current turn.',
    );
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // Queue-bypass path: sync consultations spawned via ask_specialist /
    // ask_gezel would otherwise deadlock behind the asker's held slot
    // (the asker is parked in `bridges.callTool` waiting for the
    // consultation's reply — chicken-and-egg). The wrapped Python
    // server's per-stream lock still serializes generation against
    // any other concurrent request, so bypassing the TS-side FIFO
    // only loses the queue's affinity scoring, not safety.
    if (opts?.queue?.bypassQueue) return this.sendAndWaitInner(prompt, opts);
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // Fail fast if the supervisor already saw mlx_lm.server die at
    // startup. The httpd process can keep returning 200 on /health
    // after `_generate` raises, so without this check we'd spend the
    // full turn timeout hanging on an unresponsive
    // /v1/chat/completions endpoint with no user-facing signal.
    const fatal = this.deps.provider.takeFatalError();
    if (fatal) {
      const hintSuffix = fatal.hint ? `\n\n${fatal.hint}` : '';
      throw new Error(`[Mac AI] engine failed to start: ${fatal.message}${hintSuffix}`);
    }

    const totalTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeoutMs;
    const start = Date.now();
    const seq = ++this.sendSeq;
    const debugOn = this.deps.debug?.isEnabled() === true;
    // Always-on lifecycle tag — low frequency, high signal when piecing
    // together "first turn worked, second never returned". Includes the
    // pre-existing message count so the sequence in the log unambiguously
    // shows whether the prior assistant reply landed in `this.messages`
    // before this turn started.
    log.info(`turn#${seq} START prompt=${prompt.length}c msgs=${this.messages.length}`);

    const userMsg: ChatMessage = { role: 'user', content: prompt };
    if (opts?.attachments && opts.attachments.length > 0) {
      userMsg.images = opts.attachments.map((a: ImageAttachment) => a.base64);
    }
    // Mark this turn's start so mid-loop compaction can split prior
    // history (compactable) from in-flight tool loop (preserve verbatim).
    // See LlamaCppSession.sendAndWaitInner for the rationale.
    this.currentTurnStartIdx = this.messages.length;
    this.compactedThisTurn = false;
    // Reset captured reasoning at the top of each turn — manager
    // reads `getLastTurnReasoning()` after this resolves.
    this.lastTurnReasoning = '';
    // Same lifecycle for the attempted-tool-calls capture: read once
    // by manager after the turn resolves, populated only when the
    // salvage retry budget exhausts below.
    this.lastTurnAttemptedToolCalls = [];
    this.messages.push(userMsg);

    // Reset captures — each sendAndWait surfaces only its own externals.
    this.capturedCalls = [];
    const bridgeTools = this.deps.bridges.isEmpty()
      ? []
      : toChatCompletionsTools(this.deps.bridges);
    const externalAsChatCompletions: ChatCompletionTool[] = (this.deps.externalTools ?? []).map(
      (t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters,
        },
      }),
    );
    const tools =
      bridgeTools.length + externalAsChatCompletions.length > 0
        ? [...bridgeTools, ...externalAsChatCompletions]
        : undefined;
    // Names of tools the model actually sees this turn. This must be
    // derived from the advertised request surface, not the raw bridge
    // inventory: role filtering hides tools from builders, but the bridge
    // can still call them internally. Salvage and execution must not
    // promote hidden-tool prose into real side effects.
    const advertisedBridgeToolNames = new Set(
      bridgeTools.map((t) => chatCompletionToolName(t)).filter((n): n is string => !!n),
    );
    const knownToolNames = new Set(
      (tools ?? []).map((t) => chatCompletionToolName(t)).filter((n): n is string => !!n),
    );
    // Param-name → owning-tool-names index, so an unknown-tool nudge can
    // catch the model naming a PARAMETER as the function (e.g. `description`
    // is an argument of `start_project`, not a tool). Built once per send.
    const toolParamIndex = new Map<string, string[]>();
    for (const t of tools ?? []) {
      const tname = chatCompletionToolName(t);
      if (!tname) continue;
      const props = (t.function.parameters as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      if (!props) continue;
      for (const param of Object.keys(props)) {
        const arr = toolParamIndex.get(param);
        if (arr) {
          if (!arr.includes(tname)) arr.push(tname);
        } else {
          toolParamIndex.set(param, [tname]);
        }
      }
    }
    // Surgical edit tools on the roster ⇒ the deliverable is a modify of
    // an existing file, so a repeated source-write failure should steer
    // toward a targeted patch rather than "re-emit the whole file."
    const surgicalEditsAvailable =
      knownToolNames.has('replace_in_file') ||
      knownToolNames.has('insert_at_marker') ||
      knownToolNames.has('replace_lines') ||
      knownToolNames.has('append_to_file');
    // Delegation tools on the roster ⇒ repeated edit failures can hand the
    // file to a more capable model instead of thrashing to a plain abort.
    const delegationAvailable = [...knownToolNames].some((n) => n.startsWith('delegate_'));
    // Counter for the model self-correction loop: each malformed tool
    // call we nudge the model about counts against this budget. Not
    // reset between iterations — a turn with two consecutive bad calls
    // burns through both retries instead of looping forever.
    let malformedRetries = 0;
    // Signature of the last unparseable/unknown tool-call we nudged about.
    // If the model emits the IDENTICAL bad call again after a nudge, the
    // nudge isn't landing — stop spending retries on a repeat (the actionable
    // nudge already fired once) and end the turn instead of apology-looping.
    let lastBadCallSig: string | null = null;
    // Auto-continuation state for truncated immediate-writes. When an
    // immediate-write `write_file` is EOS-flushed (file larger than the
    // per-turn token cap), we keep the turn alive — surfacing
    // `append_to_file` and looping — until the model writes the tail
    // without truncating, or we hit MAX_IMMEDIATE_WRITE_CONTINUATIONS.
    let writeContinuationActive = false;
    let writeContinuations = 0;
    // Per-tool consecutive-failure tracker. Catches the Qwen 3.6 27B
    // pattern of emitting JSON-stringified args, hitting the same Zod
    // validation error every iteration, "diagnosing" the schema in
    // chat, and re-trying the same wrong shape forever. See the
    // tracker's docstring for the threshold rationale.
    const failureTracker = new ToolFailureTracker({ surgicalEditsAvailable, delegationAvailable });
    // Per-turn same-(name, args) repeat tracker. Catches the
    // "narrative spinning" loop where the model re-reads the same
    // files (read_task_notes, read_file, etc.) iteration after
    // iteration, narrating "let me plan" prose between each call,
    // never reaching write_file. See ToolRepeatTracker docstring for
    // the threshold rationale.
    const repeatTracker = new ToolRepeatTracker();
    const deliverableReadPaceTracker = DeliverableReadPaceTracker.fromUserText(prompt);
    // Per-turn `ask_user_question` guard. Once a question card lands
    // successfully, additional ask_user_question calls in the same
    // turn are intercepted with a synthetic "you already asked, end
    // your turn" response — without this, verbose-family models
    // double-post cards (the second one usually re-phrasing the
    // first; user gets a cluttered Home panel). The flag also
    // signals `foldPreToolPreamble` to fold trailing wrap-up prose
    // for the rest of the turn.
    let askedQuestionThisTurn = false;
    // Per-turn project-macro guard. `start_project` and `start_job`
    // are atomic high-stakes macros — each call creates a project +
    // voorman + kickoff task. Without this, a Gemma 4 cold-start
    // turn that emits multiple `<|tool_call|>start_project{...}<|/tool_call|>`
    // envelopes in one response (brainstorming variations of the
    // same idea) produces N duplicate projects. Wild-caught on a
    // clean install ("Can you create a space invaders
    // game?" → 5 projects with iterated names).
    let startedProjectOrJobThisTurn: { tool: string; firstResult: string } | null = null;
    // Count redundant macro intercepts within this turn. Once the
    // per-turn guard arms (after the first successful start_project /
    // start_job), every additional macro call gets intercepted with
    // a "STOP" message. Some local models (gemma4-26b on MLX, wild-caught)
    // misread that as "your call was
    // malformed, retry it" and keep emitting envelopes until
    // MAX_TOOL_LOOP_TURNS bails — minutes of blank bubble for the
    // user. After `PROJECT_MACRO_INTERCEPT_CAP` redundant attempts,
    // we force end-of-turn with a synthesized closing summary
    // derived from the first successful result.
    let projectMacroInterceptCount = 0;
    let forceProjectMacroBail: { closingText: string } | null = null;
    let fullText = '';
    let lastUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tps?: number;
      generation_tps?: number;
      cached_tokens?: number;
    } | null = null;
    let firstTokenAt: number | null = null;
    this.deps.provider._registerActiveSession(this);

    // Status heartbeat. The pre-first-token window — cache warm (prepareForSend)
    // plus prompt prefill — can run for minutes on a large prompt and emits no
    // stdout phases, so the engine pill would otherwise sit on a stale label
    // until "First token in …" finally lands. Re-emit a live, descriptive phase
    // every few seconds so the pill keeps a meaningful label (and its elapsed
    // clock) the whole time. Crucially this uses `emitEnginePhase` (UI bus only)
    // and NOT `publishEnginePhase`, so it does NOT reset the stall watchdog — a
    // genuinely hung engine still trips the idle abort.
    let prepLabel = 'Preparing…';
    const emitPrep = (): void => {
      if (firstTokenAt !== null) return;
      this.emitEnginePhase({ provider: 'mlx', phase: 'prefill', detail: prepLabel });
    };
    const statusHeartbeat = setInterval(emitPrep, 4_000);
    emitPrep();

    // Whether any earlier iteration of THIS turn fired an action tool.
    // Drives `foldPostActionRumination` on later reply-only iterations —
    // the per-iteration ramble detector and `foldPreToolPreamble` both
    // reset every iteration, which is exactly how a verbose model's
    // post-move analysis wall reached the visible reply (wild-caught:
    // gemma4-12b checkers, ~1,000 tokens where one line belonged).
    let actionFiredEarlierThisTurn = false;

    try {
      for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
        // Mid-loop pressure check — same shape as LlamaCppSession.
        // Skip the first iteration; from iteration 2 a freshly pushed
        // tool result can tip a healthy turn over the slot ctx.
        if (turn > 0) await this.maybeCompactMidLoop();

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`[Mac AI] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
        }

        const baseUrl = await this.deps.resolveBaseUrl();
        const body: Record<string, unknown> = {
          model: this.deps.model,
          messages: this.messages,
          stream: true,
          // Per-turn output cap. mlx-vlm's stream_generate defaults to
          // a small built-in cap (256 in some versions) — verbose
          // reasoning models burn through that on `<think>` blocks
          // alone and truncate mid-tool-call. 16 384 covers any
          // realistic chat turn; can be overridden per-model via
          // catalog `tuning.sampling.maxTokens`.
          max_tokens: 16_384,
        };
        // Per-model tuning. Replaces the Gemma-family-hardcoded sampling
        // values (temperature=1.0/top_p=0.95/top_k=64/repetition_penalty=1.1)
        // that used to live in this method. Catalog manifests own these
        // values now — see `tuning.sampling` on each chat-model identity.
        // When no catalog tuning is set, mlx-vlm falls back to its own
        // defaults (effectively greedy on older versions) — every
        // shipped manifest now declares sampling explicitly to avoid
        // that.
        if (this.deps.tuning) {
          applyTuning(body, this.deps.tuning, MLX_TUNING_MAP);
        }
        // Continuation-iteration output cap — see SendAndWaitOpts.
        // Iteration 0 keeps the catalog cap so a tool call is never cut
        // off before it starts; wrap-up iterations get the tight cap.
        if (turn > 0 && opts?.continuationMaxTokens && opts.continuationMaxTokens > 0) {
          const current =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(current, opts.continuationMaxTokens);
        }
        // Decode-time tool-call grammar (opt-in via the `tools.mlx-grammar`
        // behavior). Constrains the tool-call function name to the known
        // tools at sampling time so a quantized model can't hallucinate a
        // name — the gezel MLX server builds the llguidance grammar from
        // this hint plus the advertised `tools`. Family-derived because
        // Qwen's catalog toolCallFormat is the coarse `function-call`. The
        // TS salvage cascade below stays as the post-hoc safety net.
        if (
          tools &&
          tools.length > 0 &&
          profileHasBehavior(this.deps.profile, 'tools.mlx-grammar')
        ) {
          const grammarHint = familyToToolGrammarHint(this.deps.profile?.style);
          if (grammarHint) body.tool_grammar = grammarHint;
        }
        // Per-family chat-template fix (opt-in via `tools.mlx-template-fix`).
        // Swaps the model's stored Jinja template for a curated one at
        // request time (no reinstall); the server applies it via
        // `apply_chat_template(..., chat_template=...)`. No config (e.g.
        // env-forced in an A/B without a manifest template) → no override.
        const templateFix = profileBehaviorConfig<ToolsMlxTemplateFixConfig>(
          this.deps.profile,
          'tools.mlx-template-fix',
        );
        if (templateFix?.template) body.chat_template_override = templateFix.template;
        const immediateFileWriteTurn = isImmediateFileWriteTurn(prompt, tools);
        if (immediateFileWriteTurn) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model rescue:')
          ) {
            userMsg.content += IMMEDIATE_FILE_WRITE_PROMPT_SUFFIX;
          }
          const currentMax = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
          body.max_tokens = Math.max(currentMax, FILE_WRITE_MIN_TOKENS);
          body.temperature = 0.2;
          body.top_p = 0.8;
          setChatTemplateKwarg(body, 'enable_thinking', false);
          log.debug(
            `turn#${seq}.${turn} immediate-write mode: write_file-only surface, thinking disabled, max_tokens=${body.max_tokens}`,
          );
        }
        if (
          this.deps.forceDirectFileWork &&
          (typeof body.max_tokens !== 'number' || body.max_tokens < FILE_WRITE_MIN_TOKENS)
        ) {
          body.max_tokens = FILE_WRITE_MIN_TOKENS;
        }
        if (tools && tools.length > 0) body.tools = tools;
        // Tool-schema size breakdown (opt-in: GEZEL_PROMPT_BREAKDOWN=1). The
        // companion to buildInstructions' system-text breakdown — the tool JSON
        // schemas are prefilled alongside the system prompt, so this shows the
        // other half of the per-turn token cost. Once per send (turn 0 only).
        if (turn === 0 && process.env.GEZEL_PROMPT_BREAKDOWN === '1' && tools && tools.length > 0) {
          const serialized = JSON.stringify(tools);
          const top = [...tools]
            .map((t) => ({ name: chatCompletionToolName(t) ?? '?', ch: JSON.stringify(t).length }))
            .sort((a, b) => b.ch - a.ch)
            .slice(0, 12)
            .map(
              (t) =>
                `  ${String(Math.round(t.ch / 4)).padStart(5)} tok  ${String(t.ch).padStart(6)} ch  ${t.name}`,
            )
            .join('\n');
          log.info(
            `turn#${seq} [prompt-breakdown] tools: ${tools.length} defs · ` +
              `~${Math.round(serialized.length / 4)} tok (${serialized.length} ch). Largest:\n${top}`,
          );
        }
        // Write-continuation: add `append_to_file` to the surface so the
        // model can finish a truncated file by appending its tail. Only
        // active after an immediate-write truncation; the base surface
        // stays write_file-only so the FIRST write is still focused.
        if (writeContinuationActive && Array.isArray(body.tools)) {
          if (!body.tools.some((t) => chatCompletionToolName(t) === 'append_to_file')) {
            body.tools = [...body.tools, APPEND_TO_FILE_CONTINUATION_TOOL];
          }
        }
        // Cache reuse extras from the engine's adapter (Phase 2). Adds
        // `cache_id: <sessionId>` so our wrapped `gezel_mlx_server.py`
        // preserves and reuses the prompt cache across turns. Falls
        // back to no-extras (= upstream behavior, full re-prefill per
        // turn) when no adapter is wired (tests, no controller setup).
        // Phase 3 also hands the system prompt to the adapter so it can
        // register and warm a per-gezel prefix entry — first session
        // for a new gezel pays cold prefill, sibling sessions inherit
        // the warm prefix from disk on first turn.
        const adapter = this.deps.provider.getCacheAdapter();
        const durableCacheId = opts?.queue?.sessionId;
        const cacheId = durableCacheId ?? this.fallbackCacheId;
        if (adapter) {
          if (!durableCacheId) this.fallbackCacheUsed = true;
          await adapter.prepareForSend(
            cacheId,
            this.deps.systemMessage,
            this.deps.systemPromptLayers,
          );
          const extras = adapter.buildRequestExtras(cacheId);
          Object.assign(body, extras);
          // Diagnostic: one line per request so the next "Stream
          // finished, cleared cache" investigation is visible from
          // the TS side without grepping Python stdout. The Python
          // server prints `[cache] hit/miss cache_id=…` on its end;
          // cross-referencing both confirms the round-trip works.
          // Drop to `debug` once cache reuse is confirmed stable.
          if (turn === 0) {
            log.info(
              `turn#${seq} cache extras attached: cache_id=${String(extras.cache_id ?? '')} prefix_cache_id=${String(extras.prefix_cache_id ?? 'none')}`,
            );
          }
        } else if (turn === 0) {
          // The OTHER side of the diagnostic: when cache extras are
          // skipped, log WHY so we can tell from one line that the adapter
          // is unwired. Missing queue.sessionId is safe: cacheId falls back
          // to a stable id owned by this MlxSession. An unwired adapter means
          // the Python server clears its cache on finish and the next turn
          // pays full re-prefill — exactly
          // the prefill-loop the user reported on gemma4-26b.
          log.warn(
            `turn#${seq} cache extras NOT attached (full re-prefill expected): ` +
              `adapter=null cacheId=${cacheId}`,
          );
        }

        const releaseEngineRequest = await this.deps.provider.acquireExclusiveEngineRequest(
          `turn#${seq}.${turn}`,
        );
        if (Date.now() >= deadline) {
          releaseEngineRequest();
          throw new Error(`[Mac AI] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
        }
        const ctrl = new AbortController();
        const externalSignal = opts?.queue?.signal;
        // Tag which trigger fired the abort — distinguishes the
        // hard-timer vs caller-cancel paths in the log so a hang
        // diagnosed via "turn#N FETCH-ABORT timer" reads unambiguously
        // as a model timeout rather than a user-driven cancel.
        let abortReason: 'timer' | 'caller' | 'idle' | null = null;
        const onExternalAbort = () => {
          abortReason ??= 'caller';
          ctrl.abort();
        };
        if (externalSignal) {
          if (externalSignal.aborted) onExternalAbort();
          else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        // Wallclock-based deadline poll. The naive `setTimeout(remaining)`
        // pauses when macOS suspends the process during sleep, so a
        // turn started just before sleep stays "Preparing" for the
        // duration of the nap + the original budget — the user sees a
        // multi-thousand-second hang with no abort. A recurring
        // interval that compares `Date.now()` to the wallclock
        // `deadline` self-corrects on wake: setInterval also pauses
        // during sleep, but the first post-wake tick sees the
        // wallclock has moved past the deadline and aborts within ~2s
        // of resume. Drift is bounded by the poll interval, not the
        // sleep duration.
        const deadlineTicker = setInterval(() => {
          if (Date.now() < deadline) return;
          abortReason ??= 'timer';
          log.error(`turn#${seq}.${turn} ABORT-FIRED reason=timer afterMs=${Date.now() - start}`);
          ctrl.abort();
          clearInterval(deadlineTicker);
        }, 2_000);
        // Stream-idle watchdog. mlx_vlm.server has a known SSE
        // termination quirk where it stops emitting tokens mid-
        // stream without sending `[DONE]` and without closing the
        // connection — the for-await loop just hangs forever.
        // Without this watchdog the UI shows "still working" until
        // the hard deadline (3 min default) fires. The idle timer
        // anchors on every SSE event arrival; if the stream is
        // silent for `streamingIdleMs`, abort and let the catch
        // path surface what we have so far + a clear message.
        //
        // Pre-first-byte uses a longer budget because cold-start
        // model load + prefill on a 27B Qwen can legitimately take
        // minutes before the first token. The 180s budget covers a
        // cold model load before chunked prefill begins emitting
        // progress events; once `Prefill: …` lines start flowing,
        // `currentTurnIdleReset` (wired from `publishEnginePhase`)
        // anchors the watchdog on every prefill chunk so the timer
        // tracks real progress instead of wall-clock seconds.
        // Once tokens are flowing, a much tighter budget detects
        // mid-stream stalls without false-positive aborts on healthy
        // generation gaps.
        // Idle-watchdog budgets. Aligned with ollama / llama-cpp's
        // 300s defaults — earlier MLX-specific tighter values
        // (60s streaming, 180s pre-first-byte) were killing legitimate
        // 26B+ Gemma / Qwen turns that go silent for 60–120s while
        // doing heavy reasoning between tokens or hitting a slow
        // generation patch. The 30-min hard turn deadline from the
        // manager still bounds total runtime.
        //
        //   - PRE_FIRST_BYTE_IDLE_MS: cold-start budget before any
        //     SSE / progress event arrives. Covers model load +
        //     prompt prefill on a 26B model at heavy quant. Now SCALED
        //     by prompt size (computePreFirstByteBudgetMs) — a 37K-token
        //     turn on a 27B-q8 needs far longer to first token than a 2K
        //     "hello", and the old flat 300s aborted the big ones
        //     mid-prefill (the qwen3.6-27b voorman stall).
        //   - PRE_FIRST_BYTE_PER_PROGRESS_MS: budget to re-arm after a
        //     prefill event arrives pre-first-byte. Unified to the SAME
        //     size-scaled value: the serial path emits tqdm chunks every
        //     couple seconds (each just re-arms the generous bound — fine),
        //     while the batched path emits only a single "prefilling N
        //     tokens" start marker and then blocks the event loop through
        //     the whole prefill, so a tight per-chunk timer would
        //     false-abort it. One generous bound serves both.
        //   - STREAMING_IDLE_MS: budget between two consecutive SSE
        //     content events once tokens are flowing. Generous enough
        //     to cover a heavy reasoning gap on a 26B model.
        const approxPromptTokens = estimatePromptTokens(this.messages, body.tools);
        const PRE_FIRST_BYTE_IDLE_MS = computePreFirstByteBudgetMs(approxPromptTokens);
        const PRE_FIRST_BYTE_PER_PROGRESS_MS = PRE_FIRST_BYTE_IDLE_MS;
        const STREAMING_IDLE_MS = 300_000;
        if (turn === 0 || PRE_FIRST_BYTE_IDLE_MS > PRE_FIRST_BYTE_BASE_MS) {
          log.info(
            `turn#${seq}.${turn} pre-first-byte budget ${Math.round(PRE_FIRST_BYTE_IDLE_MS / 1000)}s ` +
              `(~${approxPromptTokens.toLocaleString('en-US')} prompt tokens)`,
          );
        }
        let idleAbortKind: 'pre-first-byte' | 'streaming' | null = null;
        let lastSseEventAt: number | null = null;
        let firstSseEventAt: number | null = null;
        let idleTimer = setTimeout(() => {
          idleAbortKind = 'pre-first-byte';
          abortReason ??= 'idle';
          log.error(
            `turn#${seq}.${turn} ABORT-FIRED reason=idle (pre-first-byte) afterMs=${Date.now() - start}`,
          );
          ctrl.abort();
        }, PRE_FIRST_BYTE_IDLE_MS);
        const resetIdle = () => {
          if (firstSseEventAt === null) firstSseEventAt = Date.now();
          lastSseEventAt = Date.now();
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleAbortKind = 'streaming';
            abortReason ??= 'idle';
            log.error(
              `turn#${seq}.${turn} ABORT-FIRED reason=idle (streaming) afterMs=${Date.now() - start}`,
            );
            ctrl.abort();
          }, STREAMING_IDLE_MS);
        };
        // Pre-first-byte progress reset — fires on prefill events
        // (and any other engine phase) arriving via the supervisor's
        // stdout fanout. Uses a tighter per-progress budget than the
        // initial cold-start budget: once we've seen one prefill
        // chunk, we know the engine is alive; the next chunk is
        // expected within ~PER_PROGRESS_MS at typical 200–250 tok/s
        // for 2K-token batches.
        const resetIdleFromPhaseEvent = () => {
          // Only meaningful before the first SSE byte. Once tokens
          // flow, `resetIdle()` (called inside the SSE loop) takes
          // over with the tighter STREAMING_IDLE_MS budget.
          if (firstSseEventAt !== null) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleAbortKind = 'pre-first-byte';
            abortReason ??= 'idle';
            log.error(
              `turn#${seq}.${turn} ABORT-FIRED reason=idle (pre-first-byte, after progress) afterMs=${Date.now() - start}`,
            );
            ctrl.abort();
          }, PRE_FIRST_BYTE_PER_PROGRESS_MS);
        };
        this.currentTurnIdleReset = resetIdleFromPhaseEvent;
        this.lastPrefillEvent = null;
        const cleanupTurn = () => {
          clearInterval(deadlineTicker);
          clearTimeout(idleTimer);
          this.currentTurnIdleReset = null;
          externalSignal?.removeEventListener('abort', onExternalAbort);
        };

        if (debugOn) {
          log.debug(
            `turn#${seq}.${turn} FETCH baseUrl=${baseUrl} model=${this.deps.model} ` +
              `bodyMsgs=${this.messages.length} tools=${tools?.length ?? 0}`,
          );
        }
        let res: Response;
        try {
          res = await this.deps.fetchImpl(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (err) {
          cleanupTurn();
          this.deps.markUsed();
          log.error(
            `turn#${seq}.${turn} FETCH-ERR ${(err as Error).name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          if ((err as Error).name === 'AbortError') {
            if (externalSignal?.aborted) {
              throw new Error('[Mac AI] turn cancelled by caller');
            }
            if (abortReason === 'idle') {
              // Idle-fired during the fetch itself (no response body yet).
              // If we observed prefill chunks, attribute the stall to the
              // last seen progress point — much more useful than "no
              // first byte" when the model was clearly working.
              throw new Error(buildPreFirstByteAbortMessage(this.lastPrefillEvent));
            }
            throw new Error(`[Mac AI] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
          }
          throw new Error(
            `[Mac AI] couldn't reach the engine at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!res.ok || !res.body) {
          cleanupTurn();
          this.deps.markUsed();
          const txt = await res.text().catch(() => '');
          log.error(`turn#${seq}.${turn} HTTP-ERR status=${res.status} ${res.statusText}`);
          throw new Error(translateMlxHttpError(res.status, res.statusText, txt));
        }
        if (debugOn) {
          log.debug(
            `turn#${seq}.${turn} HTTP-OK status=${res.status} ` +
              `headers={content-type:${res.headers.get('content-type') ?? '?'}}`,
          );
        }

        if (firstTokenAt === null) {
          // The request is in; we're now prefilling the prompt. Switch the
          // heartbeat label and emit once immediately so the pill updates
          // without waiting for the next heartbeat tick.
          prepLabel = 'Processing prompt';
          this.emitEnginePhase({ provider: 'mlx', phase: 'prefill', detail: prepLabel });
        }

        let turnContent = '';
        let finishReason: string | null = null;
        const toolCallAccumulator = new MlxToolCallAccumulator();
        // Code-block salvage (Phase: gemma-26b orchestration). When the
        // ramble detector aborts a turn with NO recognizable tool-call
        // markup but the buffered prose DOES contain a fenced code
        // block (the "Here's the file: ```html …```" pattern small
        // models drift into instead of calling write_file), we promote
        // each block to a synthesized `write_artifact` call. The
        // accumulator below lives outside the try/catch so the post-
        // exit merge can include it alongside the other salvage
        // sources.
        let codeBlockRepaired: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }> = [];
        // Wall-of-prose detector. Verbose-family models (Qwen 3.6
        // 27B at heavy quant in particular) emit a tool-call markup
        // block early in the turn, then continue narrating for
        // thousands of characters about what they "would" do next —
        // the failure mode the about.md "stuck planning" rule warns
        // about. The original boolean version of this detector
        // disarmed permanently after the first tool-call signal
        // and missed exactly that pattern; `RambleDetector` measures
        // prose-since-last-action so the cap re-arms after every
        // markup block.
        //
        // Threshold: 6000 chars (~1500 tokens) of prose past the
        // last action. Generous enough that legitimate medium-length
        // tail explanations pass through; tight enough to catch the
        // "wrote one tool then rambled" wall before the user has
        // waited 90+ seconds. Gated on profile opt-in via
        // `turn.ramble-detection`; per-model thresholds come from
        // the validated config. Absent → detector disabled.
        const rambleConfig = profileBehaviorConfig<TurnRambleDetectionConfig>(
          this.deps.profile,
          'turn.ramble-detection',
        );
        const ramble = rambleConfig
          ? new RambleDetector({
              threshold: rambleConfig.coldThreshold,
              postActionThreshold: rambleConfig.postActionThreshold,
              enabled: true,
              // Models that leak untagged reasoning narrate their plan
              // in the open before acting; give the cold cap room to
              // reach the tool call. Prefer the profile opt-in, but also
              // honor the model-id family signal so a verbose family whose
              // profile is missing `turn.preamble-folding` (config drift)
              // still gets the leaky budget instead of the tight 6k cap.
              leakyReasoning:
                profileHasBehavior(this.deps.profile, 'turn.preamble-folding') ||
                leaksUntaggedReasoning(this.deps.model),
            })
          : // Repetition guard is safe on any local model (fires only on
            // degenerate low-novelty loops); arm it even without the
            // length-cap opt-in. See RambleDetector.
            new RambleDetector({ threshold: 6000, enabled: false, repetitionGuardEnabled: true });
        let rambleAborted = false;
        // Tool name for the live tool-args channel — only the first
        // fragment of a streamed tool call carries `function.name`.
        let liveToolArgsName = '';
        // Drop chat-template tool-call markers (Gemma 3+ leaks
        // `<|tool_call|>...<tool_call|>` token text into the content
        // stream even though it ALSO ships a structured `tool_calls`
        // delta — the structured one is what the UI renders, the text
        // version is just noise). Streaming-safe: holds back fragments
        // that could be a partial marker prefix until disambiguated.
        const stripper = new LeakyToolCallStripper();
        // Throttle live phase emissions during generation so we don't
        // saturate the SSE fanout with one phase event per token —
        // ~3 Hz is fast enough that the tok/s readout feels live, slow
        // enough that the UI's React reconciler doesn't choke on a
        // 30-tok/s burst from a small model.
        let lastPhaseAt = 0;
        const PHASE_EMIT_MIN_INTERVAL_MS = 300;
        // Stream-active heartbeat to the daemon LOG (distinct from the UI-bus
        // phase emits above, which never reach stdout). The eval harness's
        // soft-progress watchdog digests daemon.log; with no periodic line
        // during a long MLX decode it reads active generation as a stall and
        // false-fails big models mid-first-turn. Mirror the llama-cpp
        // provider's `[<engine>] stream-active` pulse so the watchdog sees the
        // engine is alive. ~5s cadence keeps the log quiet.
        let lastStreamPulseAt = 0;
        const STREAM_PULSE_INTERVAL_MS = 5_000;
        // SSE-loop exit attribution. The loop can leave four ways:
        // explicit `[DONE]` marker (healthy), natural stream end with no
        // `[DONE]` (mlx_vlm.server bug — server closed before sentinel),
        // exception (caught below), or it never exits (caller sees the
        // hardTimer abort fire and the catch turns it into AbortError).
        // The terminator is logged unconditionally on the way out so the
        // smoking gun for "second turn hangs" shows up in regular logs.
        let sseChunks = 0;
        let sseExitReason: 'done' | 'stream-end' | 'error' = 'stream-end';
        try {
          for await (const event of readSseEvents(res.body)) {
            // Anchor the idle watchdog on every event — content
            // chunks AND framing chunks (usage updates, empty
            // deltas) all count as "stream is alive."
            resetIdle();
            sseChunks++;
            if (event === '[DONE]') {
              sseExitReason = 'done';
              break;
            }
            const chunk = event as ChatCompletionChunk;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            const hasContent = Boolean(delta?.content);
            const hasToolCalls = Boolean(delta?.tool_calls && delta.tool_calls.length > 0);
            // mlx_vlm.server emits Responses-API field names; older
            // OpenAI-compatible servers use the Chat-Completions ones.
            // Read both so this code works against either shape.
            const usage = chunk.usage;
            const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens;
            const completionTokens = usage?.output_tokens ?? usage?.completion_tokens;
            const promptTps = usage?.prompt_tps;
            const generationTps = usage?.generation_tps;
            const cachedTokens = usage?.cached_tokens;
            if (hasContent) {
              // Run the raw chunk through the marker stripper before
              // it lands anywhere user-visible. The TTFT / generating
              // phase emissions still fire on raw-chunk presence —
              // they're a "model is producing tokens" signal, not a
              // "user sees content" signal — so leaked-marker chunks
              // still tick the engine pill correctly even when the
              // visible output is empty.
              const safeContent = stripper.push(delta!.content!);
              if (safeContent.length > 0) turnContent += safeContent;
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
                const ttft = firstTokenAt - start;
                log.info(`TTFT ${ttft}ms (session model=${this.deps.model})`);
                // First-token detail folds in the prefill speed when
                // the engine surfaces it. Prefill happens entirely
                // inside `generate_step`, so this is the first chance
                // we get to put a number on it.
                const prefillSuffix =
                  promptTps && promptTps > 0 ? ` · prefill ${formatTps(promptTps)} tok/s` : '';
                this.emitEnginePhase({
                  provider: 'mlx',
                  phase: 'generating',
                  detail: `First token in ${(ttft / 1000).toFixed(1)}s${prefillSuffix}`,
                });
                lastPhaseAt = firstTokenAt;
              } else {
                const now = Date.now();
                if (
                  now - lastPhaseAt >= PHASE_EMIT_MIN_INTERVAL_MS &&
                  generationTps !== undefined &&
                  generationTps > 0 &&
                  completionTokens !== undefined
                ) {
                  this.emitEnginePhase({
                    provider: 'mlx',
                    phase: 'generating',
                    detail: `${formatTps(generationTps)} tok/s · ${completionTokens} tokens`,
                  });
                  lastPhaseAt = now;
                }
              }
              {
                // Watchdog heartbeat to the daemon log (see decl above).
                const now = Date.now();
                if (now - lastStreamPulseAt >= STREAM_PULSE_INTERVAL_MS) {
                  const tps =
                    generationTps && generationTps > 0
                      ? ` · ${formatTps(generationTps)} tok/s`
                      : '';
                  log.info(`[mlx] stream-active tokens=${completionTokens ?? 0}${tps}`);
                  lastStreamPulseAt = now;
                }
              }
              if (safeContent.length > 0) this.emitDelta(safeContent);
              if (!rambleAborted && ramble.observeContent(turnContent)) {
                rambleAborted = true;
                abortReason ??= 'idle';
                log.error(
                  `turn#${seq}.${turn} ABORT-FIRED reason=ramble ` +
                    `(${ramble.firedOnRepetition ? 'repetition-loop' : ramble.isInsideReasoning ? 'reasoning' : ramble.inPostActionMode ? 'post-action' : 'cold'}; ` +
                    `${ramble.proseSinceLastAction} chars since last signal, cap ${ramble.activeThreshold}) ` +
                    `afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
            }
            if (hasToolCalls) {
              // Tool-argument streaming emits no deltas — pulse so long
              // structured writes read as live activity, not a stall.
              this.emitWirePulse();
              ramble.recordStructuredAction(turnContent.length);
              for (const tc of delta!.tool_calls!) {
                toolCallAccumulator.ingest(tc);
                // Live tool-args channel — see the llama-cpp counterpart.
                if (tc.function?.name) liveToolArgsName = tc.function.name;
                const argChunk = tc.function?.arguments ?? '';
                if (tc.function?.name || argChunk.length > 0) {
                  this.emitToolArgsDelta(liveToolArgsName, argChunk);
                }
              }
            }
            if (usage && promptTokens !== undefined && completionTokens !== undefined) {
              lastUsage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                ...(promptTps !== undefined ? { prompt_tps: promptTps } : {}),
                ...(generationTps !== undefined ? { generation_tps: generationTps } : {}),
                ...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
              };
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (!hasContent && !hasToolCalls && !chunk.usage) {
              this.emitWirePulse();
            }
          }
        } catch (err) {
          sseExitReason = 'error';
          cleanupTurn();
          this.deps.markUsed();
          log.error(
            `turn#${seq}.${turn} SSE-EXIT reason=error chunks=${sseChunks} contentChars=${turnContent.length} afterMs=${Date.now() - start} ${(err as Error).name}: ${err instanceof Error ? err.message : String(err)}${abortReason ? ` (abort=${abortReason})` : ''}`,
          );
          // Recovery path: a `ramble` abort that has salvageable
          // tool-call markup falls through to the salvage block
          // below instead of throwing — keeps the model's queued
          // tools alive so the next iteration sees results. Set
          // by the ramble branch when we want the catch to NOT
          // re-throw `err` at the end.
          let recoveredFromRamble = false;
          if ((err as Error).name === 'AbortError') {
            if (externalSignal?.aborted) {
              throw new Error('[Mac AI] turn cancelled by caller');
            }
            if (rambleAborted) {
              const hasSalvageableMarkup = /<tool_call>|<function=/i.test(turnContent);
              if (hasSalvageableMarkup) {
                this.emitWarning(
                  `Stopped the planning monologue (${turnContent.length} chars without follow-through) — firing the tool calls you queued. Take a smaller next step.`,
                );
                finishReason ??= 'ramble-recovered';
                recoveredFromRamble = true;
              } else {
                // Last-ditch salvage: small models often inline code in
                // fenced blocks instead of calling the write tool.
                // Promote each fenced block to a synthesized write call.
                //
                // Prefer `write_file`: a salvaged fenced block is source
                // the user ships, which belongs in the workspace, not
                // the artifacts drawer — the abort copy itself says
                // "don't save source files with write_artifact." Fall
                // back to `write_artifact` only when the role has no
                // workspace-write surface (e.g. a research/notes role).
                // Either way, gate on the chosen tool being wired —
                // fabricating a call to a tool that doesn't exist would
                // just trip the validate-ids wrapper. Wild-caught
                // (qwen3.6 consultation): a write_file-only
                // Builder role rambled the HTML in chat, but this gate
                // checked ONLY `write_artifact` and skipped salvage,
                // so the whole turn (and the drafted file) was thrown
                // away. Both tools take the same `{path, content}`
                // shape, so the synthesized args are identical. Only
                // fires when there's no other salvageable signal (the
                // structured markup branch above handled the easy cases).
                const salvageToolName = knownToolNames.has('write_file')
                  ? 'write_file'
                  : knownToolNames.has('write_artifact')
                    ? 'write_artifact'
                    : null;
                if (salvageToolName) {
                  const blocks = prepareSalvagedCodeBlocks(
                    turnContent,
                    this.deps.activeCraftbookStep?.deliverableFile,
                  );
                  if (blocks.length > 0) {
                    codeBlockRepaired = blocks.map((b, i) => ({
                      id: `code-salvage-${seq}-${turn}-${i}`,
                      type: 'function' as const,
                      function: {
                        name: salvageToolName,
                        arguments: JSON.stringify({
                          path: b.filename,
                          content: b.content,
                        }),
                      },
                    }));
                    log.info(
                      `turn#${seq}.${turn} code-block-salvage: extracted ${blocks.length} ` +
                        `fenced block(s) from ${turnContent.length}-char ramble buffer ` +
                        `→ ${salvageToolName} (${blocks.map((b) => `${b.lang}:${b.filename}`).join(', ')})`,
                    );
                    this.emitWarning(
                      `The model wrote ${blocks.length === 1 ? 'a code block' : `${blocks.length} code blocks`} in chat instead of calling ${salvageToolName} — promoting them to actual file writes. Ask the model to use tools directly next time.`,
                    );
                    finishReason ??= 'ramble-recovered';
                    recoveredFromRamble = true;
                  }
                }
                if (!recoveredFromRamble) {
                  // Log a content preview so future regressions are easier
                  // to diagnose: the ramble buffer is otherwise lost when
                  // the throw fires.
                  const head = turnContent.slice(0, 400).replace(/\s+/g, ' ');
                  const tail = turnContent.slice(-200).replace(/\s+/g, ' ');
                  log.warn(
                    `turn#${seq}.${turn} ramble-no-salvage preview head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`,
                  );
                  throw new Error(
                    `[Mac AI] aborting — the gezel emitted ${turnContent.length} characters of prose this turn without calling any action tool. Stop planning. Your next message must START with a single tool call — or, if the work is genuinely finished and nothing is left to do, be ONE short sentence saying so and nothing else. If shipping source or project files and \`write_file\` is in your tool list, call it NOW with the full file contents — no preamble, no plan. If you lack workspace write access, start with a handoff tool or \`ask_user_question\` instead. Do not save source files with \`write_artifact\`; artifacts are for plans/scratch.`,
                  );
                }
              }
            } else if (abortReason === 'idle') {
              // Build a stall-aware message. Pre-first-byte vs
              // streaming idle land on different sentences so the
              // user can tell whether the model never started or
              // started then froze. The chars-received counter is
              // informative when the bubble would otherwise look
              // empty.
              if (idleAbortKind === 'pre-first-byte') {
                throw new Error(buildPreFirstByteAbortMessage(this.lastPrefillEvent));
              }
              const sinceFirst =
                firstSseEventAt !== null ? Math.round((Date.now() - firstSseEventAt) / 1000) : null;
              const sinceLast =
                lastSseEventAt !== null ? Math.round((Date.now() - lastSseEventAt) / 1000) : null;
              const stats = sinceFirst
                ? `received ${turnContent.length} chars in ${sinceFirst}s before going silent for ${sinceLast}s`
                : `received ${turnContent.length} chars before stalling`;
              throw new Error(
                `[Mac AI] no output for ${Math.round(STREAMING_IDLE_MS / 1000)}s mid-stream; aborting (${stats}). This is usually mlx_vlm.server stalling SSE — retry the turn; if it keeps happening, restart the engine in Settings → On-device.`,
              );
            } else {
              throw new Error(`[Mac AI] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
            }
          }
          // Not one of our aborts (those are AbortErrors, handled above).
          // A non-abort failure mid-body is almost always the engine
          // dropping the HTTP stream from under us — undici surfaces a
          // premature socket close as a bare `TypeError: terminated`,
          // which is what reached the user before this. Translate it into
          // something actionable instead of the cryptic one-word message;
          // the original text still rides along in the persisted warning.
          if (!recoveredFromRamble && isMidStreamConnectionDrop(err)) {
            const got =
              turnContent.length > 0 ? `after ${turnContent.length} chars` : 'before any output';
            throw new Error(
              `[Mac AI] the on-device engine dropped the connection mid-turn (${got}). This usually means the mlx server crashed, ran out of memory, or was restarted while the turn was streaming — this turn's work was lost. Retry the turn; if it keeps happening, restart the engine in Settings → On-device.`,
            );
          }
          if (!recoveredFromRamble) throw err;
        } finally {
          cleanupTurn();
          this.deps.markUsed();
          releaseEngineRequest();
        }

        // Drain any safely-buffered tail from the marker stripper. If
        // the model never closed an open marker `flush()` returns ''
        // (treats it as truncated noise) — the alternative is leaking
        // a half-marker into the saved transcript.
        const tail = stripper.flush();
        if (tail.length > 0) {
          turnContent += tail;
          this.emitDelta(tail);
        }

        // Always-on terminator log. `stream-end` here is the smoking gun
        // for "engine closed the connection without sending [DONE]" —
        // benign on a well-behaved server but worth flagging since it
        // means we'd hang on any keep-alive variant.
        log.debug(
          `turn#${seq}.${turn} SSE-EXIT reason=${sseExitReason} chunks=${sseChunks} ` +
            `contentChars=${turnContent.length} toolCalls=${toolCallAccumulator.size()} ` +
            `finish=${finishReason ?? 'null'} afterMs=${Date.now() - start}`,
        );

        const structuredCalls = toolCallAccumulator.finalize();
        // Ids of synthesized tool calls whose underlying salvage span
        // was flagged `truncated` by the lenient Hermes parser. The
        // tool-execution loop reads this to append an auto-
        // continuation hint to the corresponding tool result, so the
        // model knows the partial write_file landed and can issue a
        // follow-up with the remaining bytes.
        const truncatedCallIds = new Set<string>();

        // Try to repair any tool-call markers the stripper extracted
        // but mlx_vlm.server's parser missed. Repair only succeeds when
        // (1) the body parses cleanly and (2) the named function is in
        // the bridge's known-tools set — refusing fabricated names is
        // the safety rail. Failures land in `unrepairedBodies`, which
        // drives the warning + model self-correction below.
        const strippedBodies = stripper.getStrippedBodies();
        const eosFlushedIndices = stripper.getEosFlushedBodyIndices();
        const repairedCalls: typeof structuredCalls = [];
        const unrepairedBodies: string[] = [];
        for (let bodyIdx = 0; bodyIdx < strippedBodies.length; bodyIdx++) {
          const body = strippedBodies[bodyIdx]!;
          // Two-stage repair: try the legacy JSON-rehab path first
          // (handles Gemma's loose `{key: 'value'}` flavors), then
          // fall back to the native Gemma 4 char-by-char parser
          // (handles the chat-template's true format `{key:<|"|>val<|"|>}`
          // where string content contains unescaped newlines/quotes
          // that defeat JSON.parse). The native parser is strictly
          // additive — it only succeeds on shapes the JSON path would
          // have rejected anyway, so wiring it in can't regress
          // previously-working salvage. See
          // local-tool-call-salvage-gemma-native.test.ts.
          const parsed =
            parseGemmaToolCall(body, knownToolNames) ??
            parseGemmaNativeToolCall(body, knownToolNames);
          if (parsed) {
            const id = `repair-${seq}-${turn}-${repairedCalls.length}`;
            repairedCalls.push({
              id,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
            // Layer 3 — if this Gemma marker call came from an
            // EOS-flushed body (close marker never arrived) AND it's
            // a write-shaped call with a string `content` arg, tag
            // it as truncated. parseGemmaNativeToolCall is permissive
            // about unclosed `<|"|>` boundaries (returns the rest of
            // the buffer as the string value), so we get a "complete-
            // looking" call object whose `content` is actually the
            // bytes received before the truncation point. The
            // continuation hint tells the model to append the missing
            // tail rather than re-emit the whole file.
            if (eosFlushedIndices.has(bodyIdx)) {
              const args = parsed.arguments;
              const isWriteShaped =
                parsed.name === 'write_file' ||
                parsed.name === 'write_artifact' ||
                parsed.name === 'append_to_file';
              if (
                isWriteShaped &&
                typeof args.content === 'string' &&
                typeof args.path === 'string'
              ) {
                truncatedCallIds.add(id);
                log.info(
                  `turn#${seq}.${turn} Gemma marker call ${parsed.name} (path=${args.path}, partial=${(args.content as string).length} bytes) was EOS-flushed — continuation hint will fire on the tool result`,
                );
              }
            }
          } else {
            unrepairedBodies.push(body);
          }
        }
        // Third salvage path: small models sometimes emit
        // `name(args)` directly in their text — usually inside a
        // markdown code block — instead of issuing a real
        // function-call. The stripper misses it (no `<|tool_call|>`
        // markers) and the user sees the call rendered as decoration
        // while nothing happens. If no real or marker-repaired calls
        // fired this turn, scan the streamed text for a prose-shaped
        // call and promote it. Strict gating (known-tools set + JSON
        // parse) prevents false positives.
        const proseRepaired: typeof structuredCalls = [];
        if (structuredCalls.length === 0 && repairedCalls.length === 0 && turnContent.length > 0) {
          const parsedSpans = findProseToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of parsedSpans.entries()) {
            proseRepaired.push({
              id: `prose-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (parsedSpans.length > 0) {
            // Strip every prose body (and any wrapping ```fence```)
            // so the persisted assistant bubble doesn't show the
            // calls as decoration alongside the actual tool widgets.
            turnContent = stripProseToolCallsFromText(turnContent, parsedSpans);
          } else if (/[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(turnContent)) {
            // Diagnostic: the content has SHAPE that looks like a
            // tool call (an identifier followed by `(`) but the
            // salvage parser found nothing. Surface a debug-level
            // preview so a regression here is visible in the daemon
            // log without re-running the whole eval. The match
            // could be JS / Python / prose narration — the regex
            // alone isn't enough to promote, but it's a strong
            // signal that the parser missed something the model
            // intended as a call.
            const match = turnContent.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
            const wanted = match?.[1] ?? '?';
            const headPos = Math.max(0, (match?.index ?? 0) - 40);
            const preview = turnContent.slice(headPos, headPos + 240).replace(/\s+/g, ' ');
            log.debug(
              `turn#${seq}.${turn} prose-salvage found 0 spans despite \`${wanted}(\`-shaped text — preview: ${preview}`,
            );
          }
        }
        // Fourth salvage path: Anthropic-style XML self-closing tags
        // (`<browser_navigate url="..." />`). Wild-caught on Qwen 3.6
        // 27B at MLX after the `<|tool_call|>` channel was closed off
        // via prompt — the model picks the next-most-familiar tool-use
        // shape from training data. Run before the JSON envelope
        // salvage so a tag like `<list_projects />` isn't mis-parsed
        // by the JSON walker.
        const xmlTagRepaired: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const xmlSpans = findXmlTagToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of xmlSpans.entries()) {
            xmlTagRepaired.push({
              id: `xml-tag-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (xmlSpans.length > 0) {
            turnContent = stripXmlTagToolCallsFromText(turnContent, xmlSpans);
          }
        }
        // Anthropic-style `<function_calls><invoke name="X">...</invoke></function_calls>`
        // markup. The literal Claude tool-use XML format that Qwen
        // 3.6 reaches for after the simpler self-closing XML form is
        // closed off. Parameters arrive as nested
        // `<parameter name="K">value</parameter>` elements.
        const claudeInvokeRepaired: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const invokeSpans = findClaudeInvokeToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of invokeSpans.entries()) {
            claudeInvokeRepaired.push({
              id: `claude-invoke-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (invokeSpans.length > 0) {
            turnContent = stripClaudeInvokeToolCallsFromText(turnContent, invokeSpans);
          }
        }
        // GLM-4.5/4.6 native `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`
        // markup. GLM-family models (laguna-s-118b, a GLM-4.5-Air
        // derivative) emit this verbatim as content on the MLX textual
        // path — no `<function=`, no `="`, so none of the shapes above
        // match it and the turn stalls with zero tool calls. Run before
        // the Hermes/shell paths (both key on `<tool_call>` too, but on
        // `<function=` / `name key="value"` bodies GLM never produces).
        const glmRepaired: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const glmSpans = findGlmToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of glmSpans.entries()) {
            const id = `glm-repair-${seq}-${turn}-${idx}`;
            glmRepaired.push({
              id,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
            if (parsed.truncated) truncatedCallIds.add(id);
          }
          if (glmSpans.length > 0) {
            turnContent = stripGlmToolCallsFromText(turnContent, glmSpans);
          }
        }
        // Hermes-2-Pro / Functionary `<function=NAME><parameter=K>V</parameter></function>`
        // markup, often wrapped in Qwen's canonical `<tool_call>`
        // envelope (Qwen 3.6 has been trained on both corpora and at
        // heavy quant mixes them).
        const hermesRepaired: typeof structuredCalls = [];
        // Ids of synthesized tool calls whose underlying salvage span
        // was marked `truncated` — the bridge will execute them with
        // whatever content arrived, then we'll append an
        // auto-continuation hint to the tool's result so the model
        // knows to call the tool again with the remaining bytes.
        // Cleared and rebuilt every iteration; consumed in the
        // tool-execution loop further down.
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          let hermesSpans = findHermesFunctionToolCallSpans(turnContent, knownToolNames);
          if (hermesSpans.length === 0 && /<function=/i.test(turnContent)) {
            // Streaming-truncated case (Qwen 3.6 27B write_file bodies
            // that exceed max_tokens): the strict regex needs
            // `</parameter>` + `</function>` closers, the lenient
            // parser accepts the open-only shape and extends the last
            // parameter value to EOF. Gated on the cheap text-contains
            // check so prose unrelated to tool calls isn't re-scanned.
            const lenient = findHermesFunctionToolCallSpansLenient(turnContent, knownToolNames);
            if (lenient.length > 0) {
              log.info(
                `turn#${seq}.${turn} salvaged ${lenient.length} Hermes-style tool call(s) via lenient parser (truncated stream): ${lenient.map((s) => s.name).join(', ')}`,
              );
              hermesSpans = lenient;
            }
          }
          for (const [idx, parsed] of hermesSpans.entries()) {
            const id = `hermes-repair-${seq}-${turn}-${idx}`;
            hermesRepaired.push({
              id,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
            if (parsed.truncated) truncatedCallIds.add(id);
          }
          if (hermesSpans.length > 0) {
            turnContent = stripHermesFunctionToolCallsFromText(turnContent, hermesSpans);
          }
        }
        // Shell-style `<tool_call>name key="value"` per line, no
        // close tag, no JSON envelope. The most degraded form of
        // Qwen's canonical `<tool_call>` template — wild-caught on
        // Qwen 3.6 27B at heavy quant after the canonical, XML, and
        // Claude-invoke shapes were all closed off via prompt.
        const shellRepaired: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          hermesRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const shellSpans = findShellToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of shellSpans.entries()) {
            shellRepaired.push({
              id: `shell-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (shellSpans.length > 0) {
            turnContent = stripShellToolCallsFromText(turnContent, shellSpans);
          }
        }
        // Fifth salvage path: JSON-envelope shape some small models
        // (Qwen 3.5/3.6) emit verbatim — `{"tool": "X", "args": {}}`
        // typically inside a markdown json fence — instead of a real
        // `tool_calls` event. Promote it the same way as the prose
        // salvage. Gated on no other salvage having fired so we don't
        // double-issue when the model coincidentally emitted both.
        //
        // We extract *every* envelope in the streamed content (Qwen
        // sometimes chains multiple back-to-back) and surface a
        // truncation warning when the model stopped mid-envelope —
        // both fixes for the user-visible "only the first call fires
        // and then it stops" symptom.
        const envelopeRepaired: typeof structuredCalls = [];
        let envelopeTruncated: ReturnType<typeof findTruncatedJsonEnvelope> = null;
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          hermesRepaired.length === 0 &&
          shellRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const parsedCalls = parseJsonEnvelopeToolCalls(turnContent, knownToolNames);
          envelopeTruncated = findTruncatedJsonEnvelope(turnContent);
          for (const [idx, parsed] of parsedCalls.entries()) {
            envelopeRepaired.push({
              id: `json-envelope-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (envelopeRepaired.length > 0 || envelopeTruncated) {
            // Strip every salvaged envelope (and any truncated tail)
            // from visible content so the user doesn't see the call
            // body rendered alongside the actual tool bubbles.
            turnContent = stripJsonEnvelopesFromText(
              turnContent,
              parsedCalls,
              envelopeTruncated?.matchStart,
            );
          }
        }
        // Hide unrecognized-name JSON envelopes from the bubble even
        // though we can't promote them. The downstream "Did you mean…?"
        // branch will retry on the model's behalf; surfacing the failed
        // first attempt as raw JSON in the user's view is just noise.
        // Detection is done here (vs. inside the retry branch below)
        // so the strip runs before `fullText += turnContent`.
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          hermesRepaired.length === 0 &&
          shellRepaired.length === 0 &&
          envelopeRepaired.length === 0 &&
          !envelopeTruncated &&
          turnContent.length > 0
        ) {
          const miss = findUnrecognizedToolEnvelope(turnContent, knownToolNames);
          if (miss) {
            turnContent = stripJsonEnvelopesFromText(turnContent, [
              { matchStart: miss.matchStart, matchEnd: miss.matchEnd },
            ]);
          }
        }
        // Truncation-with-partial-args salvage. When the model started
        // a write-shaped call (`write_file`, `write_artifact`,
        // `append_to_file`) but the stream ended mid-content, promote
        // the partial body to a synthesized tool_call so the bytes
        // we DID receive land on disk — and tag the call id as
        // truncated so the tool-result auto-continuation hint below
        // tells the model to issue `append_to_file` for the missing
        // tail. Shared logic with Ollama + llama-cpp providers via
        // {@link salvageWriteShapedTruncation}.
        //
        // Gating: only fires when NO other salvage produced a call
        // for this iteration (otherwise we'd double-fire the same
        // intent).
        const truncatedSalvage: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          hermesRepaired.length === 0 &&
          shellRepaired.length === 0 &&
          envelopeRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const salvage = salvageWriteShapedTruncation(
            turnContent,
            knownToolNames,
            `truncated-salvage-mlx-${seq}-${turn}`,
          );
          if (salvage.synthesizedCall) {
            const s = salvage.synthesizedCall;
            truncatedSalvage.push({
              id: s.id,
              type: 'function' as const,
              function: {
                name: s.name,
                arguments: JSON.stringify(s.argsObject),
              },
            });
            truncatedCallIds.add(s.id);
            log.info(
              `turn#${seq}.${turn} salvaged truncated ${s.name} call (path=${s.argsObject.path}, partial=${s.argsObject.content.length} bytes) — continuation hint will fire on the tool result`,
            );
            turnContent = salvage.strippedContent;
            // Clear envelopeTruncated so the post-loop warning path
            // doesn't ALSO fire — we've handled this truncation as a
            // real salvage now.
            envelopeTruncated = null;
          }
        }
        // Bare `invoke NAME {json}` — a weak-model prose shape (wild-caught
        // on gemma4-e2b-q4/MLX) that no earlier layer recognizes: the model
        // never emits Gemma's `<|tool_call>` trigger so the grammar can't
        // engage, and it narrates the call as `invoke write_file {…}` instead.
        // Last-resort salvage, gated on nothing else having fired.
        const bareInvokeRepaired: typeof structuredCalls = [];
        if (
          structuredCalls.length === 0 &&
          repairedCalls.length === 0 &&
          proseRepaired.length === 0 &&
          xmlTagRepaired.length === 0 &&
          claudeInvokeRepaired.length === 0 &&
          glmRepaired.length === 0 &&
          hermesRepaired.length === 0 &&
          shellRepaired.length === 0 &&
          envelopeRepaired.length === 0 &&
          truncatedSalvage.length === 0 &&
          codeBlockRepaired.length === 0 &&
          turnContent.length > 0
        ) {
          const bareSpans = findBareInvokeToolCallSpans(turnContent, knownToolNames);
          for (const [idx, parsed] of bareSpans.entries()) {
            bareInvokeRepaired.push({
              id: `bare-invoke-repair-${seq}-${turn}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            });
          }
          if (bareSpans.length > 0) {
            turnContent = stripBareInvokeToolCallsFromText(turnContent, bareSpans);
          }
        }
        const rawTurnContentBeforeReasoning = turnContent;

        // Reasoning-tag extraction applies regardless of which (if any)
        // salvage path fired. Qwen 3.5/3.6 leak `<think>…</think>`
        // chain-of-thought blocks that read as the assistant's actual
        // message; smaller DeepSeek-R1 distillates and Gemma 3/4 with
        // the verbose-family hint do the same. The captured text gets
        // accumulated into `lastTurnReasoning` so the chat bubble can
        // render it behind a collapsed expander.
        {
          const split = extractReasoningWithProfile(turnContent, this.deps.profile);
          turnContent = split.visible;
          if (split.reasoning) {
            this.lastTurnReasoning =
              this.lastTurnReasoning.length > 0
                ? `${this.lastTurnReasoning}\n\n${split.reasoning}`
                : split.reasoning;
          }
        }
        const toolCalls = [
          ...structuredCalls,
          ...repairedCalls,
          ...proseRepaired,
          ...xmlTagRepaired,
          ...claudeInvokeRepaired,
          ...glmRepaired,
          ...hermesRepaired,
          ...shellRepaired,
          ...envelopeRepaired,
          ...truncatedSalvage,
          ...bareInvokeRepaired,
          ...codeBlockRepaired,
        ];
        if (rambleAborted && toolCalls.length === 0) {
          // If ctrl.abort() races with mlx-vlm closing the SSE stream,
          // the for-await loop can exit cleanly instead of throwing an
          // AbortError. Without this guard the no-tool ramble falls
          // through as an empty assistant message after reasoning
          // extraction, so the gezel never receives the corrective.
          // Wild-caught (qwen3.6 35B MLX tankcombat):
          // Meester generated 3.5K tokens, the Python server logged
          // "client disconnected mid-generation", and the session
          // persisted a blank assistant turn with no project handoff.
          const head = rawTurnContentBeforeReasoning.slice(0, 400).replace(/\s+/g, ' ');
          const tail = rawTurnContentBeforeReasoning.slice(-200).replace(/\s+/g, ' ');
          log.warn(
            `turn#${seq}.${turn} ramble-clean-exit-no-salvage preview head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`,
          );
          throw new Error(
            `[Mac AI] aborting — the gezel emitted ${rawTurnContentBeforeReasoning.length} characters of prose this turn without calling any action tool. Stop planning. Your next message must START with a single tool call — or, if the work is genuinely finished and nothing is left to do, be ONE short sentence saying so and nothing else. If shipping source or project files and \`write_file\` is in your tool list, call it NOW with the full file contents — no preamble, no plan. If you lack workspace write access, start with a handoff tool or \`ask_user_question\` instead. Do not save source files with \`write_artifact\`; artifacts are for plans/scratch.`,
          );
        }
        // Auto-fold pre-tool preamble for verbose-family models. When
        // a tool call fired this turn, untagged visible text is
        // almost always reasoning the model leaked instead of
        // wrapping in `<think>` ("The user wants…", "Let me…").
        // Substantive answer comes after the tool runs in the next
        // tool-loop iteration. See {@link foldPreToolPreamble}.
        turnContent = foldPreToolPreamble({
          text: turnContent,
          toolCallsFired: toolCalls.length > 0,
          modelLeaksReasoning: profileHasBehavior(this.deps.profile, 'turn.preamble-folding'),
          askedQuestionThisTurn,
        });
        // Post-action continuation iterations (tool already ran, this
        // is the wrap-up) get the rumination fold: a verbose model that
        // re-runs its analysis in the visible reply keeps only a
        // conclusive final line; the wall moves to the collapsed
        // reasoning expander. See {@link foldPostActionRumination}.
        if (toolCalls.length === 0 && actionFiredEarlierThisTurn) {
          const folded = foldPostActionRumination({
            text: turnContent,
            actionFiredEarlierThisTurn: true,
            modelLeaksReasoning: profileHasBehavior(this.deps.profile, 'turn.preamble-folding'),
          });
          if (folded.reasoning) {
            log.info(
              `turn#${seq}.${turn} folded ${folded.reasoning.length} chars of post-action rumination into reasoning (visible=${folded.visible.length} chars)`,
            );
            turnContent = folded.visible;
            this.lastTurnReasoning =
              this.lastTurnReasoning.length > 0
                ? `${this.lastTurnReasoning}\n\n${folded.reasoning}`
                : folded.reasoning;
          }
        }
        if (toolCalls.length > 0) actionFiredEarlierThisTurn = true;
        // Append to fullText AFTER every salvage path has had its turn
        // at stripping — earlier ordering meant the un-stripped prose /
        // envelope / reasoning text still landed in the persisted
        // assistant message even though the salvage worked.
        fullText += turnContent;

        // External tool capture: when the model invoked any caller-
        // supplied external tool, halt the loop and surface ALL
        // pending calls (external + bridge) to the caller. Bridge
        // calls in the same turn go unexecuted — the `/v1/chat/completions`
        // route owns the next turn.
        if (
          toolCalls.length > 0 &&
          toolCalls.some((tc) => this.externalToolNames.has(tc.function.name))
        ) {
          this.capturedCalls = toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
          this.messages.push({
            role: 'assistant',
            content: turnContent || null,
            tool_calls: toolCalls,
          });
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage({
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs: Date.now() - start,
              at: new Date().toISOString(),
            });
          }
          return fullText;
        }

        // Successful salvage paths (`repairedCalls`, `proseRepaired`,
        // `envelopeRepaired`) used to surface a yellow user-facing
        // warning — but salvage IS the success case, the tool fires
        // correctly and the call appears as a normal tool widget.
        // Annotating every Qwen/etc. turn with a warning trained users
        // to ignore them. Keep the console log for ops; drop the toast.
        if (repairedCalls.length > 0) {
          log.info(
            `turn#${seq}.${turn} repaired ${repairedCalls.length} ` +
              `malformed tool call(s): ${repairedCalls.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (proseRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${proseRepaired.length} prose-shaped tool call(s): ${proseRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (xmlTagRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${xmlTagRepaired.length} XML-tag tool call(s): ${xmlTagRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (claudeInvokeRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${claudeInvokeRepaired.length} Claude-invoke tool call(s): ${claudeInvokeRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (glmRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${glmRepaired.length} GLM-style tool call(s): ${glmRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (hermesRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${hermesRepaired.length} Hermes-style tool call(s): ${hermesRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (shellRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${shellRepaired.length} shell-style tool call(s): ${shellRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (envelopeRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${envelopeRepaired.length} JSON-envelope tool call(s): ${envelopeRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (bareInvokeRepaired.length > 0) {
          log.info(
            `turn#${seq}.${turn} salvaged ${bareInvokeRepaired.length} bare-invoke tool call(s): ${bareInvokeRepaired.map((c) => c.function.name).join(', ')}`,
          );
        }
        if (envelopeTruncated) {
          log.info(
            `turn#${seq}.${turn} truncated JSON-envelope tool call: ` +
              `${envelopeTruncated.wanted ?? '<unknown>'}`,
          );
          this.emitWarning(
            `The model's last tool call (\`${envelopeTruncated.wanted ?? 'unknown'}\`) was cut off mid-stream and was skipped. Try again — or raise the output token cap if this happens often.`,
          );
        } else if (toolCalls.length === 0 && turnContent.length > 0) {
          // Prose-shaped truncation — `name(args` with no closing paren.
          // Only check when no other salvage fired and no envelope-truncation
          // has already been flagged for the same tail.
          const proseTruncated = findTruncatedProseToolCall(turnContent, knownToolNames);
          if (proseTruncated) {
            log.info(`turn#${seq}.${turn} truncated prose tool call: ${proseTruncated.wanted}`);
            this.emitWarning(
              `The model started calling \`${proseTruncated.wanted}\` but was cut off mid-args. It likely spent its output budget on reasoning before reaching the tool call. Try again — or raise the output token cap.`,
            );
          }
        }

        // "Did you mean…?" nudge: model emitted a `{tool, args}`
        // envelope with a tool name we don't recognize (e.g.
        // `listtasks` instead of `list_tasks`). The salvage above
        // bailed because the name failed the known-set check; we
        // can't safely fabricate a call against the wrong name, but
        // we CAN tell the model what they mistyped and keep the
        // turn going. Shares the malformedRetries budget so a model
        // that keeps emitting bad names doesn't loop forever.
        if (toolCalls.length === 0) {
          // Cover BOTH unknown-tool shapes: the JSON `{tool,args}`
          // envelope AND the `<function=NAME>` / `<invoke name=…>`
          // markup. The latter is how a delegator role (no `write_file`)
          // "calls" write_file — before this it got no feedback and
          // believed the write succeeded. `buildUnknownToolNudge` routes
          // a no-write-access role to delegation instead of "did you
          // mean…?". Wild-caught (Space Shooter Arcade).
          const miss =
            findUnrecognizedToolEnvelope(turnContent, knownToolNames) ??
            findUnrecognizedFunctionMarkup(turnContent, knownToolNames);
          if (miss) {
            const missSig = `u:${miss.wanted.toLowerCase()}`;
            if (malformedRetries < MAX_MALFORMED_RETRIES && missSig !== lastBadCallSig) {
              malformedRetries++;
              lastBadCallSig = missSig;
              log.info(
                `turn#${seq}.${turn} model called unknown tool "${miss.wanted}"${miss.suggestion ? ` — suggesting "${miss.suggestion}"` : ''} (retry ${malformedRetries}/${MAX_MALFORMED_RETRIES})`,
              );
              // No user-facing warning here — the unknown-name retry is
              // an internal recovery, the next loop iteration produces
              // the real tool call, the user sees a clean tool widget. The
              // nudge now names valid tools + flags param-as-function slips.
              this.messages.push({ role: 'assistant', content: turnContent });
              this.messages.push({
                role: 'user',
                content: buildUnknownToolNudge(
                  miss.wanted,
                  miss.suggestion,
                  knownToolNames,
                  toolParamIndex,
                ),
              });
              continue;
            }
            // Repeat of the same unknown tool after a nudge (or budget spent):
            // the nudge isn't landing, so stop retrying and let the turn end
            // rather than apology-loop. The actionable nudge already fired.
            if (missSig === lastBadCallSig) {
              log.info(
                `turn#${seq}.${turn} model repeated unknown tool "${miss.wanted}" after a nudge — stopping retries`,
              );
            }
          }
        }

        // Self-correction nudge: model emitted tool-call markers but
        // none parsed AND no structured calls came through. Push the
        // partial assistant text + a corrective user message describing
        // what was wrong, then continue the loop so the model gets a
        // chance to retry with proper structure. Capped via
        // `malformedRetries` so we don't loop forever on a model that
        // just can't form structured calls.
        if (toolCalls.length === 0 && unrepairedBodies.length > 0) {
          const malSig = `m:${unrepairedBodies[0]!.replace(/\s+/g, '').toLowerCase().slice(0, 200)}`;
          if (malformedRetries < MAX_MALFORMED_RETRIES && malSig !== lastBadCallSig) {
            malformedRetries++;
            lastBadCallSig = malSig;
            const detail = describeMalformation(unrepairedBodies[0]!);
            log.info(
              `turn#${seq}.${turn} nudging model after malformed tool call ` +
                `(retry ${malformedRetries}/${MAX_MALFORMED_RETRIES})`,
            );
            // Suppress the per-retry user-visible warning when the
            // model's profile knows the family's tool-call quirks
            // (`parse.gemma-special-token` etc.). For those models a
            // malformed marker is a recoverable family tic rather than
            // a user-actionable problem; the internal retry-nudge
            // still fires on the next loop iteration so behavior
            // doesn't change, just the noise floor in the chat. Only
            // the final budget-exhausted warning below stays universal
            // — that's load-bearing because the turn ends without a
            // real tool call landing.
            const suppressPerRetryWarning = profileHasBehavior(
              this.deps.profile,
              'parse.gemma-special-token',
            );
            if (!suppressPerRetryWarning) {
              this.emitWarning(
                `Model attempted a tool call with malformed syntax — asking it to retry (${malformedRetries}/${MAX_MALFORMED_RETRIES}).`,
              );
            }
            this.messages.push({ role: 'assistant', content: turnContent });
            this.messages.push({
              role: 'user',
              content: `[system] Your previous response contained a malformed tool-call marker — the syntax didn't match the structured tool-call format the runtime can parse. ${detail} Please retry the tool invocation using the standard structured tool-call format (do not write the literal <|tool_call|> tokens as text — emit a real function call via the tools mechanism). Your available tools are: ${formatToolMenu(knownToolNames)}.`,
            });
            continue;
          }
          // Either the retry budget is spent OR the model just re-emitted the
          // identical malformed call — in both cases keep nudging is futile;
          // fall through to the terminal correction below instead of looping.
          if (malSig === lastBadCallSig) {
            log.info(
              `turn#${seq}.${turn} model repeated the same malformed tool call after a nudge — stopping retries`,
            );
          }
          // Retry budget exhausted — fall through to the normal end-of-
          // turn block but emit a final user-visible warning so the user
          // knows the chat ended without a real tool call firing.
          this.emitWarning(
            `Model attempted ${unrepairedBodies.length} tool call${unrepairedBodies.length === 1 ? '' : 's'} but couldn't form ${unrepairedBodies.length === 1 ? 'it' : 'them'} correctly after ${MAX_MALFORMED_RETRIES} retries. Try rephrasing or use a cloud model for tool-heavy work in this thread.`,
          );
          // Capture the failed bodies so ChatManager can stash them on
          // the persisted message for the debug bundle. Truncated per-
          // body so a runaway fabrication doesn't blow up the session
          // file. Without this, the bodies live only in provider logs
          // and the bundle reader sees "tool call attempted but couldn't
          // form" with no record of what shape was actually emitted.
          this.lastTurnAttemptedToolCalls = unrepairedBodies.map((body) => ({
            body: body.length > 600 ? `${body.slice(0, 600)}…` : body,
            reason: describeMalformation(body),
          }));
          // Inject a corrective system note into history so the NEXT
          // turn doesn't carry forward the model's "I just created the
          // project" assumption. Without this, the model's own prose
          // sits in history with no contradicting signal — turn N+1
          // tries to read the kickoff task of a project that doesn't
          // exist, hits the strict-IDs guard, and the cascade is on.
          // Using `role: 'user'` with a `[system]` prefix matches the
          // pattern the within-turn retries already use; the model
          // treats it as authoritative correction.
          const wantedNames = uniqueWantedToolNames(unrepairedBodies, knownToolNames);
          const wantedSummary =
            wantedNames.length > 0 ? `\`${wantedNames.join('`, `')}\`` : 'a tool';
          this.messages.push({
            role: 'user',
            content: `[system] Your previous turn attempted to call ${wantedSummary} but the tool-call syntax was malformed; the runtime could not parse it after ${MAX_MALFORMED_RETRIES} retries. NO TOOL RAN this turn. Any state your reasoning described (projects created, gezels recruited, files written, tasks assigned) does NOT exist on disk. Before referring to that state in subsequent turns, call \`list_projects\` / \`list_gezels\` to verify the actual state, OR retry the tool call using the structured function-calling mechanism with valid JSON arguments.`,
          });
        }

        if (toolCalls.length === 0) {
          this.messages.push({ role: 'assistant', content: turnContent });
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            const usage: TurnUsage = {
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs,
              at: new Date().toISOString(),
            };
            this.emitUsage(usage);
            // Prefer the engine's own `generation_tps` over a wall-
            // clock estimate when it's available — it's measured
            // inside the generate loop and excludes Node-side SSE
            // overhead, queue dispatch, and tool-call back-and-forth.
            // Fall back to wall-clock for older engines or any chunk
            // shape that didn't carry the field.
            const generationMs =
              firstTokenAt !== null ? Math.max(1, Date.now() - firstTokenAt) : durationMs;
            const wallTps =
              lastUsage.completion_tokens > 0 && generationMs > 0
                ? lastUsage.completion_tokens / (generationMs / 1000)
                : undefined;
            const tokensPerSec =
              lastUsage.generation_tps && lastUsage.generation_tps > 0
                ? lastUsage.generation_tps
                : wallTps;
            this.emitTurnStats({
              provider: 'mlx',
              promptTokens: lastUsage.prompt_tokens,
              completionTokens: lastUsage.completion_tokens,
              durationMs,
              ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
            });
          }
          if (finishReason === 'length') {
            this.emitWarning(
              'Model output was cut off at the length limit. The last turn may be incomplete.',
            );
          }
          log.info(
            `turn#${seq} END ok afterMs=${Date.now() - start} ` +
              `replyChars=${fullText.length} loopTurns=${turn + 1}`,
          );
          return fullText;
        }

        // Mixed-success path: at least one tool call ran (structured or
        // repaired) but some marker bodies still couldn't be parsed.
        // Mention the skipped attempts so the user understands why a
        // tool they expected to fire didn't, without blocking the work
        // that did succeed.
        //
        // Suppressed for profiles that opt into `parse.gemma-special-token` —
        // for those families a malformed marker alongside successful
        // calls is a known family tic, not a user-actionable problem.
        // The successful call is what the user sees in the UI; the
        // skipped one would just confuse them ("did the tool fire or
        // not?"). Logged as `info` instead so the diagnostic trail
        // remains.
        if (unrepairedBodies.length > 0) {
          if (profileHasBehavior(this.deps.profile, 'parse.gemma-special-token')) {
            log.info(
              `turn#${seq}.${turn} ${unrepairedBodies.length} unrepaired marker body${unrepairedBodies.length === 1 ? '' : 's'} alongside ${toolCalls.length} successful call${toolCalls.length === 1 ? '' : 's'} (suppressed user warning — known family tic)`,
            );
          } else {
            this.emitWarning(
              `${unrepairedBodies.length} additional tool-call attempt` +
                `${unrepairedBodies.length === 1 ? ' was' : 's were'} malformed and skipped.`,
            );
          }
        }

        this.messages.push({
          role: 'assistant',
          content: turnContent || null,
          tool_calls: toolCalls,
        });
        let abortDueToFailureLoop: {
          tool: string;
          count: number;
          sourceFailureKind?: 'truncated' | 'not-persisted';
          transportFailure?: boolean;
        } | null = null;
        let asyncFileHandoffCount = 0;
        let terminalActionClosing: string | null = null;
        const immediateFileWritePaths: string[] = [];
        // Set when an immediate-write / continuation write this turn was
        // EOS-flushed (truncated mid-content) — drives the bail-vs-loop
        // decision below.
        let immediateWriteTruncated = false;
        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments.length > 0 ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* bad JSON — let the tool see empty args */
          }
          let output: string;
          // Intercept duplicate ask_user_question calls within the
          // same turn — synthesize a response that tells the model
          // its first question is already pending and to end the
          // turn. The second card is suppressed entirely (no API
          // call, no UI clutter).
          if (call.function.name === 'ask_user_question' && askedQuestionThisTurn) {
            output =
              "You already posted a question card to the user earlier in this turn. The second `ask_user_question` call was suppressed so the user only sees one card. END YOUR TURN NOW — the user's answer to the first question will arrive as the next user message; this turn produces no further visible content.";
          } else if (
            (call.function.name === 'start_project' || call.function.name === 'start_job') &&
            startedProjectOrJobThisTurn
          ) {
            // Success-led phrasing — wild-caught on gemma4-26b/MLX,
            // the previous "DO NOT call..." wording got misread by
            // the model as "your call was malformed, retry it" and
            // looped for 10+ iterations before MAX_TOOL_LOOP_TURNS
            // bailed. Leading with "✓ created" + the original
            // tool result makes the success unambiguous; the STOP
            // instruction is the closing emphasis, not the framing.
            projectMacroInterceptCount++;
            output = `✓ The project was successfully created on your earlier \`${startedProjectOrJobThisTurn.tool}\` call this turn — kickoff is complete and the lead is on it.\n\nOriginal result:\n${startedProjectOrJobThisTurn.firstResult}\n\nSTOP — do NOT emit any more tool calls this turn. Each \`start_project\` / \`start_job\` call creates a real project, lead, and kickoff task; repeating the macro would create duplicates. END YOUR TURN NOW with a one-sentence summary to the user (e.g. "Project is on it — the voorman is leading"). The lead handles the work from here.`;
            if (projectMacroInterceptCount >= PROJECT_MACRO_INTERCEPT_CAP) {
              forceProjectMacroBail = {
                closingText: deriveProjectMacroClosing(startedProjectOrJobThisTurn.firstResult),
              };
            }
          } else if (
            advertisedBridgeToolNames.has(call.function.name) &&
            this.deps.bridges.hasTool(call.function.name)
          ) {
            try {
              const budgetChars = computeToolBudgetChars(
                this.deps.numCtx,
                this.estimatePromptChars(),
              );
              output = await this.deps.bridges.callTool(call.function.name, args, {
                budgetChars,
                numCtxTokens: this.deps.numCtx,
              });
            } catch (err) {
              output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            }
            // Successful ask_user_question (output not an ERROR
            // and not the suppression sentinel above) → arm the
            // dedup guard and the post-ask fold for the rest of
            // this turn.
            if (call.function.name === 'ask_user_question' && !output.startsWith('ERROR:')) {
              askedQuestionThisTurn = true;
            }
            if (
              call.function.name === 'message_gezel' &&
              !output.startsWith('ERROR:') &&
              expectedDeliverableIsFile(args.expectedDeliverable)
            ) {
              asyncFileHandoffCount++;
            }
            if (
              (immediateFileWriteTurn || writeContinuationActive) &&
              (call.function.name === 'write_file' || call.function.name === 'append_to_file') &&
              !output.startsWith('ERROR:')
            ) {
              if (typeof args.path === 'string') immediateFileWritePaths.push(args.path);
              // If this write was itself truncated, the file still isn't
              // complete — flag it so the bail block loops a continuation
              // instead of declaring the file done.
              if (truncatedCallIds.has(call.id)) immediateWriteTruncated = true;
            }
            // Successful start_project / start_job → arm the
            // per-turn macro guard so subsequent variants get
            // intercepted above before reaching the bridge.
            if (
              (call.function.name === 'start_project' || call.function.name === 'start_job') &&
              !output.startsWith('ERROR:')
            ) {
              startedProjectOrJobThisTurn = { tool: call.function.name, firstResult: output };
            }
          } else {
            output = `ERROR: tool ${call.function.name} is not available`;
          }
          // Auto-continuation hint for truncated write-shaped tool
          // calls. Wild-caught on Qwen 3.6 27B write_file calls whose
          // `<parameter=content>…` stream-truncated before the closer
          // arrived (Hermes shape), and on Gemma 4 26B prose-shape /
          // JSON-envelope `write_file({...})` calls cut mid-content.
          // The bridge executed the call with the partial body (an
          // incomplete file on disk); without this hint the model
          // just narrates "I wrote the file" on the next turn and
          // the trial times out. Shared with Ollama + llama-cpp
          // providers via {@link appendTruncationHintToToolResult}.
          if (truncatedCallIds.has(call.id)) {
            const before = output.length;
            output = appendTruncationHintToToolResult(output, call.function.name, args);
            if (output.length !== before) {
              const path = typeof args.path === 'string' ? args.path : '(unknown)';
              const bytes = typeof args.content === 'string' ? args.content.length : 0;
              log.info(
                `turn#${seq} auto-continuation hint appended to tool=${call.function.name} id=${call.id} path=${path} bytes=${bytes}`,
              );
            }
          }
          const tracked = failureTracker.recordResult(call.function.name, output);
          terminalActionClosing ??= terminalToolClosingText(
            this.deps.terminalToolPolicy,
            call.function.name,
            args,
            output,
          );
          // Layer the same-args repeat tracker on top of the failure
          // tracker. The failure tracker catches "tool keeps erroring";
          // the repeat tracker catches "tool keeps succeeding with the
          // same args while the model spins on planning prose" — the
          // narrative-spinning loop the user reported on Ada.
          const repeated = repeatTracker.recordCall(call.function.name, args, tracked.output);
          const paced = deliverableReadPaceTracker?.recordCall(call.function.name, repeated.output);
          // Always push the (possibly-augmented) tool message so the
          // transcript reflects what the model would see — even on
          // hard abort, debugging the runaway is easier with the
          // last context preserved.
          this.messages.push({
            role: 'tool',
            content: paced?.output ?? repeated.output,
            tool_call_id: call.id,
          });
          if (tracked.shouldAbort) {
            abortDueToFailureLoop = {
              tool: call.function.name,
              count: tracked.count,
              ...(tracked.sourceFailureKind
                ? { sourceFailureKind: tracked.sourceFailureKind }
                : {}),
              ...(tracked.transportFailure ? { transportFailure: true } : {}),
            };
            break;
          }
          if (paced?.shouldAbort && deliverableReadPaceTracker) {
            throw deliverableReadPaceTracker.buildAbort('Mac AI');
          }
          if (repeated.shouldAbort) {
            log.error(
              `turn#${seq} END abort-repeat-loop afterMs=${Date.now() - start} ` +
                `tool=${call.function.name} sameArgsCalls=${repeated.count}`,
            );
            throw ToolRepeatTracker.buildAbort({
              providerLabel: 'Mac AI',
              toolName: call.function.name,
              args,
              count: repeated.count,
              registeredTools: knownToolNames,
              ...(this.deps.activeCraftbookStep
                ? { activeStep: this.deps.activeCraftbookStep }
                : {}),
            });
          }
        }
        if (abortDueToFailureLoop) {
          const { tool: failedTool, count: failCount } = abortDueToFailureLoop;
          log.error(
            `turn#${seq} END abort-failure-loop afterMs=${Date.now() - start} ` +
              `tool=${failedTool} consecutiveFails=${failCount}`,
          );
          throw ToolFailureTracker.buildAbort({
            providerLabel: 'Mac AI',
            toolName: failedTool,
            count: failCount,
            surgicalEditsAvailable,
            delegationAvailable,
            ...(abortDueToFailureLoop.sourceFailureKind
              ? { sourceFailureKind: abortDueToFailureLoop.sourceFailureKind }
              : {}),
            ...(abortDueToFailureLoop.transportFailure ? { transportFailure: true } : {}),
          });
        }
        if (terminalActionClosing) {
          // The action itself is the terminal outcome. Do not spend another
          // generation asking the model to re-analyze a board that changed
          // under it; persist one short line and release the turn.
          this.messages.push({ role: 'assistant', content: terminalActionClosing });
          fullText = terminalActionClosing;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage({
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs: Date.now() - start,
              at: new Date().toISOString(),
            });
          }
          log.info(
            `turn#${seq} END terminal-tool-bail afterMs=${Date.now() - start} loopTurns=${turn + 1}`,
          );
          return fullText;
        }
        if (immediateFileWritePaths.length > 0) {
          // File was truncated mid-content and we still have continuation
          // budget — keep the turn alive instead of bailing on a partial.
          // The tool result already carries the "append the rest" hint;
          // surfacing `append_to_file` (above) lets the model act on it.
          if (immediateWriteTruncated && writeContinuations < MAX_IMMEDIATE_WRITE_CONTINUATIONS) {
            writeContinuationActive = true;
            writeContinuations++;
            // Make append_to_file callable + salvageable for the next turn.
            advertisedBridgeToolNames.add('append_to_file');
            knownToolNames.add('append_to_file');
            log.info(
              `turn#${seq} immediate-write truncated — auto-continuation ${writeContinuations}/${MAX_IMMEDIATE_WRITE_CONTINUATIONS} (append_to_file surfaced) paths=${immediateFileWritePaths.join(',')}`,
            );
            continue;
          }
          const closingText = immediateFileWriteClosing(immediateFileWritePaths);
          this.messages.push({ role: 'assistant', content: closingText });
          fullText = closingText;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage({
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs: Date.now() - start,
              at: new Date().toISOString(),
            });
          }
          log.info(
            `turn#${seq} END immediate-write-bail afterMs=${Date.now() - start} ` +
              `paths=${immediateFileWritePaths.join(',') || '(unknown)'} loopTurns=${turn + 1}` +
              `${writeContinuations > 0 ? ` continuations=${writeContinuations}` : ''}`,
          );
          return fullText;
        }
        if (asyncFileHandoffCount > 0) {
          const closingText = asyncFileHandoffClosing(asyncFileHandoffCount);
          this.messages.push({ role: 'assistant', content: closingText });
          fullText = closingText;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage({
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs: Date.now() - start,
              at: new Date().toISOString(),
            });
          }
          log.info(
            `turn#${seq} END async-file-handoff-bail afterMs=${Date.now() - start} ` +
              `handoffs=${asyncFileHandoffCount} loopTurns=${turn + 1}`,
          );
          return fullText;
        }
        if (forceProjectMacroBail) {
          // Model emitted PROJECT_MACRO_INTERCEPT_CAP+ redundant
          // start_project / start_job envelopes despite the per-turn
          // guard returning a clear "STOP" message each time. The
          // project IS real — we hold onto the first call's result
          // text — but the model can't be talked into wrapping the
          // turn, so we synthesize a one-line closing and exit. The
          // user sees a clean bubble instead of minutes of malformed
          // retry prose.
          log.warn(
            `turn#${seq} END force-macro-bail afterMs=${Date.now() - start} ` +
              `intercepts=${projectMacroInterceptCount} loopTurns=${turn + 1}`,
          );
          this.messages.push({ role: 'assistant', content: forceProjectMacroBail.closingText });
          fullText = forceProjectMacroBail.closingText;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            const usage: TurnUsage = {
              model: this.deps.model,
              inputTokens: lastUsage.prompt_tokens,
              outputTokens: lastUsage.completion_tokens,
              ...(lastUsage.cached_tokens !== undefined
                ? { cachedInputTokens: lastUsage.cached_tokens }
                : {}),
              ...(lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
                ? { outputTokensPerSec: lastUsage.generation_tps }
                : {}),
              durationMs,
              at: new Date().toISOString(),
            };
            this.emitUsage(usage);
            const generationMs =
              firstTokenAt !== null ? Math.max(1, Date.now() - firstTokenAt) : durationMs;
            const wallTps =
              lastUsage.completion_tokens > 0 && generationMs > 0
                ? lastUsage.completion_tokens / (generationMs / 1000)
                : undefined;
            const tokensPerSec =
              lastUsage.generation_tps && lastUsage.generation_tps > 0
                ? lastUsage.generation_tps
                : wallTps;
            this.emitTurnStats({
              provider: 'mlx',
              promptTokens: lastUsage.prompt_tokens,
              completionTokens: lastUsage.completion_tokens,
              durationMs,
              ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
            });
          }
          this.emitWarning(
            `On-device model emitted ${projectMacroInterceptCount + 1} \`${startedProjectOrJobThisTurn?.tool ?? 'start_project'}\` attempts in one turn after the first one succeeded. The runtime ended the turn for you — the project is real and the lead is on it. Consider switching the Meester to a cloud model if this recurs.`,
          );
          return fullText;
        }

        // Terminal: the model posted a question card to the user — end the
        // turn (its answer arrives as the next user message). Without this the
        // loop issues another generation request and can wedge in-flight; see
        // the llama-cpp provider for the full "stuck session" rationale.
        if (askedQuestionThisTurn) return fullText;
      }
      throw new Error(
        `[mlx] too many tool-call loops (>${MAX_TOOL_LOOP_TURNS}); aborting to prevent runaway`,
      );
    } catch (err) {
      log.info(
        `turn#${seq} END throw afterMs=${Date.now() - start} ` +
          `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
      throw err;
    } finally {
      clearInterval(statusHeartbeat);
      this.deps.provider._deregisterActiveSession(this);
    }
  }

  providerState(): ProviderSessionState {
    return {};
  }

  getRegisteredToolNames(): string[] {
    if (this.deps.bridges.isEmpty()) return [];
    return this.deps.bridges.getOpenAITools().map((t) => t.name);
  }

  setSystemMessage(text: string): void {
    // Replace the system message in-place. The constructor always
    // installs a `{role: 'system'}` entry at index 0, so this is
    // safe even after a turn or two have appended user/assistant
    // messages — those stay where they are.
    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: text });
      this.currentTurnStartIdx += 1;
    } else {
      this.messages[0] = { role: 'system', content: text };
    }
    // Keep the prefix-cache mapping in sync with the bytes actually sent
    // (the next prepareForSend hashes deps.systemMessage / the layered
    // `project` band). Without this a mid-session refresh would key the
    // cache on the original prompt. The refresh only changes the tools
    // block (late `project` layer), so update `project`, keep `gezel`.
    this.deps.systemMessage = text;
    if (this.deps.systemPromptLayers) {
      this.deps.systemPromptLayers = {
        gezel: this.deps.systemPromptLayers.gezel,
        project: text,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    const adapter = this.deps.provider.getCacheAdapter();
    if (adapter && this.fallbackCacheUsed) {
      // Ephemeral/one-shot sessions only need their fallback cache while the
      // MlxSession is alive (especially across tool-loop iterations). Do not
      // leave one never-resumable disk entry per background completion.
      await adapter.evict([this.fallbackCacheId]).catch((err) => {
        log.warn(
          `failed to evict ephemeral cache ${this.fallbackCacheId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    try {
      await this.deps.bridges.stop();
    } catch {
      /* ignore */
    }
  }
}

/** Same contract as LlamaCppProvider's ToolCallAccumulator — OpenAI's
 *  streaming tool-call shape is identical. Kept private to this module
 *  rather than reaching into the llama-cpp file. */
class MlxToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  size(): number {
    return this.byIndex.size;
  }

  ingest(delta: ToolCallDelta): void {
    const idx = delta.index;
    let entry = this.byIndex.get(idx);
    if (!entry) {
      entry = { id: '', name: '', arguments: '' };
      this.byIndex.set(idx, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name = delta.function.name;
    if (delta.function?.arguments) entry.arguments += delta.function.arguments;
  }

  finalize(): Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> {
    return Array.from(this.byIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.arguments },
      }));
  }
}

function toChatCompletionsTools(bridges: McpBridgePool): ChatCompletionTool[] {
  return bridges.getOpenAITools().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Read a process's resident-set size (bytes) via `ps`. mlx_lm.server's
 * logs don't include a memory-footprint summary, so we sample the
 * child's RSS after it reports ready and use that as the engine
 * memory readout.
 *
 * Returns `null` on any failure (pid gone, ps missing, unparsable
 * output) — the caller treats RSS as an enrichment, not a
 * requirement, and silently skips the telemetry event when we
 * can't get a number.
 *
 * `ps -o rss= -p <pid>` works identically on macOS and Linux and
 * prints the RSS in kilobytes with no header. Windows doesn't have
 * `ps` — MLX is Mac-only today, so we don't try to support it.
 */
async function readProcessRssBytes(pid: number): Promise<number | null> {
  const { spawn } = await import('node:child_process');
  return await new Promise<number | null>((resolve) => {
    try {
      const proc = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const kb = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(kb) || kb <= 0) return resolve(null);
        resolve(kb * 1024);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Map known `mlx_vlm.server` error-response shapes to user-actionable
 * messages so the chat bubble reads like a helpful hint instead of a
 * wall of JSON + request IDs.
 *
 * The engine surfaces a lot of its internal hugging-face + transformers
 * errors verbatim in the 500 body; most of them translate to "your
 * install is stale, reinstall it" — the only bit the user can act on.
 */
function translateMlxHttpError(status: number, statusText: string, body: string): string {
  // "Repository Not Found for url: …" — the engine fell back to a
  // network fetch (it shouldn't, with HF_HUB_OFFLINE=1; if you still
  // see this the offline gate didn't take, or a different code path
  // bypassed it). Either way the actionable advice is the same:
  // confirm the install is current, then reset the venv if mlx-vlm
  // is too old for the model's architecture.
  if (/Repository Not Found for url/i.test(body) || /401 Client Error/i.test(body)) {
    return (
      "[Mac AI] The engine couldn't load this model. Try, in order:\n" +
      '  1. Settings → This Mac → Delete the local model, then download it again (in case the on-disk files are incomplete).\n' +
      '  2. Settings → This Mac → Advanced → Reset venv (in case mlx-vlm is too old for this architecture).\n' +
      '  3. Restart gezel and retry.'
    );
  }
  // Architecture / weights mismatch — mlx-vlm doesn't recognize the
  // model class this install was saved for.
  if (/Received \d+ parameters not in model/i.test(body)) {
    return (
      "[Mac AI] The on-device runtime doesn't recognize this model's architecture.\n" +
      'Settings → This Mac → Advanced → Reset venv, then retry. If it still fails, the catalog entry may need a newer mlx-vlm.'
    );
  }
  // Out of memory — mlx_vlm propagates the Metal / MPS error.
  if (/out of memory|mps backend|allocation failed/i.test(body)) {
    return (
      '[Mac AI] Not enough unified memory to load this model.\n' +
      'Try the E2B variant, close other memory-heavy apps, or restart this Mac to release cached memory.'
    );
  }
  // Local-disk file missing (now visible because of the offline gate).
  if (/FileNotFoundError|No such file or directory/i.test(body)) {
    const filename = body.match(/['"]?([^'"\s]+\.(?:json|safetensors|jinja|model))['"]?/)?.[1];
    return `[Mac AI] The local model is missing a file the engine needs${filename ? ` (\`${filename}\`)` : ''}.\nSettings → This Mac → Delete the local model, then download it again.`;
  }
  // Fallback: keep the shape but trim the noise.
  const parsed = tryParseJsonDetail(body);
  const detail = parsed ?? body.slice(0, 200);
  return `[Mac AI] engine returned ${status} ${statusText}: ${detail}`;
}

/**
 * Did this error come from the engine dropping the HTTP response stream
 * mid-flight (vs. one of our own aborts)? Node's `fetch`/undici reports
 * a premature socket close while reading a streamed body as a bare
 * `TypeError: terminated` — sometimes with a `cause` like a socket
 * error (`UND_ERR_SOCKET`) or "other side closed". We match those shapes
 * so the SSE catch can replace the cryptic one-word message with an
 * actionable one. AbortErrors are handled separately upstream and never
 * reach here.
 */
export function isMidStreamConnectionDrop(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const haystacks: string[] = [err.message];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) haystacks.push(cause.message);
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';
  if (causeCode) haystacks.push(causeCode);
  const blob = haystacks.join(' ').toLowerCase();
  return (
    /\bterminated\b/.test(blob) ||
    blob.includes('other side closed') ||
    blob.includes('premature close') ||
    blob.includes('und_err_socket') ||
    blob.includes('econnreset')
  );
}

/**
 * Format a tokens-per-second number for the in-chat status line.
 * Mirrors the UI's `formatTokensPerSec` helper (one decimal under 10
 * tok/s, integer otherwise) so the live chat detail matches what the
 * pill displays at turn end.
 */
function formatTps(rate: number): string {
  if (rate >= 10) return rate.toFixed(0);
  return rate.toFixed(1);
}

/**
 * Build the user-facing message for a pre-first-byte abort. When we
 * observed prefill progress before the abort, fold the percentage and
 * the chunk-detail into the message so the user sees "stalled at
 * prefill 75% (22,528 / 29,930 tokens)" instead of a generic "no first
 * byte" — much more diagnostic, and it tells them the model was
 * actually working, not stuck. Without prefill events, fall back to
 * the cold-load message.
 */
function buildPreFirstByteAbortMessage(
  lastPrefill: { progress: number; detail: string; at: number } | null,
): string {
  if (lastPrefill && lastPrefill.progress > 0) {
    const pct = Math.round(lastPrefill.progress * 100);
    const detail = lastPrefill.detail ? ` (${lastPrefill.detail})` : '';
    return `[Mac AI] aborting — prefill stalled at ${pct}%${detail}. The prompt may be too large for this model's effective speed. Try a shorter prompt, retry, or restart the engine in Settings → On-device.`;
  }
  // progress === 0 but a prefill marker DID arrive — the batched path
  // (BatchGenerator) prefills the whole prompt in one event-loop-blocking
  // call and emits only a "prefilling N tokens" start marker (no tqdm
  // chunks), so we never see a >0% line even when the engine is genuinely
  // grinding through a large prompt. Surface that as "stalled while
  // prefilling …" rather than the misleading "model unhealthy" message.
  if (lastPrefill?.detail) {
    return `[Mac AI] aborting — still prefilling ${lastPrefill.detail} when the budget ran out. The prompt is large for this model's prefill speed; retry (the cache is warm now) or pick a faster/smaller model.`;
  }
  return '[Mac AI] no first byte from the engine; aborting (model is loading slowly or mlx_vlm.server is unhealthy). Retry the turn; if it keeps happening, restart the engine in Settings → On-device.';
}

/**
 * Rough token estimate for the outbound request — message bodies plus the
 * serialized tool schemas. Chars/4 is the standard cheap proxy; we only
 * need order-of-magnitude to size the watchdog, not exactness. The tool
 * block dominates for coordinator roles (the qwen3.6-27b voorman repro
 * carried ~30K tokens of tool schemas alone), so it MUST be included —
 * estimating from messages-only would badly under-size the budget on the
 * exact turns that need it most.
 */
export function estimatePromptTokens(messages: unknown, tools: unknown): number {
  let chars = 0;
  try {
    chars += JSON.stringify(messages)?.length ?? 0;
  } catch {
    /* circular / unstringifiable — ignore, the tools term still sizes it */
  }
  if (tools) {
    try {
      chars += JSON.stringify(tools)?.length ?? 0;
    } catch {
      /* ignore */
    }
  }
  return Math.ceil(chars / 4);
}

// Pre-first-byte watchdog sizing. A 27B-q8 model on MLX produces its first
// token only after prefilling the WHOLE prompt; on a 37K-token turn that
// can legitimately exceed the old flat 300s budget (the qwen3.6-27b voorman
// stall — aborted at 343s with the engine still grinding). Scale the budget
// with prompt size so big-context turns get the time they actually need,
// while small turns keep a tight bound.
const PRE_FIRST_BYTE_BASE_MS = 300_000; // floor — matches the prior flat value
const PRE_FIRST_BYTE_BASELINE_TOKENS = 8_000; // budget starts growing past this
const PRE_FIRST_BYTE_MS_PER_1K_TOKENS = 12_000; // +12s of headroom per 1K tokens
const PRE_FIRST_BYTE_CAP_MS = 900_000; // 15 min ceiling (< the 30-min hard turn deadline)

/**
 * Pre-first-byte idle budget for a prompt of `approxPromptTokens`. Floors at
 * {@link PRE_FIRST_BYTE_BASE_MS}, grows linearly past
 * {@link PRE_FIRST_BYTE_BASELINE_TOKENS}, and caps at
 * {@link PRE_FIRST_BYTE_CAP_MS}. Used for BOTH the cold-start timer and the
 * post-prefill-event re-arm: pre-first-byte we only know "no token yet," so a
 * single generous size-scaled bound beats a tight per-chunk one that
 * false-aborts a slow-but-healthy batched prefill (which emits no tqdm
 * chunks to re-arm a tighter timer).
 */
export function computePreFirstByteBudgetMs(approxPromptTokens: number): number {
  const over = Math.max(0, approxPromptTokens - PRE_FIRST_BYTE_BASELINE_TOKENS);
  const scaled = PRE_FIRST_BYTE_BASE_MS + (over / 1000) * PRE_FIRST_BYTE_MS_PER_1K_TOKENS;
  return Math.min(PRE_FIRST_BYTE_CAP_MS, Math.round(scaled));
}

function tryParseJsonDetail(body: string): string | null {
  try {
    const obj = JSON.parse(body) as unknown;
    if (obj && typeof obj === 'object' && 'detail' in obj && typeof obj.detail === 'string') {
      return obj.detail.slice(0, 200);
    }
  } catch {
    /* not JSON, fall through */
  }
  return null;
}
