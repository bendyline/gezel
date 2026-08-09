import type { TurnUsage } from './types.js';

/**
 * Phase payload for {@link StreamingSessionBase.emitEnginePhase}.
 * Providers declare which phase strings they fire — llama-cpp and MLX
 * share `starting / loading_model / prefill / generating / ready`.
 * `provider` is required so downstream fan-out (chat manager → SSE)
 * doesn't have to guess which local engine produced the phase.
 */
export interface EnginePhaseEvent {
  provider: 'llama-cpp' | 'mlx' | 'ds4';
  phase: string;
  detail?: string;
  progress?: number;
  /** Time from request dispatch to the first model-produced token/fragment. */
  ttftMs?: number;
}

/**
 * Per-turn telemetry for local providers (llama-cpp + Ollama).
 * See `turn_stats` in `ChatEventSchema` for rationale. Session-level
 * emit; `ChatManager` forwards to the session's event scope.
 */
export interface TurnStatsEvent {
  provider: 'llama-cpp' | 'ollama' | 'mlx' | 'ds4';
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** Time from request dispatch until the first model-produced stream fragment. */
  ttftMs?: number;
  /** Engine-reported prompt-evaluation throughput, excluding cache hits when available. */
  promptTokensPerSec?: number;
  /** Prompt tokens served from the engine's KV/prompt cache. */
  cachedPromptTokens?: number;
  /** Engine-reported decode throughput; wall-clock estimate only as a fallback. */
  tokensPerSec?: number;
}

/**
 * Static engine metrics (RAM footprint) for local-supervised engines.
 * Fired once after the model is loaded and ready to serve: llama-cpp
 * reads this from its GGUF loader's allocation summary, MLX from the
 * mlx_lm.server child process's resident-set size since its logs
 * don't report per-buffer allocation.
 */
export interface EngineStatsEvent {
  provider: 'llama-cpp' | 'mlx' | 'ds4';
  ramAllocBytes: number;
}

export abstract class StreamingSessionBase {
  private readonly deltaHandlers = new Set<(chunk: string) => void>();
  private readonly reasoningDeltaHandlers = new Set<(chunk: string) => void>();
  private readonly usageHandlers = new Set<(usage: TurnUsage) => void>();
  private readonly wirePulseHandlers = new Set<() => void>();
  private readonly toolArgsDeltaHandlers = new Set<(name: string, chunk: string) => void>();
  private readonly intentHandlers = new Set<(label: string) => void>();
  private readonly heartbeatHandlers = new Set<(label: string | undefined) => void>();
  private readonly warningHandlers = new Set<(message: string) => void>();
  private readonly enginePhaseHandlers = new Set<(ev: EnginePhaseEvent) => void>();
  private readonly turnStatsHandlers = new Set<(ev: TurnStatsEvent) => void>();
  private readonly engineStatsHandlers = new Set<(ev: EngineStatsEvent) => void>();

  onDelta(handler: (chunk: string) => void): () => void {
    this.deltaHandlers.add(handler);
    return () => {
      this.deltaHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to live private-reasoning deltas — the model's think phase
   * streamed token-by-token as it happens (today: ds4's `reasoning_content`
   * channel). Kept OFF the visible `onDelta` stream on purpose: reasoning
   * must not join the committed reply body (`turnContent`) or the
   * abort-salvage buffer, and only the UI subscribes here, so the
   * OpenAI-/Ollama-compat forwarders never leak it into API `content`. The
   * UI renders it as a distinct "thinking" block that collapses into the
   * message's reasoning expander once the turn commits.
   */
  onReasoningDelta(handler: (chunk: string) => void): () => void {
    this.reasoningDeltaHandlers.add(handler);
    return () => {
      this.reasoningDeltaHandlers.delete(handler);
    };
  }

  onUsage(handler: (usage: TurnUsage) => void): () => void {
    this.usageHandlers.add(handler);
    return () => {
      this.usageHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to "wire pulse" notifications — fired by providers
   * (currently only Ollama) when a chunk arrives on the wire that
   * carries no visible content / tool_calls. Lets the chat layer
   * surface "the provider is alive but the model isn't producing
   * visible output" as accumulating dots in the streaming bubble,
   * so the user can distinguish between a true stall and a quiet
   * model that's still ticking.
   */
  onWirePulse(handler: () => void): () => void {
    this.wirePulseHandlers.add(handler);
    return () => {
      this.wirePulseHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to live tool-argument chunks — the raw argument text the
   * model streams while building a structured tool call (llama-cpp/MLX
   * `delta.tool_calls[].function.arguments` fragments). These tokens
   * never appear on `onDelta`, so a multi-minute `write_file` is
   * otherwise invisible beyond bare wire pulses. `name` is the tool
   * being called ('' until the name fragment has arrived). Display-only:
   * the authoritative accumulation still happens in the provider's
   * tool-call accumulator.
   */
  onToolArgsDelta(handler: (name: string, chunk: string) => void): () => void {
    this.toolArgsDeltaHandlers.add(handler);
    return () => {
      this.toolArgsDeltaHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to phase-announcement notifications. Currently only
   * Copilot emits these — from its built-in `report_intent` tool,
   * surfaced via the `assistant.intent` SDK event. Drives the
   * horizontal-rule phase dividers in the chat bubble. Other providers
   * never fire; a no-op subscription is fine.
   */
  onIntent(handler: (label: string) => void): () => void {
    this.intentHandlers.add(handler);
    return () => {
      this.intentHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to "still working" heartbeats — fired when a provider
   * signals ongoing activity even though no visible text/tool event
   * has arrived. Copilot wires SDK thinking/tool events; CLI adapters
   * also use this channel for transient, concretely named tool activity
   * so long silent phases do not look stalled or become persisted dividers.
   */
  onHeartbeat(handler: (label: string | undefined) => void): () => void {
    this.heartbeatHandlers.add(handler);
    return () => {
      this.heartbeatHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to mid-turn provider warnings (rate-limits, degraded
   * mode, context pressure). Providers still log to the server
   * console; this channel exists so the UI can surface them inline.
   */
  onWarning(handler: (message: string) => void): () => void {
    this.warningHandlers.add(handler);
    return () => {
      this.warningHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to engine-phase notifications. llama-cpp fires these
   * for its supervised-process lifecycle (model load progress from
   * stdout parsing) and for per-turn stopwatch milestones (prefill,
   * generating). Other providers never fire; a no-op subscription
   * is fine.
   */
  onEnginePhase(handler: (ev: EnginePhaseEvent) => void): () => void {
    this.enginePhaseHandlers.add(handler);
    return () => {
      this.enginePhaseHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to per-turn token+speed telemetry. llama-cpp + Ollama
   * fire these once at turn end. Cloud providers don't.
   */
  onTurnStats(handler: (ev: TurnStatsEvent) => void): () => void {
    this.turnStatsHandlers.add(handler);
    return () => {
      this.turnStatsHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to static engine metrics. llama-cpp fires once after
   * model load with the total RAM allocation. Other providers never
   * fire.
   */
  onEngineStats(handler: (ev: EngineStatsEvent) => void): () => void {
    this.engineStatsHandlers.add(handler);
    return () => {
      this.engineStatsHandlers.delete(handler);
    };
  }

  protected emitDelta(chunk: string): void {
    for (const h of this.deltaHandlers) h(chunk);
  }

  protected emitReasoningDelta(chunk: string): void {
    for (const h of this.reasoningDeltaHandlers) h(chunk);
  }

  protected emitUsage(usage: TurnUsage): void {
    for (const h of this.usageHandlers) h(usage);
  }

  protected emitWirePulse(): void {
    for (const h of this.wirePulseHandlers) h();
  }

  protected emitToolArgsDelta(name: string, chunk: string): void {
    for (const h of this.toolArgsDeltaHandlers) h(name, chunk);
  }

  protected emitIntent(label: string): void {
    for (const h of this.intentHandlers) h(label);
  }

  protected emitHeartbeat(label?: string): void {
    for (const h of this.heartbeatHandlers) h(label);
  }

  protected emitWarning(message: string): void {
    for (const h of this.warningHandlers) h(message);
  }

  protected emitEnginePhase(ev: EnginePhaseEvent): void {
    for (const h of this.enginePhaseHandlers) h(ev);
  }

  protected emitTurnStats(ev: TurnStatsEvent): void {
    for (const h of this.turnStatsHandlers) h(ev);
  }

  protected emitEngineStats(ev: EngineStatsEvent): void {
    for (const h of this.engineStatsHandlers) h(ev);
  }

  protected clearHandlers(): void {
    this.deltaHandlers.clear();
    this.usageHandlers.clear();
    this.wirePulseHandlers.clear();
    this.toolArgsDeltaHandlers.clear();
    this.intentHandlers.clear();
    this.heartbeatHandlers.clear();
    this.warningHandlers.clear();
    this.enginePhaseHandlers.clear();
    this.turnStatsHandlers.clear();
    this.engineStatsHandlers.clear();
  }
}
