import { createLogger, isOllamaReasoningModel, leaksUntaggedReasoning } from '@bendyline/gezel';

/**
 * Per-turn output cap (token count) Ollama applies via
 * `options.num_predict`. Used as the floor when no profile-driven
 * `numPredict` hook fires and the user hasn't overridden via
 * settings. 16k covers normal prose + reasoning + multi-call chains
 * without giving Qwen 3.5 enough rope to loop in the pathological
 * "repeat the same paragraph for an entire budget" failure mode 32k
 * exposed in early testing.
 */
const DEFAULT_OLLAMA_NUM_PREDICT = 16384;

const log = createLogger('ollama');
import type { TurnRambleDetectionConfig } from '../model-profile/behaviors/turn-ramble-detection.js';
import {
  extractReasoningWithProfile,
  profileBehaviorConfig,
  profileHasBehavior,
  profileNumPredict,
} from '../model-profile/runtime.js';
import {
  OLLAMA_BODY_TUNING_MAP,
  OLLAMA_OPTIONS_TUNING_MAP,
  applyTuning,
} from '../model-profile/tuning.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import { salvageCodeBlocks } from './code-block-salvage.js';
import {
  appendTruncationHintToToolResult,
  findClaudeInvokeToolCallSpans,
  findHermesFunctionToolCallSpans,
  findHermesFunctionToolCallSpansLenient,
  findProseToolCallSpans,
  findShellToolCallSpans,
  findTruncatedJsonEnvelope,
  findTruncatedProseToolCall,
  findUnrecognizedToolEnvelope,
  findXmlTagToolCallSpans,
  foldPreToolPreamble,
  parseJsonEnvelopeToolCalls,
  salvageWriteShapedTruncation,
  stripClaudeInvokeToolCallsFromText,
  stripHermesFunctionToolCallsFromText,
  stripJsonEnvelopesFromText,
  stripProseToolCallsFromText,
  stripShellToolCallsFromText,
  stripXmlTagToolCallsFromText,
} from './local-tool-call-salvage.js';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { computeToolBudgetChars } from './mcp-bridge.js';
import { ProviderQueue, runInQueue } from './queue.js';
import { RambleDetector } from './ramble-detector.js';
import { StreamingSessionBase } from './streaming-session.js';
import { ToolFailureTracker } from './tool-failure-tracker.js';
import { ToolRepeatTracker } from './tool-repeat-tracker.js';
import type {
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMProvider,
  LLMSession,
  ModelInfo,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
} from './types.js';
import { buildTurnUsage } from './usage-builder.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';

/**
 * Baseline context window for a model whose `parameter_size` doesn't match
 * any of the tiered overrides below. Ollama's own per-model default is
 * usually 2048–4096 — far too small for anything but the shortest threads —
 * so gezel ships with a more generous baseline.
 */
const DEFAULT_NUM_CTX = 32768;

/**
 * Pick a `num_ctx` based on a model's parameter-size hint.
 *
 * Sizing is dominated by our system-prompt + MCP tool surface, not raw
 * chat history. A Meester-style session carries the meester about.md
 * (~500–800 tokens) plus ~37 MCP tool schemas serialized into the
 * request — each schema is 150–300 tokens, so tools alone are 5–10k.
 * When the window can't hold system + tools + recent turns, Ollama
 * silently truncates from the front, which manifests as the model
 * "forgetting" the user's question after a tool call and generating a
 * cold-start greeting instead. The floors below leave room for tools
 * with a few thousand tokens of turns on top.
 *
 * These are floors, not caps: gezels can override via
 * `ollamaNumCtx` in config, and per-session opts take precedence.
 */
export function heuristicNumCtx(parameterSize: string | undefined): number {
  if (!parameterSize) return DEFAULT_NUM_CTX;
  const match = parameterSize.match(/(\d+(?:\.\d+)?)\s*([BMK]?)/i);
  if (!match) return DEFAULT_NUM_CTX;
  const num = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  const billions = unit === 'B' ? num : unit === 'M' ? num / 1000 : num / 1_000_000;
  if (billions < 5) return 16384;
  if (billions < 20) return 32768;
  return 65536;
}

/**
 * Family prefixes we believe support Ollama's native /api/chat tool calling.
 * Ollama's API doesn't advertise this per-model, so we fall back to a
 * pragmatic allowlist. The UI surfaces a warning when a user pins a gezel
 * to a model that's NOT on this list — tool use is the difference between
 * a gezel that can act and one that can only talk.
 */
const TOOL_CAPABLE_PREFIXES = [
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'llama4',
  'qwen2.5',
  'qwen3',
  'gemma3',
  'gemma4',
  'mistral',
  'mixtral',
  'gpt-oss',
  'deepseek-r1',
  'deepseek-v3',
  'command-r',
  'firefunction',
];

function supportsToolsByFamily(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return TOOL_CAPABLE_PREFIXES.some((p) => lower.startsWith(p));
}

// Reasoning-family detection lives in core (`isOllamaReasoningModel`)
// so the UI can show the thinking toggle conditionally against the
// same list the provider uses to auto-pick `think: false`.

// Per-turn output caps live in `chat/local-model-tuning.ts` so the
// tuning knobs (default + verbose-family bump + the resolution helper)
// sit in one place alongside the tier-keyed prompt blocks. Imported
// above as `DEFAULT_OLLAMA_NUM_PREDICT` and `pickOllamaNumPredict`.

/**
 * Local-only provider that talks to an Ollama server (default:
 * http://localhost:11434). Stateless — every /api/chat request carries the
 * full conversation history, so `OllamaSession` maintains its own message
 * list seeded from `SessionOpts.priorMessages`.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  /** Mid-stream silence cap, per session. See `streamingIdleMs` in
   *  `OllamaSession.sendAndWaitInner` for full rationale. */
  private readonly streamingIdleMs: number;
  /** Pre-first-byte cap (cold start + prompt prefill). See
   *  `preFirstByteIdleMs` in `OllamaSession.sendAndWaitInner`. */
  private readonly preFirstByteIdleMs: number;
  /** User-configured per-turn output cap. `undefined` means "no
   *  explicit setting" — the per-session resolver
   *  ({@link pickOllamaNumPredict}) then picks a default that depends
   *  on the model family. */
  private readonly userNumPredict: number | undefined;
  private readonly thinkOverride: boolean | undefined;

  constructor(
    opts: {
      baseUrl?: string;
      defaultModel?: string;
      concurrency?: number;
      affinity?: boolean;
      /** Override the default mid-stream silence cap (ms). */
      streamingIdleMs?: number;
      /** Override the default pre-first-byte cap (ms). */
      preFirstByteIdleMs?: number;
      /** Cap on tokens emitted per turn. Maps to `options.num_predict`. */
      numPredict?: number;
      /** Explicit `think: true/false` override. When undefined, we
       *  auto-pick based on model family (reasoning families → false). */
      think?: boolean;
    } = {},
  ) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = opts.defaultModel || DEFAULT_MODEL;
    this.streamingIdleMs = opts.streamingIdleMs ?? 300_000;
    this.preFirstByteIdleMs = opts.preFirstByteIdleMs ?? 300_000;
    this.userNumPredict = opts.numPredict;
    this.thinkOverride = opts.think;
    this.queue = new ProviderQueue({
      concurrency: opts.concurrency ?? 1,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
  }

  async initialize(): Promise<void> {
    // Probe /api/tags so a misconfigured URL surfaces early with a usable
    // error instead of on the first chat turn.
    await this.fetchTags();
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[ollama]');
    const model = await this.resolveModel(opts.model);
    const numCtx = opts.numCtx ?? (await this.resolveNumCtx(model));
    // Resolve `think`: explicit config wins; otherwise auto-off for
    // reasoning families, unset (Ollama default) for everyone else.
    // Passing an explicit `false` on non-reasoning models would be a
    // no-op on most but could confuse future Ollama versions, so we
    // only pass the flag when we actually have an opinion.
    const think =
      this.thinkOverride !== undefined
        ? this.thinkOverride
        : isOllamaReasoningModel(model)
          ? false
          : undefined;
    // Per-turn output cap. Resolution order:
    //   1. Explicit user config (`OLLAMA_NUM_PREDICT` env / settings field) wins
    //   2. Profile's `numPredict` hook (today: `turn.ollama-num-predict-bumped`)
    //   3. The `DEFAULT_OLLAMA_NUM_PREDICT` baseline
    // The profile-driven path replaces the legacy `pickOllamaNumPredict`
    // substring matcher; verbose families opt in via the manifest's
    // `behaviors` array now, not via family-name detection.
    let numPredictForSession: number;
    if (this.userNumPredict !== undefined) {
      numPredictForSession = this.userNumPredict;
    } else {
      const fromProfile = profileNumPredict(opts.profile, {
        modelId: model,
        providerName: 'ollama',
      });
      numPredictForSession = fromProfile ?? DEFAULT_OLLAMA_NUM_PREDICT;
    }
    return new OllamaSession({
      baseUrl: this.baseUrl,
      model,
      systemMessage: opts.systemMessage,
      bridges,
      // Pass widened priorMessages through — OllamaSession translates
      // tool-role entries into Ollama's message format in its
      // constructor.
      priorMessages: opts.priorMessages ?? [],
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
      numCtx,
      numPredict: numPredictForSession,
      ...(think !== undefined ? { think } : {}),
      queue: this.queue,
      streamingIdleMs: this.streamingIdleMs,
      preFirstByteIdleMs: this.preFirstByteIdleMs,
      ...(opts.debug ? { debug: opts.debug } : {}),
      ...(opts.requestCompaction ? { requestCompaction: opts.requestCompaction } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.activeCraftbookStep ? { activeCraftbookStep: opts.activeCraftbookStep } : {}),
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
    });
  }

  /**
   * Fall back to a parameter-size heuristic when the caller didn't pin
   * `num_ctx` explicitly. Looks up the model's reported `parameter_size`
   * in `/api/tags`. If the tag isn't there (or the probe fails) use the
   * plain baseline — better than Ollama's own 2048.
   */
  private async resolveNumCtx(modelId: string): Promise<number> {
    try {
      const tags = await this.fetchTags();
      const hit = tags.models.find((m) => m.name === modelId);
      return heuristicNumCtx(hit?.details?.parameter_size);
    } catch {
      return DEFAULT_NUM_CTX;
    }
  }

  /**
   * Pick which Ollama tag to run this session on. Preference order:
   *   1. An explicit `model` from the session options (per-gezel pin).
   *   2. The configured `defaultModel.ollama` — if it's installed.
   *   3. The first installed tag we see via `/api/tags`.
   *
   * The third fallback is important: a user who swaps provider away from
   * Copilot without configuring a default ends up pointed at our old
   * hard-coded `llama3.2` default, which they probably haven't pulled.
   * Probe the real install list and pick something that exists.
   */
  private async resolveModel(sessionPin: string | undefined): Promise<string> {
    if (sessionPin) return sessionPin;
    let installed: string[] = [];
    try {
      const tags = await this.fetchTags();
      installed = tags.models.map((m) => m.name);
    } catch {
      // If /api/tags is unreachable, fall through to the static default —
      // we'll get a clear 404 at send time anyway.
    }
    if (installed.includes(this.defaultModel)) return this.defaultModel;
    if (installed.length > 0) {
      const picked = installed[0]!;
      if (this.defaultModel !== DEFAULT_MODEL) {
        // User had a configured default but it's missing. Loud.
        log.warn(
          `[ollama] configured default model "${this.defaultModel}" is not installed; falling back to "${picked}"`,
        );
      } else {
        log.info(`[ollama] no configured default; using "${picked}"`);
      }
      return picked;
    }
    return this.defaultModel;
  }

  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.fetchTags();
    const models: ModelInfo[] = tags.models.map((m) => ({
      id: m.name,
      name: m.name,
      supportsTools: supportsToolsByFamily(m.name),
      contextWindow: heuristicNumCtx(m.details?.parameter_size),
      ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
    }));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  /** Exposed so the HTTP routes can reuse the same base URL + parsing. */
  async fetchTags(): Promise<OllamaTagsResponse> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`[ollama] ${this.baseUrl}/api/tags returned ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as OllamaTagsResponse;
  }
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    details?: { parameter_size?: string; family?: string };
  }>;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_call_id?: string;
  /**
   * Ollama vision models (llava, llama3.2-vision, etc.) accept images
   * as a parallel array of bare base64 strings — no data URI prefix.
   * Only meaningful on `user` messages.
   */
  images?: string[];
}

interface OllamaSessionDeps {
  baseUrl: string;
  model: string;
  systemMessage: string;
  bridges: McpBridgePool;
  priorMessages: Array<
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  /**
   * Caller-supplied external tool definitions. Advertised in Ollama's
   * `/api/chat` request body alongside any bridge tools; calls against
   * these names halt the loop rather than executing — captured via
   * {@link LLMSession.capturedToolCalls}.
   */
  externalTools?: ExternalToolSpec[];
  numCtx: number;
  /** Max tokens emitted per turn. Maps to `options.num_predict`. */
  numPredict: number;
  /** When set, passed verbatim as the top-level `think` flag on every
   *  /api/chat request. When undefined, the flag is omitted (Ollama
   *  uses its per-model default). */
  think?: boolean;
  queue: ProviderQueue;
  /** Mid-stream silence cap (ms). See block comment at the call site. */
  streamingIdleMs: number;
  /** Pre-first-byte cap (ms). See block comment at the call site. */
  preFirstByteIdleMs: number;
  debug?: { isEnabled(): boolean };
  /** Mid-tool-loop compaction hook. See {@link SessionOpts.requestCompaction}. */
  requestCompaction?: NonNullable<SessionOpts['requestCompaction']>;
  /**
   * Resolved per-model behavior profile. The session reads it at three
   * gate points: ramble-detector instantiation, pre-tool preamble fold,
   * and the Gemma special-token salvage. Absent for sessions whose
   * caller didn't carry a profile (third-party catalog, mock provider
   * in some test paths) — those gates fall back to off.
   */
  profile?: ResolvedModelProfile;
  /**
   * Active craftbook step. Passed through to anti-spin abort messages
   * so the corrective points at the step's onExit script instead of
   * generic `writeFile`. Unset on non-task sessions.
   */
  activeCraftbookStep?: NonNullable<SessionOpts['activeCraftbookStep']>;
  /**
   * Resolved per-model tuning. Applied to `body.options` via
   * `OLLAMA_TUNING_MAP` at request-build time. Tuning's `maxTokens`
   * wins over `numPredict` when both are set. `enableThinking` lands
   * as the top-level `think` body field, overriding the constructor's
   * `think` when both are present.
   */
  tuning?: import('../model-profile/index.js').ResolvedTuning;
}

/** See `MID_LOOP_COMPACT_RATIO` in llama-cpp/provider.ts. */
const MID_LOOP_COMPACT_RATIO = 0.7;
const MID_LOOP_COMPACT_MIN_PRIOR = 4;

/**
 * Max back-to-back tool-call rounds the model is allowed in one turn
 * before we bail. Orientation + exploration on a real project routinely
 * chains 20–40 reads (readdir fan-out + readFile on key files +
 * read_artifact on design docs + get_task + read_task_notes), before
 * the model writes a single line. Pathological loops (model re-calling
 * the same tool with the same args because it didn't absorb the
 * response) usually show up within 3 identical calls. So: cap the
 * absolute ceiling high, catch the common failure mode early via a
 * separate repeat detector (see {@link REPEAT_CALL_BAIL_THRESHOLD}).
 *
 * History: started at 12, bumped to 24 after a dev-gezel exploration
 * hit the ceiling, bumped to 48 after a realistic "explore this project
 * then work on a handoff brief" flow hit 24 with only diverse reads
 * and no repeats, then bumped to 96 to give long handoff/implementation
 * passes plenty of headroom — the repeat detector is the real
 * stuck-signal, not the absolute ceiling.
 */
const MAX_TOOL_LOOP_TURNS = 96;

/**
 * If the model invokes the same `(tool, args)` pair this many times
 * across a single turn, abort early — it almost certainly means the
 * model isn't reading the tool output and is just re-requesting the
 * same call. The error surfaces which call looped so the user can
 * understand why it bailed instead of seeing a generic "too many loops".
 */
const REPEAT_CALL_BAIL_THRESHOLD = 3;

class OllamaSession extends StreamingSessionBase implements LLMSession {
  /** Running message list — grows with each send + tool call. */
  private readonly messages: OllamaMessage[];
  /** See LlamaCppSession.currentTurnStartIdx — same role here. */
  private currentTurnStartIdx = 0;
  private compactedThisTurn = false;
  /**
   * Aggregated `<think>` / `<reasoning>` text captured this turn, across
   * every iteration of the tool loop. Reset at the top of each
   * `sendAndWaitInner` so a fresh turn starts clean. Read by
   * ChatManager via `getLastTurnReasoning()` after the turn resolves.
   */
  private lastTurnReasoning = '';

  private readonly externalToolNames: Set<string>;
  private capturedCalls: ExternalToolCall[] = [];

  constructor(private readonly deps: OllamaSessionDeps) {
    super();
    this.externalToolNames = new Set((deps.externalTools ?? []).map((t) => t.name));
    this.messages = [{ role: 'system', content: deps.systemMessage }];
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
          content: m.content,
          tool_calls: m.toolCalls.map((tc) => {
            let args: Record<string, unknown> = {};
            try {
              args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
            } catch {
              /* leave empty — Ollama tolerates {} for missing args */
            }
            return { function: { name: tc.name, arguments: args } };
          }),
        });
        continue;
      }
      this.messages.push({ role: m.role, content: m.content });
    }
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this.capturedCalls];
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  get model(): string {
    return this.deps.model;
  }
  get numCtx(): number {
    return this.deps.numCtx;
  }
  /**
   * Character-based estimate of the prompt size ollama will see on the
   * next /api/chat request. Used by ChatManager to decide whether to
   * surface a context-window warning.
   *
   * Includes assistant tool-call args + the function-calling schema
   * (`body.tools`). Ollama templates the tool block into the prompt
   * the same way llama-server does, so on a heavy-tool session it can
   * dwarf the chat transcript on turn 1; counting it here lets the
   * pressure check fire honestly. See {@link LlamaCppSession.estimatePromptChars}.
   */
  estimatePromptChars(): number {
    let total = 0;
    for (const m of this.messages) {
      total += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += tc.function.name.length + JSON.stringify(tc.function.arguments).length;
        }
      }
    }
    if (!this.deps.bridges.isEmpty()) {
      for (const t of this.deps.bridges.getOpenAITools()) {
        total += JSON.stringify(t).length;
      }
    }
    return total;
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // All wall-clock work (timeouts, idle watchdog) must start AFTER
    // the queue slot is acquired. A turn queued behind others could
    // otherwise fail from waiting rather than running. `runInQueue`
    // handles the acquire/release lifecycle.
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  /**
   * See {@link LlamaCppSession.maybeCompactMidLoop} — same contract.
   * Ollama accumulates the same in-memory transcript pattern, so the
   * same pressure-and-swap logic applies here even though Ollama's
   * `num_ctx` is per-request rather than divided by parallel slots.
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
        `[ollama] mid-loop compaction request failed (continuing un-compacted): ${err instanceof Error ? err.message : String(err)}`,
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
      `[ollama] mid-loop compacted ${removed} prior message(s) → 1 synthesis (${result.syntheticContent.length} chars)`,
    );
    this.emitWarning(
      'Compacted earlier conversation to free up working window for the current turn.',
    );
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    const totalTimeoutMs = opts?.timeoutMs ?? 120_000;
    // Split-idle watchdog. Ollama goes silent for three different
    // reasons; telling them apart lets us pick a reasonable bound
    // for each:
    //   - Cold start: loading a 30–70B model off disk into GPU memory
    //     can take 30–90s before the first token streams. Users
    //     routinely hit this the first time they use a given model
    //     or after a GPU eviction.
    //   - Prompt prefill: a long system prompt + big context can
    //     take 10–60s of GPU work before the first generated token.
    //     On a 30B+ reasoning model with a 30K-token prompt this can
    //     stretch past 3 min — the original 180s cap killed real
    //     work. 5 min default with a `config.ollamaPreFirstByteIdleSec`
    //     knob covers the common case while still aborting truly
    //     stuck prefills.
    //   - Mid-stream stall: once bytes are flowing, a stall really
    //     does mean the server lost its way — but on a 30B+ model
    //     generating long structured output (deeply-nested JSX,
    //     big tool-call argument JSON), inter-token gaps of
    //     60-300s are normal under GPU memory pressure, thermal
    //     throttling, or silent reasoning phases (qwen3-style
    //     reasoning models). History: 60 → 120 → 180 → 300s; each
    //     bump caught a class of legitimate work that was being
    //     killed mid-pause (last datapoints: a voorman turn paused
    //     90s before resuming useful work; reasoning models can
    //     chain-of-thought silently for several minutes). At 5 min
    //     a truly-wedged turn still aborts within a tolerable
    //     window. User-tunable via `config.ollamaStreamingIdleSec`.
    // So: be patient before the first byte, lenient mid-stream.
    const preFirstByteIdleMs = this.deps.preFirstByteIdleMs;
    const streamingIdleMs = this.deps.streamingIdleMs;
    const deadline = Date.now() + totalTimeoutMs;
    const start = Date.now();
    // Ollama wants `images` as bare base64 on the user message itself.
    // Non-vision models ignore the field, so it's safe to always attach
    // when present.
    const userMsg: OllamaMessage = { role: 'user', content: prompt };
    if (opts?.attachments && opts.attachments.length > 0) {
      userMsg.images = opts.attachments.map((a) => a.base64);
    }
    // Mark this turn's start for mid-loop compaction. See
    // LlamaCppSession.sendAndWaitInner for the rationale.
    this.currentTurnStartIdx = this.messages.length;
    this.compactedThisTurn = false;
    this.messages.push(userMsg);

    // Reset captures — each sendAndWait surfaces only its own externals.
    this.capturedCalls = [];
    const bridgeTools = this.deps.bridges.isEmpty() ? [] : toOllamaTools(this.deps.bridges);
    const externalAsOllama: Array<Record<string, unknown>> = (this.deps.externalTools ?? []).map(
      (t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters,
        },
      }),
    );
    const tools =
      bridgeTools.length + externalAsOllama.length > 0
        ? [...bridgeTools, ...externalAsOllama]
        : undefined;
    const debugOn = this.deps.debug?.isEnabled() === true;
    // Reset captured reasoning at the top of each turn — the manager
    // reads `getLastTurnReasoning()` after this call resolves and
    // stashes the trace on the assistant message.
    this.lastTurnReasoning = '';
    let fullText = '';
    let lastPromptEvalCount = 0;
    let lastEvalCount = 0;
    let lastDoneReason = '';
    // Generation-phase duration in nanoseconds, reported by Ollama on
    // the terminal `done: true` chunk. Separate from wall-clock so
    // turn_stats' tokens/sec metric reflects pure model throughput,
    // not prefill + network overhead.
    let lastEvalDurationNs = 0;
    // Sequence of tool calls made during this turn — used for repeat
    // detection + the diagnostic summary appended to the bail error.
    const callLog: Array<{ name: string; argsKey: string; argsRaw: unknown }> = [];
    // Per-tool consecutive-failure tracker. Layers on top of
    // `detectRepeatCall` (which fires on same-args loops); this one
    // catches the broader pattern of "same tool keeps erroring with
    // varying args" — e.g. Qwen 3.6 27B emitting JSON-stringified
    // assignee/phases for `create_task`, where each retry has
    // slightly-different stringified content but the validation
    // error is the same. See ToolFailureTracker for thresholds.
    const failureTracker = new ToolFailureTracker();
    // Per-turn same-(name, args) repeat tracker. Layers on top of the
    // existing `detectRepeatCall` (which fires on consecutive
    // duplicates) — this one catches non-consecutive same-args
    // repeats, the narrative-spinning loop the user reported on Ada.
    const repeatTracker = new ToolRepeatTracker();
    // Per-turn ask_user_question dedup + post-question prose-fold
    // signal. See the matching block in MlxSession for the rationale.
    let askedQuestionThisTurn = false;
    // Per-turn project-macro guard. See MlxSession for the wild-caught
    // scenario — local cold-start models brainstorming variations of
    // start_project in one response and producing N duplicate projects.
    let startedProjectOrJobThisTurn: { tool: string; firstResult: string } | null = null;

    for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
      // Mid-loop pressure check — same shape as LlamaCpp + MLX.
      if (turn > 0) await this.maybeCompactMidLoop();

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`[ollama] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
      }

      const options: Record<string, unknown> = {
        num_ctx: this.deps.numCtx,
        num_predict: this.deps.numPredict,
      };
      const body: Record<string, unknown> = {
        model: this.deps.model,
        messages: this.messages,
        stream: true,
        options,
      };
      if (this.deps.think !== undefined) body.think = this.deps.think;
      // Per-model tuning. Ollama's API splits "sampling-ish" fields
      // (under `options`) from "session-shape" fields (`think`,
      // `format` at the body root). Sampling targets `options` via
      // OLLAMA_OPTIONS_TUNING_MAP; reasoning/output target `body` via
      // OLLAMA_BODY_TUNING_MAP. Tuning's `enableThinking` overrides
      // `this.deps.think`.
      if (this.deps.tuning) {
        applyTuning(options, this.deps.tuning, OLLAMA_OPTIONS_TUNING_MAP);
        applyTuning(body, this.deps.tuning, OLLAMA_BODY_TUNING_MAP);
      }
      if (tools && tools.length > 0) body.tools = tools;

      // One AbortController gates both the hard cap and an idle watchdog.
      // Without the idle watchdog a model that stops emitting tokens mid-
      // generation (Ollama doesn't close the socket — it just goes silent)
      // would hold the chat session open forever, eating one of Chromium's
      // 6-per-origin connection slots in the renderer.
      const ctrl = new AbortController();
      let abortKind: 'idle' | 'hard' | 'external' | 'ramble' | null = null;
      // `idlePhase` tracks whether we're pre- or post- first byte so
      // the error message below can say which bound fired.
      let idlePhase: 'pre-first-byte' | 'streaming' = 'pre-first-byte';
      // Link the caller's signal (e.g. ChatManager.cancelInflight)
      // so user-initiated cancel aborts the fetch instead of waiting
      // for the idle watchdog (up to 60s post-first-byte) to notice.
      const externalSignal = opts?.queue?.signal;
      const onExternalAbort = () => {
        abortKind = 'external';
        ctrl.abort();
      };
      if (externalSignal) {
        if (externalSignal.aborted) {
          onExternalAbort();
        } else {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }
      // Wallclock-based deadline poll. Node `setTimeout(remaining)` pauses
      // when macOS suspends the process, so a turn started just before
      // sleep won't abort 3 min later — the timer effectively re-anchors
      // to wake time. `setInterval` also pauses, but the first post-wake
      // tick compares `Date.now()` to the precomputed wallclock
      // `deadline` and aborts within the poll period. Drift is bounded
      // by the 2 s interval, not the sleep duration.
      const hardTimer = setInterval(() => {
        if (Date.now() < deadline) return;
        abortKind = 'hard';
        ctrl.abort();
        clearInterval(hardTimer);
      }, 2_000);
      let idleTimer = setTimeout(() => {
        abortKind = 'idle';
        ctrl.abort();
      }, preFirstByteIdleMs);
      // Stall-diagnostic state. `firstByteAt` flips from null on the
      // first chunk so we can report "tokens received in Xs before
      // going silent for Ys" — that telemetry is the difference
      // between "model genuinely stalled" and "model never even
      // started." `lastTokenAt` is updated on every chunk.
      let firstByteAt: number | null = null;
      let lastTokenAt: number | null = null;
      const resetIdle = () => {
        idlePhase = 'streaming';
        if (firstByteAt === null) firstByteAt = Date.now();
        lastTokenAt = Date.now();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortKind = 'idle';
          ctrl.abort();
        }, streamingIdleMs);
      };

      // Best-effort `/api/ps` probe — fires when we abort due to
      // silence so the error message can say whether Ollama itself
      // is responsive. Three outcomes:
      //   - Probe returns < 5s with model(s) loaded → Ollama is
      //     alive; the model itself stalled (GPU pressure, KV
      //     eviction, or genuine hang).
      //   - Probe returns < 5s with empty list → Ollama is alive
      //     but the model was unloaded mid-turn (eviction).
      //   - Probe times out / errors → Ollama itself is hung or
      //     restarting; the silence is structural.
      const probeOllamaPs = async (): Promise<string> => {
        const probeCtrl = new AbortController();
        const probeTimer = setTimeout(() => probeCtrl.abort(), 5000);
        const probeStart = Date.now();
        try {
          const probeRes = await fetch(`${this.deps.baseUrl}/api/ps`, {
            signal: probeCtrl.signal,
          });
          if (!probeRes.ok) return `unhealthy (HTTP ${probeRes.status})`;
          const json = (await probeRes.json()) as {
            models?: Array<{ name?: string; size_vram?: number; expires_at?: string }>;
          };
          const elapsed = Date.now() - probeStart;
          const loaded = json.models ?? [];
          if (loaded.length === 0) {
            return `responsive in ${elapsed}ms but NO models currently loaded (model may have been evicted mid-turn)`;
          }
          const ours = loaded.find((m) => m.name === this.deps.model);
          if (!ours) {
            const others = loaded.map((m) => m.name).join(', ');
            return `responsive in ${elapsed}ms; "${this.deps.model}" is NOT loaded (loaded: ${others}) — likely evicted mid-turn`;
          }
          return `responsive in ${elapsed}ms; "${this.deps.model}" is still loaded (size_vram: ${ours.size_vram ?? 'unknown'})`;
        } catch {
          return 'unreachable within 5s — Ollama itself is hung or restarting';
        } finally {
          clearTimeout(probeTimer);
        }
      };

      const abortErrorMessage = async (): Promise<string> => {
        if (abortKind === 'external') return '[ollama] turn cancelled by caller';
        if (abortKind === 'ramble') {
          return `[ollama] aborting — the gezel emitted ${turnText.length} characters of prose this turn without calling any action tool. Stop planning. Your next message must START with a single tool call — or, if the work is genuinely finished and nothing is left to do, be ONE short sentence saying so and nothing else. If shipping source or project files and \`writeFile\` is in your tool list, call it NOW with the full file contents — no preamble, no plan. If you lack workspace write access, start with a handoff tool or \`ask_user_question\` instead. Do not save source files with \`write_artifact\`; artifacts are for plans/scratch.`;
        }
        if (abortKind === 'idle') {
          if (idlePhase === 'pre-first-byte') {
            const probe = await probeOllamaPs();
            return `[ollama] no first byte after ${Math.round(preFirstByteIdleMs / 1000)}s; aborting (model likely still loading, or prompt prefill failed). Ollama probe: ${probe}.`;
          }
          // Streaming-idle: include partial-content stats so the user
          // can see how much we got before the silence started.
          const tokensSoFar = turnText.length;
          const sinceFirstByte =
            firstByteAt !== null ? Math.round((Date.now() - firstByteAt) / 1000) : null;
          const sinceLastToken =
            lastTokenAt !== null ? Math.round((Date.now() - lastTokenAt) / 1000) : null;
          const probe = await probeOllamaPs();
          const stats = sinceFirstByte
            ? `received ${tokensSoFar} chars in ${sinceFirstByte}s before going silent for ${sinceLastToken}s`
            : `received ${tokensSoFar} chars before stalling`;
          return `[ollama] no output for ${Math.round(streamingIdleMs / 1000)}s mid-stream; aborting (${stats}). Ollama probe: ${probe}.`;
        }
        return `[ollama] timed out after ${Math.round(totalTimeoutMs / 1000)}s`;
      };
      const cleanupTurn = () => {
        clearInterval(hardTimer);
        clearTimeout(idleTimer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      };

      let res: Response;
      try {
        res = await fetch(`${this.deps.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        cleanupTurn();
        if ((err as Error).name === 'AbortError') {
          throw new Error(await abortErrorMessage());
        }
        throw err;
      }
      if (!res.ok || !res.body) {
        cleanupTurn();
        const txt = await res.text().catch(() => '');
        throw new Error(
          `[ollama] /api/chat returned ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`,
        );
      }

      let turnText = '';
      let toolCalls: OllamaMessage['tool_calls'];
      // Tracks calls synthesized by the truncation salvage stage —
      // their tool results get an `appendToFile` continuation hint
      // appended via {@link appendTruncationHintToToolResult}. Lives
      // for the duration of one tool-loop iteration; entries don't
      // need to survive across turns. Uses object identity (WeakSet)
      // because Ollama calls don't carry a stable id field.
      const truncatedCalls = new WeakSet<NonNullable<OllamaMessage['tool_calls']>[number]>();
      // Wall-of-prose detector — see MlxSession for the rationale.
      // `RambleDetector` measures prose-since-last-action so the cap
      // re-arms after every tool-call signal (the boolean version
      // this replaced disarmed permanently on the first signal).
      // Profile-driven: opted in via `turn.ramble-detection`, with
      // per-model thresholds. Absent → detector disabled (the
      // family-keyed substring gate is gone — opt-in via the
      // manifest's `behaviors` array now controls applicability).
      const rambleConfig = profileBehaviorConfig<TurnRambleDetectionConfig>(
        this.deps.profile,
        'turn.ramble-detection',
      );
      const ramble = rambleConfig
        ? new RambleDetector({
            threshold: rambleConfig.coldThreshold,
            postActionThreshold: rambleConfig.postActionThreshold,
            enabled: true,
            // Models that leak untagged reasoning narrate their plan in
            // the open before acting; give the cold cap room to reach
            // the tool call. Prefer the profile opt-in, but also honor the
            // model-id family signal so a verbose family whose profile is
            // missing `turn.preamble-folding` (config drift) still gets
            // the leaky budget instead of the tight 6k cap.
            leakyReasoning:
              profileHasBehavior(this.deps.profile, 'turn.preamble-folding') ||
              leaksUntaggedReasoning(this.deps.model),
          })
        : // Repetition guard is safe on any local model (fires only on
          // degenerate low-novelty loops); arm it even without the
          // length-cap opt-in. See RambleDetector.
          new RambleDetector({ threshold: 6000, enabled: false, repetitionGuardEnabled: true });
      try {
        for await (const line of readNdjson(res.body)) {
          const chunk = line as OllamaChatChunk;
          // Only USER-VISIBLE progress resets the idle watchdog.
          // Bare framing chunks (`{message: {content: ""}, done:
          // false}` housekeeping that some Ollama versions emit
          // between actual tokens) used to reset the timer, which
          // meant the watchdog could wait forever while the chat
          // bubble showed nothing — Ada was technically "active"
          // per the wire but the user saw no progress. Tying the
          // reset to actual content / tool_calls aligns the
          // watchdog with what the user sees: if the bubble would
          // get a delta, the timer resets; otherwise it doesn't.
          // The terminal `done: true` chunk also counts (it's the
          // legitimate end of the stream).
          const hasContent = Boolean(chunk.message?.content?.length);
          const hasToolCalls = Boolean(chunk.message?.tool_calls?.length);
          if (hasContent || hasToolCalls || chunk.done) resetIdle();
          // Bare framing chunk (no content, no tool_calls, not done)
          // — the wire is alive but the model isn't producing
          // user-visible output. Surface as a "wire pulse" so the
          // UI can accumulate dots in the bubble; gives the user a
          // signal that "Ollama is still ticking" during long
          // silent reasoning phases without polluting the
          // generation log.
          if (!hasContent && !hasToolCalls && !chunk.done) this.emitWirePulse();
          if (hasContent && chunk.message?.content) {
            turnText += chunk.message.content;
            this.emitDelta(chunk.message.content);
            if (abortKind === null && ramble.observeContent(turnText)) {
              abortKind = 'ramble';
              log.error(
                `[ollama] ABORT-FIRED reason=ramble (${ramble.firedOnRepetition ? 'repetition-loop' : ramble.inPostActionMode ? 'post-action' : 'cold'}; ${ramble.proseSinceLastAction} chars since last signal, cap ${ramble.activeThreshold})`,
              );
              ctrl.abort();
            }
          }
          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            // Tool-call chunks carry no visible content — pulse so tool
            // activity reads as live progress, not a stall.
            this.emitWirePulse();
            ramble.recordStructuredAction(turnText.length);
            toolCalls = chunk.message.tool_calls;
          }
          if (chunk.done) {
            if (typeof chunk.prompt_eval_count === 'number') {
              lastPromptEvalCount = chunk.prompt_eval_count;
            }
            if (typeof chunk.eval_count === 'number') {
              lastEvalCount = chunk.eval_count;
            }
            if (typeof chunk.eval_duration === 'number') {
              lastEvalDurationNs = chunk.eval_duration;
            }
            if (typeof chunk.done_reason === 'string') {
              lastDoneReason = chunk.done_reason;
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // Recovery path: a `ramble` abort that has salvageable
          // tool-call markup falls through to the salvage block
          // below. See MlxSession for the rationale — keeps the
          // model's queued tools alive so the next iteration sees
          // results.
          if (abortKind === 'ramble' && /<tool_call>|<function=/i.test(turnText)) {
            this.emitWarning(
              `Stopped the planning monologue (${turnText.length} chars without follow-through) — firing the tool calls you queued. Take a smaller next step.`,
            );
            // Don't re-throw; fall through to the salvage block.
          } else {
            // Last-ditch code-block salvage on ramble abort: small
            // models often inline the file in a fenced block instead of
            // calling the write tool. Promote each block to a synthesized
            // write call. Prefer `writeFile` (salvaged source belongs in
            // the workspace, not the artifacts drawer — the abort copy
            // itself says so); fall back to `write_artifact` only when
            // the role has no workspace-write surface. Assigning
            // `toolCalls` here makes the prose-shaped salvage below skip.
            // Shared with MLX + llama.cpp.
            const salvaged =
              abortKind === 'ramble'
                ? (() => {
                    const known = new Set(
                      this.deps.bridges.isEmpty()
                        ? []
                        : this.deps.bridges.getOpenAITools().map((t) => t.name),
                    );
                    const salvageToolName = known.has('writeFile')
                      ? 'writeFile'
                      : known.has('write_artifact')
                        ? 'write_artifact'
                        : null;
                    if (!salvageToolName) return null;
                    const blocks = salvageCodeBlocks(turnText);
                    if (blocks.length === 0) return null;
                    log.info(
                      `[ollama] code-block-salvage: extracted ${blocks.length} ` +
                        `fenced block(s) from ${turnText.length}-char ramble buffer ` +
                        `→ ${salvageToolName} (${blocks.map((b) => `${b.lang}:${b.filename}`).join(', ')})`,
                    );
                    this.emitWarning(
                      `The model wrote ${blocks.length === 1 ? 'a code block' : `${blocks.length} code blocks`} in chat instead of calling ${salvageToolName} — promoting them to actual file writes. Ask the model to use tools directly next time.`,
                    );
                    return blocks.map((b) => ({
                      function: {
                        name: salvageToolName,
                        arguments: { path: b.filename, content: b.content },
                      },
                    }));
                  })()
                : null;
            if (salvaged) {
              toolCalls = salvaged;
              // Don't re-throw; fall through with the synthesized calls.
            } else {
              throw new Error(await abortErrorMessage());
            }
          }
        } else {
          throw err;
        }
      } finally {
        cleanupTurn();
      }

      // Prose-shaped tool-call salvage. Small models on Ollama
      // sometimes write `name(args)` in a markdown code block
      // instead of emitting a structured tool_calls event. If
      // nothing fired through the structured stream but the streamed
      // text contains a recognizable call shape, promote it. Strict
      // gating (known-tools set + JSON parse) prevents false
      // positives. Shared with MLX + llama.cpp.
      if ((!toolCalls || toolCalls.length === 0) && turnText.length > 0) {
        const knownToolNames = new Set(
          this.deps.bridges.isEmpty() ? [] : this.deps.bridges.getOpenAITools().map((t) => t.name),
        );
        const proseSalvaged = findProseToolCallSpans(turnText, knownToolNames);
        // Anthropic-style XML tag form (`<browser_navigate url="..." />`).
        // Some Qwen variants (notably 3.6 27B) emit this when the
        // `<|tool_call|>` markup channel is closed off — the model
        // picks the next-most-familiar tool-use shape from training
        // data. Run before the JSON envelope salvage so a tag like
        // `<list_projects />` isn't mis-parsed by the JSON walker.
        const xmlTagSalvaged =
          proseSalvaged.length > 0 ? [] : findXmlTagToolCallSpans(turnText, knownToolNames);
        // Anthropic-style `<function_calls><invoke name="X">...</invoke></function_calls>`
        // markup. The literal Claude tool-use XML format that Qwen
        // 3.6 reaches for after the simpler `<name attr="..." />`
        // path is closed off. Parameters arrive as nested
        // `<parameter name="K">value</parameter>` elements.
        const claudeInvokeSalvaged =
          proseSalvaged.length > 0 || xmlTagSalvaged.length > 0
            ? []
            : findClaudeInvokeToolCallSpans(turnText, knownToolNames);
        // Hermes-2-Pro / Functionary `<function=NAME><parameter=K>V</parameter></function>`
        // markup, often wrapped in Qwen's canonical `<tool_call>` envelope
        // (Qwen 3.6 has been trained on both corpora and at heavy quant
        // mixes them).
        const hermesSalvaged = (() => {
          if (
            proseSalvaged.length > 0 ||
            xmlTagSalvaged.length > 0 ||
            claudeInvokeSalvaged.length > 0
          ) {
            return [];
          }
          const strict = findHermesFunctionToolCallSpans(turnText, knownToolNames);
          if (strict.length > 0) return strict;
          if (!/<function=/i.test(turnText)) return [];
          // Streaming-truncated Hermes — same recovery as the mlx
          // provider. Wild-caught on Qwen 3.6 27B writing files past
          // max_tokens, never emitting `</parameter>` or `</function>`.
          return findHermesFunctionToolCallSpansLenient(turnText, knownToolNames);
        })();
        // Shell-style `<tool_call>name key="value"` per line, no
        // close, no JSON envelope. Wild-caught on Qwen 3.6 27B —
        // a degraded form of Qwen's canonical `<tool_call>` template
        // where the JSON wrapper got dropped.
        const shellSalvaged =
          proseSalvaged.length > 0 ||
          xmlTagSalvaged.length > 0 ||
          claudeInvokeSalvaged.length > 0 ||
          hermesSalvaged.length > 0
            ? []
            : findShellToolCallSpans(turnText, knownToolNames);
        // Walk the streamed text for every JSON envelope (Qwen and
        // friends sometimes chain several) AND for a truncated tail
        // (model stopped mid-call). Previously only the first
        // envelope fired; the rest stayed as visible text.
        const envelopeSalvaged =
          proseSalvaged.length > 0 ||
          xmlTagSalvaged.length > 0 ||
          claudeInvokeSalvaged.length > 0 ||
          hermesSalvaged.length > 0 ||
          shellSalvaged.length > 0
            ? []
            : parseJsonEnvelopeToolCalls(turnText, knownToolNames);
        const envelopeTruncated =
          proseSalvaged.length > 0 ||
          xmlTagSalvaged.length > 0 ||
          claudeInvokeSalvaged.length > 0 ||
          hermesSalvaged.length > 0 ||
          shellSalvaged.length > 0
            ? null
            : findTruncatedJsonEnvelope(turnText);
        if (proseSalvaged.length > 0) {
          // Successful salvage — the tool fires correctly via the
          // returned `toolCalls`, the user sees a normal tool widget.
          // No yellow warning; salvage IS the success case.
          log.info(
            `[ollama] salvaged ${proseSalvaged.length} prose-shaped tool call(s): ` +
              `${proseSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = proseSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
          // Strip every salvaged prose body so the persisted bubble
          // doesn't show the calls as decoration alongside the actual
          // tool widgets.
          turnText = stripProseToolCallsFromText(turnText, proseSalvaged);
        } else if (xmlTagSalvaged.length > 0) {
          log.info(
            `[ollama] salvaged ${xmlTagSalvaged.length} XML-tag tool call(s): ` +
              `${xmlTagSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = xmlTagSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
          turnText = stripXmlTagToolCallsFromText(turnText, xmlTagSalvaged);
        } else if (claudeInvokeSalvaged.length > 0) {
          log.info(
            `[ollama] salvaged ${claudeInvokeSalvaged.length} Claude-invoke tool call(s): ` +
              `${claudeInvokeSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = claudeInvokeSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
          turnText = stripClaudeInvokeToolCallsFromText(turnText, claudeInvokeSalvaged);
        } else if (hermesSalvaged.length > 0) {
          log.info(
            `[ollama] salvaged ${hermesSalvaged.length} Hermes-style tool call(s): ` +
              `${hermesSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = hermesSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
          turnText = stripHermesFunctionToolCallsFromText(turnText, hermesSalvaged);
        } else if (shellSalvaged.length > 0) {
          log.info(
            `[ollama] salvaged ${shellSalvaged.length} shell-style tool call(s): ` +
              `${shellSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = shellSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
          turnText = stripShellToolCallsFromText(turnText, shellSalvaged);
        } else if (envelopeSalvaged.length > 0) {
          log.info(
            `[ollama] salvaged ${envelopeSalvaged.length} JSON-envelope tool call(s): ` +
              `${envelopeSalvaged.map((c) => c.name).join(', ')}`,
          );
          toolCalls = envelopeSalvaged.map((parsed) => ({
            function: { name: parsed.name, arguments: parsed.arguments },
          }));
        }
        if (envelopeSalvaged.length > 0 || envelopeTruncated) {
          turnText = stripJsonEnvelopesFromText(
            turnText,
            envelopeSalvaged,
            envelopeTruncated?.matchStart,
          );
        }
        // Hide unrecognized-name JSON envelopes from the bubble too.
        // These would otherwise leak through with no salvage warning
        // (we can't safely fabricate a call) but no strip either,
        // leaving the user staring at a botched first attempt.
        if ((!toolCalls || toolCalls.length === 0) && !envelopeTruncated) {
          const miss = findUnrecognizedToolEnvelope(turnText, knownToolNames);
          if (miss) {
            turnText = stripJsonEnvelopesFromText(turnText, [
              { matchStart: miss.matchStart, matchEnd: miss.matchEnd },
            ]);
          }
        }
        // Layer 3 — truncation-with-partial-args salvage. When the
        // model started a write-shaped call but the stream cut off
        // mid-content, land the partial bytes anyway and tag the
        // synthesized call so the tool-result auto-continuation
        // hint fires. Shared with MLX + llama-cpp providers via
        // {@link salvageWriteShapedTruncation}. Only runs when no
        // other salvage path produced a call this iteration.
        if (!toolCalls || toolCalls.length === 0) {
          const salvage = salvageWriteShapedTruncation(
            turnText,
            knownToolNames,
            `truncated-salvage-ollama-${turn}`,
          );
          if (salvage.synthesizedCall) {
            const s = salvage.synthesizedCall;
            const synthesized = { function: { name: s.name, arguments: s.argsObject } };
            toolCalls = [synthesized];
            truncatedCalls.add(synthesized);
            log.info(
              `[ollama] salvaged truncated ${s.name} call (path=${s.argsObject.path}, partial=${s.argsObject.content.length} bytes) — continuation hint will fire on the tool result`,
            );
            turnText = salvage.strippedContent;
          }
        }
        if (envelopeTruncated && (!toolCalls || toolCalls.length === 0)) {
          log.info(
            `[ollama] truncated JSON-envelope tool call: ${envelopeTruncated.wanted ?? '<unknown>'}`,
          );
          this.emitWarning(
            `The model's last tool call (\`${envelopeTruncated.wanted ?? 'unknown'}\`) was cut off mid-stream and was skipped. Try again — or raise ollamaNumPredict if this happens often.`,
          );
        } else if (!toolCalls || toolCalls.length === 0) {
          // Prose-shaped truncation — `name(args` with no closing paren.
          const proseTruncated = findTruncatedProseToolCall(turnText, knownToolNames);
          if (proseTruncated) {
            log.info(`[ollama] truncated prose tool call: ${proseTruncated.wanted}`);
            this.emitWarning(
              `The model started calling \`${proseTruncated.wanted}\` but was cut off mid-args. It likely spent its output budget on reasoning before reaching the tool call. Try again — or raise ollamaNumPredict.`,
            );
          }
        }
      }
      // Always pull `<think>…</think>` reasoning tags out of the visible
      // commit. Accumulate the captured trace into `lastTurnReasoning`
      // so ChatManager can stash it on the assistant message and the
      // chat bubble can render it behind a collapsed expander.
      {
        const split = extractReasoningWithProfile(turnText, this.deps.profile);
        turnText = split.visible;
        if (split.reasoning) {
          this.lastTurnReasoning =
            this.lastTurnReasoning.length > 0
              ? `${this.lastTurnReasoning}\n\n${split.reasoning}`
              : split.reasoning;
        }
      }

      // Auto-fold pre-tool preamble for verbose-family models. When
      // tool calls fired this turn, untagged visible text is almost
      // always reasoning the model leaked instead of wrapping in
      // `<think>`. The substantive answer comes after the tool runs.
      // See {@link foldPreToolPreamble} for the gating rationale.
      turnText = foldPreToolPreamble({
        text: turnText,
        toolCallsFired: Boolean(toolCalls && toolCalls.length > 0),
        modelLeaksReasoning: profileHasBehavior(this.deps.profile, 'turn.preamble-folding'),
        askedQuestionThisTurn,
      });

      // Append to fullText AFTER every salvage path has had its turn
      // at stripping. Earlier ordering meant the un-stripped prose /
      // envelope / reasoning text still landed in the persisted
      // assistant message even though the salvage worked.
      fullText += turnText;

      // External tool capture: when the model invoked any caller-
      // supplied external tool, halt the loop and surface ALL pending
      // calls (external + bridge) to the caller. Bridge tools in the
      // same turn go unexecuted — the `/v1/chat/completions` route
      // owns the next turn.
      //
      // Ollama's tool_calls don't carry an id (unlike OpenAI/Claude),
      // and `arguments` is already a parsed object. We synthesize a
      // stable id (`call_<index>_<name>`) and stringify the args so the
      // OpenAI tool_calls envelope shape stays consistent. The caller's
      // subsequent `role: 'tool'` message references this id; we
      // translate back when seeding history.
      if (
        toolCalls &&
        toolCalls.length > 0 &&
        toolCalls.some((tc) => this.externalToolNames.has(tc.function.name))
      ) {
        this.capturedCalls = toolCalls.map((tc, idx) => ({
          id: `call_${idx}_${tc.function.name}`,
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        }));
        this.messages.push({
          role: 'assistant',
          content: turnText,
          tool_calls: toolCalls,
        });
        this.emitUsage(
          buildTurnUsage({
            model: this.deps.model,
            inputTokens: lastPromptEvalCount,
            outputTokens: lastEvalCount,
            durationMs: Date.now() - start,
          }),
        );
        return fullText;
      }

      if (!toolCalls || toolCalls.length === 0) {
        // Normal turn end — record usage, commit assistant message, return.
        //
        // Skip the history push when the model produced literally
        // nothing: empty visible content AND empty reasoning AND no
        // tool calls. Wild-caught failure mode on `gemma4:26b`/Ollama
        // where the meester emits its end-of-turn token as the first
        // (only) output; turnText comes back empty, the
        // continuation-nudge cycle fires, and the model sees its
        // own empty assistant turns in history — which reinforces
        // the "produce nothing" pattern. Each retry locks in deeper.
        // Skipping the empty push lets the next nudge land directly
        // after the original user message in history, giving the
        // model a clean re-prompt instead of a self-reinforcing
        // emptiness chain. Captured reasoning content (channel-tag
        // blocks) is the relevant exception — a reasoning-only turn
        // is still real model output, just not visible, and the
        // next prompt benefits from the model seeing its own
        // chain-of-thought.
        const skipEmptyPush = turnText.length === 0 && this.lastTurnReasoning.length === 0;
        if (!skipEmptyPush) {
          this.messages.push({ role: 'assistant', content: turnText });
        } else {
          log.debug(
            '[ollama] skipping empty assistant push to history — model produced no visible content and no reasoning (avoids reinforcing the empty-reply loop on next continuation)',
          );
        }
        // Post-hoc context-window check. `prompt_eval_count` is the
        // empirical token count Ollama actually saw; if it
        // approached `num_ctx`, silent truncation is likely. Logged
        // loudly so it lands in the daemon log even when the user
        // isn't watching the UI; threshold is high enough (95%)
        // that we don't false-positive on healthy near-full
        // sessions.
        if (
          lastPromptEvalCount > 0 &&
          this.deps.numCtx > 0 &&
          lastPromptEvalCount >= this.deps.numCtx * 0.95
        ) {
          const pct = Math.round((100 * lastPromptEvalCount) / this.deps.numCtx);
          log.warn(
            `[ollama] turn used ${lastPromptEvalCount}/${this.deps.numCtx} prompt tokens (${pct}%) — context truncation likely; consider lowering input or raising num_ctx`,
          );
        }
        // Model hit the output cap. Two flavors to distinguish:
        //   (a) content was produced but got truncated mid-reply →
        //       inform the user; they'll see a clipped bubble.
        //   (b) no content at all → reasoning budget consumed the
        //       whole num_predict, nothing surfaced. Empty-bubble
        //       placeholder handles the *visual*; this warning +
        //       provider-level `warning` event lets the UI render
        //       a red banner so the user can act (raise num_predict
        //       or set ollamaThink=false).
        if (lastDoneReason === 'length') {
          const msg =
            turnText.length === 0
              ? `Ollama returned empty content — the model hit num_predict=${this.deps.numPredict} before streaming any reply (likely a reasoning model spending the whole budget on silent thinking). Raise ollamaNumPredict in settings, or set ollamaThink=false for this model.`
              : `Ollama truncated the reply at num_predict=${this.deps.numPredict} tokens — the model wanted to continue. Raise ollamaNumPredict in settings if the clipped output isn't enough.`;
          log.warn(`[ollama] ${msg}`);
          this.emitWarning(msg);
        }
        if (lastPromptEvalCount > 0 || lastEvalCount > 0) {
          const durationMs = Date.now() - start;
          this.emitUsage(
            buildTurnUsage({
              model: this.deps.model,
              inputTokens: lastPromptEvalCount,
              outputTokens: lastEvalCount,
              durationMs,
              ...(lastPromptEvalCount > 0 && this.deps.numCtx > 0
                ? { contextUtilization: { used: lastPromptEvalCount, limit: this.deps.numCtx } }
                : {}),
            }),
          );
          // Per-turn speed telemetry for the UI engine pill. Use
          // Ollama's own `eval_duration` (pure generation time) when
          // available — prefill + network overhead on the wall-clock
          // would dilute the metric. Fall back to wall-clock when
          // the chunk didn't carry it (old Ollama versions).
          const genMs = lastEvalDurationNs > 0 ? lastEvalDurationNs / 1_000_000 : durationMs;
          const tokensPerSec =
            lastEvalCount > 0 && genMs > 0 ? lastEvalCount / (genMs / 1000) : undefined;
          this.emitTurnStats({
            provider: 'ollama',
            promptTokens: lastPromptEvalCount,
            completionTokens: lastEvalCount,
            durationMs,
            ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
          });
        }
        return fullText;
      }

      // Tool loop: commit the assistant message (with tool_calls), execute
      // each call via the bridge, append tool outputs, iterate.
      this.messages.push({
        role: 'assistant',
        content: turnText,
        tool_calls: toolCalls,
      });
      let abortDueToFailureLoop: {
        tool: string;
        count: number;
        sourceFailureKind?: 'truncated' | 'not-persisted';
        transportFailure?: boolean;
      } | null = null;
      for (const call of toolCalls) {
        const fn = call.function;
        const argsKey = stableArgsKey(fn.arguments);
        callLog.push({ name: fn.name, argsKey, argsRaw: fn.arguments });
        let output: string;
        // Suppress duplicate ask_user_question per turn. See the
        // matching block in MlxSession for the rationale.
        if (fn.name === 'ask_user_question' && askedQuestionThisTurn) {
          output =
            "You already posted a question card to the user earlier in this turn. The second `ask_user_question` call was suppressed so the user only sees one card. END YOUR TURN NOW — the user's answer to the first question will arrive as the next user message; this turn produces no further visible content.";
        } else if (
          (fn.name === 'start_project' || fn.name === 'start_job') &&
          startedProjectOrJobThisTurn
        ) {
          output = `You already called \`${startedProjectOrJobThisTurn.tool}\` earlier in this turn — the kickoff is in flight. Do NOT call \`start_project\` or \`start_job\` again to brainstorm names or scopes; each call creates a real project, voorman, and kickoff task. END YOUR TURN NOW — tell the user one sentence about the project that's spinning up. The voorman picks the work up from here.`;
        } else if (this.deps.bridges.hasTool(fn.name)) {
          try {
            // Adaptive cap — compute how many chars of tool output
            // fit in the remaining context budget. Ollama silently
            // truncates prefixes when prompts overflow num_ctx, so
            // bounding the tool output here prevents a single fat
            // fetch_url / readFile call from eating turns of
            // history. Same helper + ratio the llama-cpp provider
            // uses, so behavior stays aligned across local engines.
            const budgetChars = computeToolBudgetChars(
              this.deps.numCtx,
              this.estimatePromptChars(),
            );
            output = await this.deps.bridges.callTool(fn.name, fn.arguments ?? {}, {
              budgetChars,
              numCtxTokens: this.deps.numCtx,
            });
          } catch (err) {
            output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          }
          if (fn.name === 'ask_user_question' && !output.startsWith('ERROR:')) {
            askedQuestionThisTurn = true;
          }
          if (
            (fn.name === 'start_project' || fn.name === 'start_job') &&
            !output.startsWith('ERROR:')
          ) {
            startedProjectOrJobThisTurn = { tool: fn.name, firstResult: output };
          }
        } else {
          output = `ERROR: tool ${fn.name} is not available`;
        }
        // Auto-continuation hint for truncated write-shaped tool
        // calls. Mirrors MLX + llama-cpp via the shared helper.
        if (truncatedCalls.has(call)) {
          const before = output.length;
          output = appendTruncationHintToToolResult(output, fn.name, fn.arguments ?? {});
          if (output.length !== before) {
            const path = typeof fn.arguments?.path === 'string' ? fn.arguments.path : '(unknown)';
            const bytes =
              typeof fn.arguments?.content === 'string'
                ? (fn.arguments.content as string).length
                : 0;
            log.info(
              `[ollama] auto-continuation hint appended to tool=${fn.name} path=${path} bytes=${bytes}`,
            );
          }
        }
        const tracked = failureTracker.recordResult(fn.name, output);
        const repeated = repeatTracker.recordCall(fn.name, fn.arguments ?? {}, tracked.output);
        this.messages.push({ role: 'tool', content: repeated.output });
        if (tracked.shouldAbort) {
          abortDueToFailureLoop = {
            tool: fn.name,
            count: tracked.count,
            ...(tracked.sourceFailureKind ? { sourceFailureKind: tracked.sourceFailureKind } : {}),
            ...(tracked.transportFailure ? { transportFailure: true } : {}),
          };
          break;
        }
        if (repeated.shouldAbort) {
          throw ToolRepeatTracker.buildAbort({
            providerLabel: 'ollama',
            toolName: fn.name,
            args: fn.arguments ?? {},
            count: repeated.count,
            registeredTools: this.deps.bridges.isEmpty()
              ? []
              : this.deps.bridges.getOpenAITools().map((t) => t.name),
            ...(this.deps.activeCraftbookStep ? { activeStep: this.deps.activeCraftbookStep } : {}),
          });
        }
      }

      if (abortDueToFailureLoop) {
        throw ToolFailureTracker.buildAbort({
          providerLabel: 'ollama',
          toolName: abortDueToFailureLoop.tool,
          count: abortDueToFailureLoop.count,
          ...(abortDueToFailureLoop.sourceFailureKind
            ? { sourceFailureKind: abortDueToFailureLoop.sourceFailureKind }
            : {}),
          ...(abortDueToFailureLoop.transportFailure ? { transportFailure: true } : {}),
        });
      }

      const repeat = detectRepeatCall(callLog);
      if (repeat) {
        throw new Error(buildLoopBailMessage({ reason: 'repeat', repeat, callLog, debugOn }));
      }

      // Terminal: the model posted a question card to the user — end the turn
      // (its answer arrives as the next user message). Without this the loop
      // would issue another generation request and can wedge in-flight; see
      // the llama-cpp provider for the full "stuck session" rationale.
      if (askedQuestionThisTurn) return fullText;
    }

    throw new Error(buildLoopBailMessage({ reason: 'cap', callLog, debugOn }));
  }

  providerState(): ProviderSessionState {
    // Stateless — the full transcript is persisted in ChatSession.messages.
    return {};
  }

  getRegisteredToolNames(): string[] {
    if (this.deps.bridges.isEmpty()) return [];
    return this.deps.bridges.getOpenAITools().map((t) => t.name);
  }

  setSystemMessage(text: string): void {
    // Replace the system message in-place. The constructor always
    // installs a `{role: 'system'}` entry at index 0; the manager
    // calls this right after `createSession` returns, before any
    // user/assistant messages have been appended.
    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: text });
      this.currentTurnStartIdx += 1;
    } else {
      this.messages[0] = { role: 'system', content: text };
    }
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    try {
      await this.deps.bridges.stop();
    } catch {
      /* ignore */
    }
  }
}

interface OllamaChatChunk {
  message?: OllamaMessage;
  done?: boolean;
  /** On the terminal chunk (`done: true`), why Ollama stopped:
   *  `"stop"` = normal end-of-turn / EOS, `"length"` = hit
   *  `num_predict` (the user wanted more tokens), `"load"` /
   *  `"unload"` / `"error"` / etc. for edge cases. */
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Generation-phase duration in nanoseconds (Ollama's native unit). */
  eval_duration?: number;
}

export interface ToolCallEntry {
  name: string;
  argsKey: string;
  argsRaw: unknown;
}

export interface RepeatHit {
  name: string;
  argsKey: string;
  argsRaw: unknown;
  count: number;
}

/**
 * Stringify a call's arguments into a comparison key. V8 preserves
 * insertion order on plain objects, and the same model redrawing the
 * same tool call produces the same key order — good enough for exact
 * repeat detection. Undefined / null collapse to `{}` so calls with no
 * args still compare equal.
 */
export function stableArgsKey(args: unknown): string {
  if (args == null) return '{}';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Fire only when the tail of the call log shows `REPEAT_CALL_BAIL_THRESHOLD`
 * identical `(name, args)` calls **back-to-back**. This is the narrow
 * signature of the "model didn't absorb the tool output and keeps asking"
 * failure — that pattern never has intervening work between the repeats.
 *
 * Cumulative repeats across a whole turn (e.g. read → write → read →
 * advance → read) are fine: the model is re-reading to refresh its view
 * after state changes. A legitimate developer-style exploration pass can
 * easily hit three reads of the same ref spread across a turn without
 * being stuck. The absolute turn cap (`MAX_TOOL_LOOP_TURNS`) is still the
 * backstop for pathological high-fanout behavior.
 */
export function detectRepeatCall(log: ToolCallEntry[]): RepeatHit | null {
  if (log.length < REPEAT_CALL_BAIL_THRESHOLD) return null;
  const tail = log.slice(-REPEAT_CALL_BAIL_THRESHOLD);
  const first = tail[0]!;
  for (let i = 1; i < tail.length; i++) {
    const entry = tail[i]!;
    if (entry.name !== first.name || entry.argsKey !== first.argsKey) return null;
  }
  return {
    name: first.name,
    argsKey: first.argsKey,
    argsRaw: first.argsRaw,
    count: REPEAT_CALL_BAIL_THRESHOLD,
  };
}

/**
 * Compose the user-visible error message shown when we bail out of the
 * tool loop. Always includes per-tool counts so the user sees what the
 * model was doing; debug mode adds the full ordered sequence + first-
 * seen args per tool so the operator can reproduce the pattern.
 */
export function buildLoopBailMessage(opts: {
  reason: 'repeat' | 'cap';
  callLog: ToolCallEntry[];
  debugOn: boolean;
  repeat?: RepeatHit;
}): string {
  const { reason, callLog, debugOn, repeat } = opts;
  const perTool = new Map<string, number>();
  for (const c of callLog) perTool.set(c.name, (perTool.get(c.name) ?? 0) + 1);
  const topCounts = [...perTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');

  const header =
    reason === 'repeat' && repeat
      ? `[ollama] model called \`${repeat.name}\` with the same args ${repeat.count}× in a row; aborting`
      : `[ollama] reached ${MAX_TOOL_LOOP_TURNS} tool-call rounds without a final answer; aborting`;

  const summary =
    callLog.length > 0
      ? ` — ${callLog.length} call${callLog.length === 1 ? '' : 's'} total (${topCounts})`
      : '';

  if (!debugOn) return `${header}${summary}`;

  // Debug: full ordered sequence + the repeated args (if any), clipped
  // so a runaway turn doesn't balloon the message past what fits in the
  // UI banner.
  const MAX_SEQUENCE = 40;
  const MAX_ARGS_CHARS = 200;
  const sequence = callLog
    .slice(0, MAX_SEQUENCE)
    .map((c, i) => {
      const args =
        c.argsKey.length > MAX_ARGS_CHARS ? `${c.argsKey.slice(0, MAX_ARGS_CHARS)}…` : c.argsKey;
      return `  ${i + 1}. ${c.name}(${args})`;
    })
    .join('\n');
  const overflow =
    callLog.length > MAX_SEQUENCE ? `\n  …(${callLog.length - MAX_SEQUENCE} more)` : '';

  return `${header}${summary}\n\nSequence:\n${sequence}${overflow}`;
}

/**
 * Convert the MCP bridge's OpenAI-Responses-shape tools
 * (`{type:'function', name, description, parameters}`) into Ollama's
 * Chat-Completions-shape (`{type:'function', function:{name, description,
 * parameters}}`). Extracted so the session body stays readable.
 */
function toOllamaTools(bridges: McpBridgePool): Array<Record<string, unknown>> {
  return bridges.getOpenAITools().map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Read a Response body as newline-delimited JSON, yielding each parsed
 * object. Ollama's streaming endpoints (`/api/chat`, `/api/pull`) use this
 * format — one JSON doc per line, no framing headers.
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch (err) {
          log.warn('[ollama] skipping malformed NDJSON line:', err);
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}
