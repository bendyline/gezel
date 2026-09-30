/**
 * What the local loop needs from the host it runs in: something to execute
 * tools, the engine it talks to, and that engine's prompt cache. The daemon
 * supplies its MCP bridge pool and llama-server provider; a phone supplies
 * its own tool executor and native engine. The loop never sees which.
 */

import type { ProviderQueue } from '../runtime/provider-queue.js';

/** A tool as the model is offered it (OpenAI function-tool shape). */
export interface LocalToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/** How much of the context a tool result may take. */
export interface LocalToolOutputBudget {
  budgetChars?: number;
  numCtxTokens?: number;
  /** Reclaim context for this result before capping it. Receives only its
   * character count, bounded by the ordinary output ceiling. The returned
   * budget is still subject to all normal caps. */
  prepareOutputBudget?: (resultChars: number) => Promise<number>;
  onImages?: (images: Array<{ base64: string; mimeType: string }>) => void;
  onApprovalPending?: () => void;
}

/** Runs the model's tool calls; results come back as the text the model reads. */
export interface LocalToolExecutor {
  isEmpty(): boolean;
  getOpenAITools(): LocalToolDefinition[];
  hasTool(name: string): boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: LocalToolOutputBudget,
  ): Promise<string>;
  stop(): Promise<void>;
}

/** The stable system prompt split at the gezel/project boundary, for layered prefix caches. */
export interface SystemPromptLayers {
  /** Gezel-identity leading prefix (before the project-context band). */
  gezel: string;
  /** Full stable system message (= the bytes sent as messages[0]). */
  project: string;
}

/** The engine's per-session prompt cache, when it has one. */
export interface LocalPromptCacheAdapter {
  prepareForSend(
    sessionId: string,
    systemMessage: string,
    layers?: SystemPromptLayers,
  ): Promise<void>;
  buildRequestExtras(sessionId: string): Record<string, unknown>;
}

/**
 * How far a tool grammar was relaxed after llama.cpp rejected it: pattern
 * constraints stripped, then structural schemas, then no grammar at all.
 */
export type ToolGrammarFallback = 'none' | 'strip-patterns' | 'simplified' | 'permissive';

/** The engine the loop sends requests to, and the state it keeps across sessions. */
export interface LocalEngineHost {
  /** Provider name, for disposal errors and queue attribution. */
  readonly name: string;
  /** The engine's scheduler; a turn holds a slot for its whole tool loop. */
  readonly queue: ProviderQueue;
  readonly supportsForcedToolChoice: boolean;
  readonly isDisposed: boolean;
  acquireExclusiveEngineRequest(
    label: string,
    signal?: AbortSignal,
    onWait?: (info: { aheadOf: number }) => void,
  ): Promise<() => void>;
  getCacheAdapter(): LocalPromptCacheAdapter | null | undefined;
  toolGrammarFloorFor(toolCount: number): ToolGrammarFallback;
  noteToolGrammarFloor(toolCount: number, tier: ToolGrammarFallback): void;
  noteForcedToolChoiceUnsupported(): void;
  // Method syntax: the host keeps its own session type.
  _registerActiveSession(session: object): void;
  _deregisterActiveSession(session: object): void;
}

export type NativeEnginePanicKind =
  | 'cuda-invalid-argument'
  | 'cuda-out-of-memory'
  | 'cuda-illegal-memory-access'
  | 'cuda-device-assert'
  | 'cuda-error'
  | 'vulkan-out-of-memory'
  | 'assertion-failed'
  /**
   * SIGILL. Every other kind is recognized from a line the engine
   * printed; this one is inferred from the signal, because a binary
   * whose instructions the CPU cannot decode usually dies without
   * printing anything at all. That silence is exactly what made it hard
   * to diagnose in the field — the crash reported a bare signal name and
   * no attribution, so it read as a generic engine fault rather than
   * "this build cannot run on this machine."
   *
   * Two distinct causes land here and both mean the same thing for the
   * user: an instruction above the CPU's feature level (a build tuned to
   * the CI runner rather than to the target), or a `ud2` trap on an
   * unreachable/abort path inside GPU library init.
   */
  | 'illegal-instruction';

export interface NativeEngineExitSnapshot {
  /** Stable correlation key included in the lifecycle log and provider error. */
  incidentId: string;
  pid?: number;
  startedAt: number;
  exitedAt: number;
  uptimeMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  expectedReason?: string;
  panicKind?: NativeEnginePanicKind;
  panicLine?: string;
  /**
   * False when the engine died during startup, before it ever answered
   * on its readiness endpoint. The distinction decides whether a crash
   * is attributable to the BUILD (never worked here) or to the WORK (a
   * model, a request, an allocation) — only the former is safe to
   * quarantine a backend over.
   */
  reachedReady: boolean;
  /** Bounded stdout/stderr tail retained in memory for diagnostics. */
  outputTail: string;
  diagnostics?: Record<string, string | number | boolean>;
}
