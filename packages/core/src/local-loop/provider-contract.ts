/**
 * The provider contract the local turn loop is written against: one chat
 * session's surface, its send options, and the data shapes it reports. The
 * daemon's providers and the portable runtime implement the same contract, so
 * the loop in this folder runs unchanged on both.
 */

import type { FileTurnIntent } from '../schemas/file-turn-intent.js';

export interface QuotaBucket {
  /** Bucket identifier from the provider (e.g. "premium_interactions"). */
  name: string;
  isUnlimited: boolean;
  limit: number;
  used: number;
  remaining: number;
  remainingPercent: number;
  overage: number;
  resetDate?: string;
}

export interface ProviderSessionState {
  copilotSessionId?: string;
  openaiPreviousResponseId?: string;
  claudeCliSessionId?: string;
  codexCliThreadId?: string;
}

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * How many of `inputTokens` were served from the provider's prompt cache.
   * Populated from OpenAI's `usage.input_tokens_details.cached_tokens` and
   * Anthropic's `cache_read_input_tokens`; left undefined for providers
   * that don't surface a breakdown (Copilot, Ollama, llama-cpp). The
   * `inputTokens` field is the total billed input (cached + uncached) so
   * cross-provider sums remain comparable; this field is the breakdown.
   */
  cachedInputTokens?: number;
  /**
   * Engine-reported DECODE throughput for this turn (generated tokens per
   * second of decode time), when the engine surfaces it — MLX reports
   * `generation_tps`, llama-server prints `tg`. Left undefined otherwise.
   *
   * Deliberately not derived from `outputTokens / durationMs`: that whole-turn
   * average folds in prefill, tool round-trips, and idle waiting, so it reads
   * far below the real decode rate and isn't comparable between engines. A
   * missing value must stay missing rather than become a misleading estimate.
   */
  outputTokensPerSec?: number;
  cost?: number;
  durationMs: number;
  /**
   * Provider-reported quota buckets after this turn. Copilot emits one or
   * more (e.g. one per request class — chat, premium interactions, etc.).
   * OpenAI doesn't emit any.
   */
  quotaBuckets?: QuotaBucket[];
  at: string;
  /**
   * Ollama-only: how much of `num_ctx` the prompt consumed this turn.
   * `used` is the provider's `prompt_eval_count` (the actual tokens
   * Ollama saw); `limit` is the session's configured `num_ctx`. When
   * used/limit ≥ 0.95 the chat layer logs a truncation-likely warning
   * and the post-hoc signal feeds back into compaction calibration.
   */
  contextUtilization?: { used: number; limit: number };
}

/**
 * A pasted/uploaded image the user attached to the turn's prompt.
 * `base64` is the bare payload — no `data:` prefix, no whitespace — because
 * every provider shape we target wants the raw bytes encoded differently
 * (OpenAI: data URI, Copilot: attachment blob, Ollama: plain base64 array).
 */
export interface ImageAttachment {
  base64: string;
  mimeType: string;
  filename: string;
}

export interface SendAndWaitOpts {
  /** Structured intent from a caller that knows whether a file exists or failed checks. */
  fileTurnIntent?: FileTurnIntent;
  timeoutMs?: number;
  attachments?: ImageAttachment[];
  /**
   * Continue an externally-owned tool loop from the `tool` entry already at
   * the end of `SessionOpts.priorMessages` without appending another `user`
   * message.
   *
   * This is used by the machine-broker `/v1/remote/infer` boundary: Device A
   * executes the tool, replays the assistant call + tool result to Device B,
   * and asks B for the next forward pass. Appending `{ role: 'user', content:
   * '' }` here makes small models interpret the continuation as a brand-new
   * empty user turn and restart the first instruction (wild-caught: Gemma 4
   * repeatedly called `start_project`, then a developer repeatedly called
   * `write_task_note` instead of moving on to `write_file`).
   *
   * Local providers validate that `prompt` is empty, there are no new
   * attachments, and the seeded transcript ends in a tool result before
   * honoring this flag. Ordinary callers should omit it.
   */
  continueFromToolResult?: boolean;
  /**
   * Request queue coordinates. When set, the session acquires a slot
   * in its provider's {@link ProviderQueue} before any HTTP work,
   * and the per-turn timer starts only after acquisition. Omit in
   * test paths or one-shot flows where queuing isn't desired; the
   * session falls back to firing immediately.
   */
  /**
   * Output-token cap for tool-loop CONTINUATION iterations (iteration
   * index > 0 — the request after tool results, where the model is
   * supposed to wrap up, not re-analyze). The first iteration keeps
   * the catalog `tuning.sampling.maxTokens` so a tool call is never
   * cut off before it starts. Game reaction turns pass a tight value
   * (~300) to bound post-move table talk. Ordinary research and chat
   * replies keep the model's normal output budget.
   */
  continuationMaxTokens?: number;
  queue?: {
    lane: 'interactive' | 'background';
    /**
     * Who is waiting on this turn, for engines that schedule several
     * requests themselves (the MLX sidecar). `interactive`: a person sent it
     * and is watching. `background`: task steps, nudges, chores — work
     * nobody is reading token by token. A running engine wave made only of
     * background work steps aside for a waiting interactive request, and
     * resumes afterwards.
     *
     * Distinct from `lane`, which only orders this process's queue: task
     * step handoffs take the interactive LANE so they are not starved by
     * chores, yet a person typing must still go ahead of them at the
     * engine. Omitted means interactive — the direction that never parks a
     * turn somebody is waiting on.
     */
    enginePriority?: 'interactive' | 'background';
    /**
     * Truly-deferrable housekeeping (nudges, extraction, icon/about
     * generation). On local engine queues with ambient admission
     * control, these dispatch only after a quiet window with no
     * user-facing activity — see `EnqueueRequest.ambient` in
     * core's runtime/provider-queue.ts. Never set on work a foreground turn awaits
     * (compaction) or user-facing background turns (page reactions).
     */
    ambient?: boolean;
    sessionId?: string;
    gezelId?: string;
    /** Project scope for queue UI context; no scheduler semantics. */
    projectId?: string;
    /**
     * Human-readable owner for service work that has no persisted gezel.
     * Display-only; it has no scheduler or prompt-affinity semantics.
     */
    actorLabel?: string;
    /**
     * Short, human-readable label for what this turn is doing —
     * e.g. "atari/3 · plan", "summary", "icon · Maya". Surfaced in
     * the QueueMeter so users can see *why* a gezel is busy. No
     * scheduler semantics.
     */
    job?: string;
    /**
     * Optional waitStarted callback fired when the request begins
     * waiting in the queue (rather than starting immediately), so
     * the caller can emit a `queued` event to the UI. Only invoked
     * if the wait exceeds a short threshold — below that it's noise.
     */
    onQueueWait?: (info: { aheadOf: number }) => void;
    /** Abort signal — removes the entry from the queue if fired while pending. */
    signal?: AbortSignal;
    /**
     * Set `false` to skip affinity scoring for this acquire. The
     * id fields still flow through for UI/debug display, but the
     * scheduler treats the entry as FIFO within its lane.
     */
    affinity?: boolean;
    /**
     * When true, the provider session skips the queue entirely for
     * this send and runs against the engine directly. Used to break
     * the deadlock where a session holding the only queue slot calls
     * `ask_specialist` / `ask_gezel`: the spawned consultation session
     * would normally enqueue behind the asker's still-held slot, hit
     * the MCP tool-call timeout, and surface as `-32001 Request timed
     * out`. ChatManager sets this for sessions detected as the target
     * of an in-flight ask (via `inflightAsks`). Engine-side safety
     * (the wrapped MLX server's per-stream lock, llama.cpp's slot
     * allocator) ensures concurrent requests still serialize where it
     * matters — this flag only bypasses the TS-side FIFO queue.
     */
    bypassQueue?: boolean;
  };
}

export interface LLMSession {
  /** Bound engine capability; absent is unknown, never proof of native vision. */
  readonly supportsImageInput?: boolean;
  /** The owning engine was retired; rebuild from saved history before the next turn. */
  readonly isDisposed?: boolean;
  /**
   * Effective context window for this concrete session, after any native
   * engine admission clamp. Stateless/local-history providers expose this so
   * ChatManager can run the same proactive pressure checks regardless of
   * whether inference is in-process or routed through a machine broker.
   */
  readonly numCtx?: number;
  /** Model actually used by this session (diagnostics + pressure warnings). */
  readonly model?: string;
  /**
   * Set when the provider itself cut the last `sendAndWait` short:
   * `'immediate-write'` means the write clamp closed the turn the moment the
   * requested file landed, before the model could do anything else. `null`
   * or absent means the model ended the turn. A task handoff reads it to
   * send one continuation instead of leaving an active step to the stall
   * sweep.
   */
  readonly lastTurnBail?: 'immediate-write' | null;
  /**
   * Cheap estimate of the complete prompt currently held by this session,
   * including system bands, prior messages, and tool schemas.
   */
  estimatePromptChars?(): number;
  /**
   * The exact transcript this session would send after its system bands,
   * verbatim — real tool arguments, untruncated tool results, mid-turn steers.
   * Seeding a new session's `priorMessages` with it reproduces the same
   * prompt tokens, which is what lets an engine's persisted KV cache be
   * reused after a restart; the rebuild from saved history cannot do that,
   * because it dedupes, budgets, and labels tool results by design.
   * `undefined` when the transcript cannot round-trip (images, mid-transcript
   * system messages).
   */
  getWireTranscript?(): WireTranscriptEntry[] | undefined;
  /**
   * Best-effort prompt-cache prefill for the session's current exact prompt.
   * Remote sessions use this to send their A-owned prompt/transcript/tool
   * surface to B's inference-only warm endpoint. Implementations must not
   * mutate the conversation transcript.
   */
  prewarm?(sessionId: string): Promise<void>;
  /**
   * Native prefill primitive used by the broker after it receives a prepared
   * remote warm payload. `sessionId` is already tenant-namespaced by B.
   */
  prefillOnly?(opts?: { timeoutMs?: number; sessionId?: string }): Promise<void>;
  /**
   * Send a user prompt, stream deltas via onDelta subscribers, resolve with
   * the full text response. Implementations should tolerate the SDK's
   * idle-timeout quirks and fall back to accumulated deltas when possible.
   *
   * `attachments` carries pasted images for multimodal models. Providers
   * that don't support vision (or whose currently-active model doesn't)
   * silently drop the attachments and proceed text-only.
   */
  sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string>;
  onDelta(handler: (chunk: string) => void): () => void;
  /**
   * Subscribe to live private-reasoning deltas, streamed separately from
   * the visible reply so they never enter the committed body. API-compat
   * forwarders omit this private channel unless their client contract opts
   * in explicitly. Optional — only providers with a distinct reasoning
   * channel (llama-cpp/ds4) fire it.
   */
  onReasoningDelta?(handler: (chunk: string) => void): () => void;
  onUsage(handler: (usage: TurnUsage) => void): () => void;
  /**
   * Optional: subscribe to "wire pulse" notifications. Currently
   * only `OllamaSession` emits these — bare framing chunks that
   * arrive on the wire without visible content. Lets the chat
   * layer surface "the provider is alive but the model isn't
   * producing visible output" as accumulating dots in the
   * streaming bubble. Implementations that don't have a notion of
   * this (Copilot SDK, OpenAI Responses API) can leave it
   * undefined.
   */
  onWirePulse?(handler: () => void): () => void;
  /**
   * Optional: subscribe to live tool-argument chunks — the raw argument
   * text streamed while the model builds a structured tool call
   * (llama-cpp/MLX `delta.tool_calls[].function.arguments` fragments).
   * A multi-minute structured `write_file` emits no visible deltas, so
   * this is the only channel that can show the user *what* is being
   * generated during that stretch. Display-only. Providers whose tool
   * calls arrive whole (Ollama) or run server-side (Copilot, OpenAI)
   * leave it undefined.
   */
  onToolArgsDelta?(
    handler: (name: string, chunk: string, meta?: ToolArgsDeltaMeta) => void,
  ): () => void;
  /**
   * Optional: subscribe to phase-announcement events. Currently only
   * `CopilotSession` emits these (SDK `assistant.intent` events from
   * the model's `report_intent` built-in tool). Providers without this
   * concept leave it undefined.
   */
  onIntent?(handler: (label: string) => void): () => void;
  /**
   * Optional: subscribe to "still working" heartbeats. Providers that
   * know they're mid-work without producing visible deltas fire these so
   * the chat UI can name the current operation and does not let its
   * "silent for Xs" banner climb during legitimate reasoning/tool phases.
   * Providers without a comparable signal can leave this undefined.
   */
  onHeartbeat?(handler: (label: string | undefined) => void): () => void;
  /**
   * Optional: subscribe to provider-side warnings (rate-limits, degraded
   * mode, context pressure) so the UI can surface them inline on the
   * streaming bubble instead of leaving them buried in server logs.
   */
  onWarning?(handler: (message: string) => void): () => void;
  /** Snapshot of provider-specific state for persistence (called after each turn). */
  providerState(): ProviderSessionState;
  disconnect(): Promise<void>;
  /**
   * Names of MCP tools currently registered on this session's bridge.
   * Empty when the session was built without an MCP bridge (Copilot's
   * SDK manages tools internally; sessions whose mcp subprocess
   * failed to start). Used by the debug-bundle endpoint to
   * distinguish "salvage couldn't fire because no tools were known"
   * from "salvage didn't match" during prompt-debugging
   * investigations. Optional — providers that genuinely have no
   * concept of MCP-bridge tool names can leave this undefined.
   */
  getRegisteredToolNames?(): string[];
  /**
   * The tool calls the model emitted on the most recent `sendAndWait`
   * (or empty when none). Populated by providers in
   * "external tools" mode — see {@link SessionOpts.externalTools}.
   *
   * When the model invokes external tools, `sendAndWait` returns the
   * empty string (or any accumulated assistant text up to the tool
   * call) and the caller reads from here. The caller is responsible
   * for executing the calls and feeding the results back via a new
   * session, with `priorMessages` carrying the assistant turn (with
   * `toolCalls`) and the subsequent `tool` turns (with `toolCallId`).
   *
   * Optional because providers that don't implement external tool
   * calling never populate it; the route checks for the method's
   * existence before reading.
   */
  capturedToolCalls?(): ExternalToolCall[];
  /**
   * Replace the system message captured at session-creation time.
   * Used by the manager to refresh the auto-injected `## Tools
   * available this turn` block after the bridge has actually
   * spawned, so the model sees only tools that registered
   * successfully. Without this, a third-party MCP server that
   * silently failed to spawn (e.g. `@playwright/mcp` when Chromium
   * isn't installed) would still appear in the prompt's tools
   * listing — the model fabricates calls to its tools, and the
   * salvage layer correctly refuses to promote them.
   *
   * Optional — providers without a notion of a mutable system
   * message (those that bake the prompt into provider-side state at
   * session creation) leave it undefined; the manager skips the
   * refresh for them.
   */
  setSystemMessage?(text: string): void;
  /**
   * Captured chain-of-thought from the most recent `sendAndWait`. Set
   * by local providers (ollama, llama-cpp, mlx, ds4) when the model wraps
   * deliberation in `<think>…</think>` / `<reasoning>…</reasoning>`
   * tags — see `extractReasoning` — and by cloud providers that stream
   * a reasoning trace (Copilot's `assistant.reasoning_delta`,
   * Anthropic's `thinking_delta`). Aggregated across every iteration
   * of a multi-tool-call turn so one getter call returns the whole
   * trace. ChatManager reads it after `sendAndWait` resolves and
   * stashes it on `ChatMessage.reasoning` so the chat bubble can
   * render it behind a collapsed "Thinking" expander instead of the
   * old behavior of stripping it entirely.
   *
   * Returns `undefined` (not '') when the most recent turn captured
   * nothing, so the manager can skip writing the field. Reset per
   * turn at the top of `sendAndWait`. OpenAI Responses hides
   * reasoning server-side and leaves this undefined.
   */
  getLastTurnReasoning?(): string | undefined;
  /**
   * Length, in characters, of the reasoning trace accumulated SO FAR in
   * the current turn — i.e. what `getLastTurnReasoning()` would return
   * if the turn ended at this instant. Read by ChatManager at the moment
   * a tool call fires, and stamped on the persisted
   * `ChatMessageToolCall.afterReasoningChars` so the chat bubble can
   * splice a marker into the trace at the point the model stopped
   * deliberating and acted.
   *
   * Implement it against the same field `getLastTurnReasoning` returns.
   * Counting `onReasoningDelta` chunks in the manager instead would
   * index into a different string for every provider that builds its
   * trace by extracting `<think>` blocks per tool-loop iteration.
   *
   * Optional: a provider that doesn't implement it simply leaves the
   * offset off the persisted call, and the bubble renders the trace
   * without markers.
   */
  getCurrentTurnReasoningLength?(): number;
  /**
   * Tool-call bodies the salvage layer couldn't parse on the most
   * recent turn. Populated when `MAX_MALFORMED_RETRIES` was exhausted
   * — the runtime gave up trying to repair them and the model never
   * landed a real call. Returned in source-emit order, capped per
   * body so a runaway fabrication doesn't pollute the session file.
   *
   * Used by ChatManager to stash on `ChatMessage.attemptedToolCalls`
   * for the debug bundle. Returns `undefined` when nothing failed in
   * a way that exhausted retries (the common case). Cloud providers
   * whose tool-calls go through SDK channels (Copilot, OpenAI) leave
   * this unset.
   */
  getLastTurnAttemptedToolCalls?(): Array<{ body: string; reason?: string }> | undefined;
}

/**
 * One caller-defined tool description. Mirrors the OpenAI Chat
 * Completions `tools[].function` object: a name, optional description,
 * and a JSON Schema for the arguments.
 */
export interface ExternalToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * One captured tool invocation, in OpenAI's `tool_calls` shape.
 * `arguments` is the raw JSON string the model emitted — the route
 * (and ultimately the caller's app) is responsible for parsing it.
 */
export interface ExternalToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * One message of a stateless session's live transcript — everything after its
 * system bands — in exactly the shape `SessionOpts.priorMessages` takes back.
 * See {@link LLMSession.getWireTranscript}.
 */
export type WireTranscriptEntry =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

/** Identity attached to a live structured tool-argument fragment. */
export interface ToolArgsDeltaMeta {
  /** OpenAI-compatible position within the assistant's tool_calls array. */
  index?: number;
  /** Provider-supplied call id, normally present on the first fragment. */
  id?: string;
}

/** A mid-turn compaction hook: the host rewrites older history into a synthetic summary. */
export type CompactionRequester = (params: {
  /** Messages BEFORE the current turn's user message. Excludes the system prompt. */
  priorMessages: Array<{ role: string; content: string }>;
  /** Snapshot of the pressure that triggered the request — for telemetry only. */
  estimatedTokens: number;
  numCtx: number;
}) => Promise<{ syntheticContent: string } | null>;

/**
 * Local bridge-backed providers: a successful call to one of these action
 * tools is the terminal outcome for the turn (see SessionOpts.terminalToolPolicy).
 */
export interface TerminalToolPolicy {
  toolNames: string[];
  closingArg?: string;
  fallbackText: string;
  maxClosingChars?: number;
  /**
   * Only a call whose `arg` equals `value` is terminal. An artifact
   * checkpoint step advances on ONE file, but its procedure may write
   * others first: treating the first `write_artifact` as terminal ended
   * the turn on `scope.md`, the recovery restarted the procedure from
   * the top, and whether `billables.json` ever got written came down to
   * luck (invoice-run on gemma4-12b-q4, 2026-09-19).
   */
  onlyWhenArgEquals?: { arg: string; value: string };
}

/** The active craftbook step, as the local loop's anti-spin guidance reads it. */
export interface ActiveCraftbookStep {
  name: string;
  onExitScriptName?: string;
  /** Exact deliverable path, used to constrain code-block salvage. */
  deliverableFile?: string;
  /**
   * True when {@link deliverableFile} lives in the artifacts drawer
   * rather than the workspace (`advanceWhen.artifact`). The ramble
   * corrective needs it to name the right writer — a review step on a
   * writes-off project must be pointed at `write_artifact`, not
   * warned off it.
   */
  deliverableIsArtifact?: boolean;
  /**
   * The step's declared inputs (`consumes`). A local provider holds its
   * write-only immediate-write mode until each has been read in the send,
   * so a step that writes FROM an outline can open the outline first.
   */
  requiredInputs?: ReadonlyArray<{ path: string; artifact: boolean }>;
  /**
   * Workspace `advanceWhen.file` steps only: true when {@link deliverableFile}
   * on disk passes the same check the end-of-turn auto-advance applies, for
   * the step that is still active and owned by this session's gezel.
   * `writtenThisTurn` stands in for the turn's drained writes so a
   * `requireChange` step agrees with the end-of-turn verdict.
   *
   * The local loop reads it mid-turn: `advanceWhen` is otherwise judged
   * only when the turn ends, and a turn that never ends on its own runs to
   * the 96-iteration cap. See `DeliverableReadySteer`.
   */
  deliverableReady?: (ctx: { writtenThisTurn: boolean }) => Promise<boolean>;
}
