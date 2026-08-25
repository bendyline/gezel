/**
 * MockProvider — a deterministic LLMProvider for tests and CI. Implements the
 * full LLMProvider / LLMSession contract with no external dependencies. Used
 * anywhere we need to exercise chat flow without real credentials.
 *
 * Usage patterns:
 *   const mock = new MockProvider();
 *   mock.script('Hello from mock');           // next turn replies with this
 *   mock.scriptResumeFailure();               // next resume throws SessionResumeError
 *   const mgr = new ChatManager({ ..., providers: [['copilot', mock]] });
 */
import { randomUUID } from 'node:crypto';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { ProviderQueue } from './queue.js';
import {
  type EnginePhaseEvent,
  StreamingSessionBase,
  type TurnStatsEvent,
} from './streaming-session.js';
import {
  type ExternalToolCall,
  type LLMProvider,
  type LLMSession,
  type ModelInfo,
  type ProviderSessionState,
  type SendAndWaitOpts,
  type SessionOpts,
  SessionResumeError,
} from './types.js';
import { buildTurnUsage } from './usage-builder.js';

/** Scripted tool invocation: executed through the MCP bridge on the next turn. */
export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

type Named = 'copilot' | 'openai' | 'ollama' | 'llama-cpp' | 'mlx' | 'ds4';

export interface MockCall {
  kind: 'create' | 'resume' | 'send' | 'disconnect';
  sessionId?: string;
  prompt?: string;
  opts?: SessionOpts;
  sendOpts?: SendAndWaitOpts;
}

export class MockProvider implements LLMProvider {
  readonly name: Named;
  readonly calls: MockCall[] = [];
  readonly sessions: MockSession[] = [];
  /** Tool-call outputs recorded from scripted invocations — for test assertions. */
  readonly toolCallOutputs: Array<{ name: string; output: string }> = [];
  /**
   * Real {@link ProviderQueue} so tests that read `provider.queue.snapshot()`
   * (e.g. the voorman-idle continuation-suppression path) see a well-formed
   * object. The MockProvider's own `sendAndWait` doesn't actually flow
   * through this queue — sessions ignore it — so tests can hold an
   * acquired slot to simulate "other work is queued" without accidentally
   * blocking the scripted response path.
   */
  readonly queue: ProviderQueue = new ProviderQueue({ concurrency: 1 });
  /** MockProvider implements `SessionOpts.externalTools` for tests. */
  readonly supportsExternalTools = true;
  /** Sessions record `opts.priorMessages` for assertions, so the mock
   *  counts as honoring explicit history — /v1 passes it through
   *  rather than flattening. */
  readonly supportsPriorMessages = true;
  /**
   * When set, every {@link MockSession} this provider hands out
   * exposes `numCtx` + `estimatePromptChars()` matching this config
   * — used by tests that exercise the Ollama-only context-pressure
   * path through MockProvider. The `promptChars` callback is read
   * fresh each `checkContextPressure` call so a test can ramp the
   * estimate up across multiple turns to drive the warning →
   * compaction transition.
   */
  ollamaContextConfig?: { numCtx: number; promptChars: () => number };
  private readonly responseQueue: string[] = [];
  /** Private-reasoning chunks to emit before the next scripted reply. */
  private readonly reasoningQueue: string[][] = [];
  private readonly engineTelemetryQueue: Array<{
    phases: EnginePhaseEvent[];
    turnStats?: TurnStatsEvent;
  }> = [];
  private readonly toolCallQueue: ScriptedToolCall[][] = [];
  private resumeFailureQueued = false;
  /** Error message to throw from the next `sendAndWait`, if any. */
  private readonly sendFailureQueue: Array<{
    message: string;
    fields?: Record<string, unknown>;
  }> = [];
  /** Errors thrown after scripted MCP calls complete on a send. */
  private readonly postToolSendFailureQueue: Array<{
    message: string;
    fields?: Record<string, unknown>;
  }> = [];
  /** Per-send deliberate delays for deterministic SessionQueue tests. */
  private readonly sendDelayQueue: number[] = [];
  /**
   * Per-send "stream this text, then hang until aborted" scripts. Lets a
   * test drive the real mid-turn cancellation path: the session emits the
   * content as a delta (so the manager's per-turn content buffer fills),
   * then blocks until the caller's abort signal fires and rejects — the
   * shape a real provider unwinds with on `cancelInflight`.
   */
  private readonly streamThenHangQueue: string[] = [];
  /** See {@link scriptStreamThenStall}. */
  private readonly streamThenStallQueue: Array<{ content: string; gate: Promise<void> }> = [];
  /**
   * Scripted external tool-call payloads. Each entry is the array a
   * single `sendAndWait` should emit (and halt on) when the session's
   * opts include `externalTools`. Pop one per matching turn; fall
   * through to the normal scripted response when empty.
   */
  private readonly externalToolCallQueue: ExternalToolCall[][] = [];
  /** Live argument fragments paired with the next scripted external call. */
  private readonly externalToolCallDeltaQueue: Array<Array<{ name: string; chunk: string }>> = [];
  /**
   * When set, the next {@link createSession} blocks — after recording its
   * call — until the promise resolves. Lets a test park a turn inside
   * `ensureState` (the `inflight` slot is already grabbed, but the
   * per-turn AbortController isn't wired yet) so a `cancelInflight` can
   * land in that setup window deterministically.
   */
  private createSessionGate: Promise<void> | null = null;
  private nextSessionCounter = 1;

  constructor(opts: { name?: Named } = {}) {
    this.name = opts.name ?? 'copilot';
  }

  getContextWindow(): number | undefined {
    return this.ollamaContextConfig?.numCtx;
  }

  async initialize(): Promise<void> {
    /* no-op */
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions) await s.forceDisconnect();
    this.sessions.length = 0;
  }

  /**
   * Queue one or more specific responses for the next `sendAndWait`
   * calls. Multi-arg form is convenient when a test needs to script a
   * primary chat reply *and* the placeholder the memory extractor will
   * consume right after — both in one line.
   */
  script(...responses: string[]): void {
    for (const r of responses) this.responseQueue.push(r);
  }

  /**
   * Queue private-reasoning chunks for the next turn. Keeping chunks
   * separate lets ChatManager tests exercise the same timing path as
   * token-streaming providers.
   */
  scriptReasoning(...chunks: string[]): void {
    this.reasoningQueue.push(chunks);
  }

  /** Queue local-engine telemetry for the next ordinary scripted response. */
  scriptEngineTelemetry(telemetry: {
    phases?: EnginePhaseEvent[];
    turnStats?: TurnStatsEvent;
  }): void {
    this.engineTelemetryQueue.push({
      phases: telemetry.phases ?? [],
      ...(telemetry.turnStats ? { turnStats: telemetry.turnStats } : {}),
    });
  }

  /** @internal */
  nextScriptedEngineTelemetry():
    | { phases: EnginePhaseEvent[]; turnStats?: TurnStatsEvent }
    | undefined {
    return this.engineTelemetryQueue.shift();
  }

  /** @internal */
  nextScriptedReasoning(): string[] {
    return this.reasoningQueue.shift() ?? [];
  }

  /**
   * Queue tool calls to be executed (via the MCP bridge) on the next turn,
   * BEFORE the scripted response is emitted. Each call becomes one
   * `bridge.callTool(...)` invocation; outputs are recorded on
   * `toolCallOutputs` so tests can assert on them.
   */
  scriptToolCalls(calls: ScriptedToolCall[]): void {
    this.toolCallQueue.push(calls);
  }

  /** Make the next `resumeSession` call throw `SessionResumeError`. */
  scriptResumeFailure(): void {
    this.resumeFailureQueued = true;
  }

  /**
   * Make the next `sendAndWait` call throw — used to simulate a provider
   * silently GC'ing the server-side session mid-conversation.
   *
   * `fields` are assigned onto the thrown Error, so a test can reproduce a
   * structured provider error (`code`, `engine`, `incidentId`, `panicKind`,
   * …) without importing a real provider's error class.
   */
  scriptSendFailure(
    message = 'Session not found: mock-session-1',
    fields?: Record<string, unknown>,
  ): void {
    this.sendFailureQueue.push({ message, ...(fields ? { fields } : {}) });
  }

  /**
   * Make the next `sendAndWait` fail after its scripted MCP calls finish.
   * This reproduces a provider/tool-loop guard abort that follows a durable
   * mutation, rather than a transport failure before the turn does work.
   */
  scriptSendFailureAfterToolCalls(
    message = '[mock] turn aborted after tool calls',
    fields?: Record<string, unknown>,
  ): void {
    this.postToolSendFailureQueue.push({ message, ...(fields ? { fields } : {}) });
  }

  /**
   * Delay the next `sendAndWait` call by `ms` before emitting its
   * scripted response. Used by SessionQueue tests to prove that a
   * queued message waits for the current turn, not just for the
   * microtask loop to settle.
   */
  scriptSendDelay(ms: number): void {
    this.sendDelayQueue.push(ms);
  }

  /**
   * Make the next `sendAndWait` stream `content` as a delta and then hang
   * until its abort signal fires (rejecting like a real provider aborted
   * by `cancelInflight`). Used to prove the manager salvages the streamed
   * text onto the `turn-aborted` message instead of persisting an empty
   * bubble.
   */
  scriptStreamThenHang(content: string): void {
    this.streamThenHangQueue.push(content);
  }

  /** @internal */
  nextStreamThenHang(): string | undefined {
    return this.streamThenHangQueue.shift();
  }

  /**
   * Make the next `sendAndWait` stream `content` and then **ignore its
   * abort signal**, settling only when the returned `release` fires.
   *
   * Models a provider whose in-flight call outlives a cancel — which is
   * what the Copilot SDK did before `session.abort()` was wired: a
   * cancelled turn kept generating for seconds while the manager had
   * already freed the session slot and started the next turn. Tests use
   * it to drive two overlapping turns deterministically.
   */
  scriptStreamThenStall(content: string): { release: () => void } {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.streamThenStallQueue.push({ content, gate });
    return { release };
  }

  /** @internal */
  nextStreamThenStall(): { content: string; gate: Promise<void> } | undefined {
    return this.streamThenStallQueue.shift();
  }

  /**
   * Make the next `createSession` block (after recording its call) until
   * the returned `release` fires. Holds a turn inside `ensureState`,
   * before the manager wires its per-turn AbortController, so a test can
   * exercise the cancel-before-wiring path.
   */
  gateNextCreateSession(): { release: () => void } {
    let release = (): void => {};
    this.createSessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release };
  }

  /**
   * Script the external tool calls the next `sendAndWait` should emit
   * — used by `/v1/chat/completions` integration tests to drive the
   * tool-calling round-trip without a real model. Passing `[]` makes
   * the session emit no calls and fall through to the normal scripted
   * response (i.e. a tool-result follow-up that just produces text).
   *
   * Only fires when the session opts include `externalTools`; on a
   * non-tool-calling session the scripted entry is left in the queue
   * for the next external-tools session.
   */
  scriptExternalToolCalls(calls: ExternalToolCall[]): void {
    this.externalToolCallQueue.push(calls);
  }

  /**
   * Script the live argument fragments emitted before the next external tool
   * call completes. This mirrors llama-cpp/MLX `delta.tool_calls` streaming
   * and lets HTTP compatibility tests cover their progressive tool UI.
   */
  scriptExternalToolCallDeltas(chunks: Array<{ name: string; chunk: string }>): void {
    this.externalToolCallDeltaQueue.push(chunks);
  }

  /** @internal */
  nextScriptedExternalToolCalls(): ExternalToolCall[] | undefined {
    return this.externalToolCallQueue.shift();
  }

  /** @internal */
  nextScriptedExternalToolCallDeltas(): Array<{ name: string; chunk: string }> {
    return this.externalToolCallDeltaQueue.shift() ?? [];
  }

  /** @internal */
  nextScriptedSendFailure(): { message: string; fields?: Record<string, unknown> } | undefined {
    return this.sendFailureQueue.shift();
  }

  /** @internal */
  nextPostToolSendFailure(): { message: string; fields?: Record<string, unknown> } | undefined {
    return this.postToolSendFailureQueue.shift();
  }

  /** @internal */
  nextScriptedSendDelay(): number {
    return this.sendDelayQueue.shift() ?? 0;
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    this.calls.push({ kind: 'create', opts });
    const gate = this.createSessionGate;
    if (gate) {
      this.createSessionGate = null;
      await gate;
    }
    const sessionId = opts.openaiPreviousResponseId ?? `mock-session-${this.nextSessionCounter++}`;
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[mock]');
    const session = new MockSession(this, sessionId, opts, bridges);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId: string, opts: SessionOpts): Promise<LLMSession> {
    this.calls.push({ kind: 'resume', sessionId, opts });
    if (this.resumeFailureQueued) {
      this.resumeFailureQueued = false;
      throw new SessionResumeError(`[mock] resume of ${sessionId} scripted to fail`);
    }
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[mock]');
    const session = new MockSession(this, sessionId, opts, bridges);
    this.sessions.push(session);
    return session;
  }

  /** @internal */
  nextScriptedToolCalls(): ScriptedToolCall[] {
    return this.toolCallQueue.shift() ?? [];
  }

  /** @internal */
  recordToolOutput(name: string, output: string): void {
    this.toolCallOutputs.push({ name, output });
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'mock-fast', name: 'Mock Fast' },
      {
        id: 'mock-reasoning',
        name: 'Mock Reasoning',
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ];
  }

  /**
   * Deterministic mock embedding so route tests can assert exact
   * payloads without scripting. Vector length is fixed at 8 and each
   * dimension is a small float derived from a stable hash of the input
   * — same input → same vector across runs.
   */
  async createEmbedding(
    input: import('./types.js').EmbeddingInput,
  ): Promise<import('./types.js').EmbeddingResult> {
    const inputs = Array.isArray(input.input) ? input.input : [input.input];
    const vectors = inputs.map((text) => mockEmbedding(text));
    return {
      vectors,
      model: input.model ?? 'mock-embedding',
      usage: { inputTokens: inputs.reduce((n, s) => n + s.length, 0) },
    };
  }

  /** @internal */
  nextScriptedResponse(prompt: string): string {
    const queued = this.responseQueue.shift();
    return queued ?? `Mock reply: ${prompt}`;
  }

  /** @internal */
  recordCall(call: MockCall): void {
    this.calls.push(call);
  }
}

class MockSession extends StreamingSessionBase implements LLMSession {
  private disconnected = false;
  private lastTurnReasoning: string | undefined;
  /**
   * Mirrors the surface real `OllamaSession` exposes, so tests for
   * the context-pressure check (`ChatManager.checkContextPressure`)
   * can drive the Ollama-only branch through MockProvider. Set via
   * `MockProvider.configureOllamaContext({ numCtx, promptChars })`;
   * leaving them undefined keeps MockSession indistinguishable from
   * the Copilot/OpenAI path.
   */
  readonly numCtx?: number;
  private readonly _promptCharsFn?: () => number;

  constructor(
    private readonly provider: MockProvider,
    private readonly sessionId: string,
    private readonly opts: SessionOpts,
    private readonly bridges: McpBridgePool,
  ) {
    super();
    const cfg = provider.ollamaContextConfig;
    if (cfg) {
      this.numCtx = cfg.numCtx;
      this._promptCharsFn = cfg.promptChars;
    }
  }

  /** External tool calls captured on the most recent `sendAndWait`. */
  private _capturedExternalCalls: ExternalToolCall[] = [];

  estimatePromptChars(): number {
    return this._promptCharsFn ? this._promptCharsFn() : 0;
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this._capturedExternalCalls];
  }

  async sendAndWait(prompt: string, sendOpts?: SendAndWaitOpts): Promise<string> {
    if (this.disconnected) throw new Error('[mock] session already disconnected');
    this.provider.recordCall({ kind: 'send', sessionId: this.sessionId, prompt, sendOpts });

    // Reset captured calls — each turn surfaces only its own emissions.
    this._capturedExternalCalls = [];
    this.lastTurnReasoning = undefined;

    const scriptedFailure = this.provider.nextScriptedSendFailure();
    if (scriptedFailure) {
      throw Object.assign(new Error(scriptedFailure.message), scriptedFailure.fields ?? {});
    }

    const streamThenHang = this.provider.nextStreamThenHang();
    if (streamThenHang !== undefined) {
      if (streamThenHang.length > 0) this.emitDelta(streamThenHang);
      const signal = sendOpts?.queue?.signal;
      await new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new Error('[mock] turn cancelled by caller'));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
    }

    const stall = this.provider.nextStreamThenStall();
    if (stall) {
      if (stall.content.length > 0) this.emitDelta(stall.content);
      // Deliberately not linked to `sendOpts.queue.signal` — the point is
      // to outlive the cancel.
      await stall.gate;
      return stall.content;
    }

    const delay = this.provider.nextScriptedSendDelay();
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    const reasoningChunks = this.provider.nextScriptedReasoning();
    if (reasoningChunks.length > 0) {
      this.lastTurnReasoning = reasoningChunks.join('');
      for (const chunk of reasoningChunks) this.emitReasoningDelta(chunk);
    }

    // External tools mode: when the session was created with
    // `externalTools`, the next sendAndWait may "emit" a scripted set
    // of captured tool calls and halt instead of producing text. This
    // mirrors what a real model would do — the route catches the
    // captured calls and returns them to the caller.
    if (this.opts.externalTools && this.opts.externalTools.length > 0) {
      const scriptedExternal = this.provider.nextScriptedExternalToolCalls();
      if (scriptedExternal && scriptedExternal.length > 0) {
        for (const { name, chunk } of this.provider.nextScriptedExternalToolCallDeltas()) {
          this.emitToolArgsDelta(name, chunk);
        }
        this._capturedExternalCalls = scriptedExternal;
        // Emit a single empty "delta" so streaming consumers see at
        // least one event, then return empty content — the route
        // reads capturedToolCalls() to build the OpenAI envelope.
        this.emitDelta('');
        this.emitUsage(
          buildTurnUsage({
            model: this.opts.model ?? 'mock-fast',
            inputTokens: prompt.length,
            outputTokens: 0,
            durationMs: 1,
          }),
        );
        return '';
      }
    }

    // Run any scripted tool calls against the MCP bridge before the reply.
    const toolCalls = this.provider.nextScriptedToolCalls();
    if (toolCalls.length > 0) {
      if (this.bridges.isEmpty()) {
        throw new Error('[mock] tool calls scripted but session has no MCP bridge');
      }
      for (const call of toolCalls) {
        const output = await this.bridges.callTool(call.name, call.arguments);
        this.provider.recordToolOutput(call.name, output);
      }
    }

    const postToolFailure = this.provider.nextPostToolSendFailure();
    if (postToolFailure) {
      throw Object.assign(new Error(postToolFailure.message), postToolFailure.fields ?? {});
    }

    const text = this.provider.nextScriptedResponse(prompt);
    const engineTelemetry = this.provider.nextScriptedEngineTelemetry();
    for (const phase of engineTelemetry?.phases ?? []) this.emitEnginePhase(phase);
    // Emit 2-3 deltas so streaming tests see activity.
    const mid = Math.floor(text.length / 2);
    const parts = text.length > 1 ? [text.slice(0, mid), text.slice(mid)] : [text];
    for (const part of parts) {
      this.emitDelta(part);
    }
    this.emitUsage(
      buildTurnUsage({
        model: this.opts.model ?? 'mock-fast',
        inputTokens: prompt.length,
        outputTokens: text.length,
        durationMs: 1,
      }),
    );
    if (engineTelemetry?.turnStats) this.emitTurnStats(engineTelemetry.turnStats);
    return text;
  }

  providerState(): ProviderSessionState {
    if (this.provider.name === 'openai') {
      return { openaiPreviousResponseId: this.sessionId };
    }
    return { copilotSessionId: this.sessionId };
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning;
  }

  getRegisteredToolNames(): string[] {
    if (this.bridges.isEmpty()) return [];
    return this.bridges.getOpenAITools().map((t) => t.name);
  }

  setSystemMessage(text: string): void {
    this.opts.systemMessage = text;
    this.bridges.seedWrappersFromText(text);
  }

  async disconnect(): Promise<void> {
    this.provider.recordCall({ kind: 'disconnect', sessionId: this.sessionId });
    this.disconnected = true;
    this.clearHandlers();
    try {
      await this.bridges.stop();
    } catch {
      /* ignore */
    }
  }

  /** @internal for provider shutdown */
  async forceDisconnect(): Promise<void> {
    this.disconnected = true;
    try {
      await this.bridges.stop();
    } catch {
      /* ignore */
    }
  }
}

/** Convenience: returns a random id so tests can assert unique values. */
export function randomMockSessionId(): string {
  return `mock-${randomUUID().slice(0, 8)}`;
}

/**
 * Deterministic 8-dim mock embedding. Each dimension is derived from
 * a rolling 32-bit FNV-style hash of `text` seeded with the dimension
 * index. Same input → same vector across processes / runs — what the
 * `/v1/embeddings` route tests rely on for assertions.
 */
function mockEmbedding(text: string): number[] {
  const dims = 8;
  const out: number[] = new Array(dims).fill(0);
  for (let d = 0; d < dims; d++) {
    let h = 2166136261 ^ d;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    // Reduce to [-1, 1]. The `>>> 0` normalizes to unsigned first.
    out[d] = ((h >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}
