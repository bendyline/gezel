import { createLogger } from '@bendyline/gezel';
import { type ProviderQueue, runInQueue } from '../queue.js';
import { StreamingSessionBase } from '../streaming-session.js';

const log = createLogger('anthropic-cli');
import type {
  LLMSession,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
  ToolArgsDeltaMeta,
  ToolCallEvent,
  TurnUsage,
} from '../types.js';
import type { ClaudePermissionMode } from './provider.js';
import type { ClaudeReasoningEffort } from './reasoning.js';
import type { ClaudeWorkerPool, ClaudeWorkerSpec } from './worker-pool.js';
import type { WorkerTurnHooks } from './worker.js';

export interface SessionDeps {
  binaryPath: string;
  model: string;
  reasoningEffort?: ClaudeReasoningEffort;
  permissionMode: ClaudePermissionMode;
  systemMessage: string;
  context: NonNullable<SessionOpts['claudeCliContext']>;
  runtimeDir: string;
  manageRuntimeFiles: boolean;
  queue: ProviderQueue;
  pool: ClaudeWorkerPool;
  mcpServer?: SessionOpts['mcpServer'];
  extraMcpServers?: SessionOpts['extraMcpServers'];
  onToolCall?: SessionOpts['onToolCall'];
  knownSecretValues?: SessionOpts['knownSecretValues'];
  initialResumeId?: string;
}

const TURN_TIMEOUT_DEFAULT_MS = 600_000;

/**
 * One CLI session = one logical chat thread. The session class is a thin
 * façade over the surrounding `ClaudeWorkerPool` — every `sendAndWait`
 * acquires the session's pinned worker (spawning if needed, evicting LRU
 * when at cap) and runs one turn through it. Heavy lifting (subprocess
 * lifecycle, stream parsing, idle timer, crash recovery) lives in
 * `worker.ts` + `worker-pool.ts`.
 *
 * `claudeSessionId` is captured by the underlying worker on its first
 * `system.init` event; the session caches it locally so `providerState()`
 * can return it cheaply (and so a worker eviction doesn't lose the id —
 * the next turn re-spawns with `--resume <captured-id>`).
 */
export class AnthropicCliSession extends StreamingSessionBase implements LLMSession {
  private claudeSessionIdCache: string | null;
  private aborted = false;
  /**
   * Chain-of-thought captured this turn, aggregated across every thinking
   * block the CLI produced (a single `sendAndWait` covers the whole
   * agentic loop, so one turn routinely holds several). Accumulated here
   * rather than in the worker because a turn that times out or is
   * cancelled still rejects through the worker, and ChatManager reads
   * this on exactly that path to salvage the partial trace.
   */
  private lastTurnReasoning = '';

  constructor(private readonly deps: SessionDeps) {
    super();
    this.claudeSessionIdCache = deps.initialResumeId ?? null;
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  /**
   * Reasoning captured on the most recent turn. Returns `undefined` (not
   * `''`) when the turn produced none, so ChatManager can skip writing
   * `ChatMessage.reasoning` entirely.
   */
  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  providerState(): ProviderSessionState {
    return this.claudeSessionIdCache ? { claudeCliSessionId: this.claudeSessionIdCache } : {};
  }

  getRegisteredToolNames(): string[] {
    const context = this.deps.context;
    return [
      ...new Set([...(context.allowedBuiltinTools ?? []), ...(context.allowedMcpTools ?? [])]),
    ];
  }

  async disconnect(): Promise<void> {
    this.aborted = true;
    // Evict THIS session's worker only — never call pool.shutdown() from
    // here; the provider owns the pool's lifecycle.
    try {
      await this.deps.pool.evict(this.deps.context.sessionId);
    } catch (err) {
      log.warn('[anthropic-cli] disconnect evict error:', err);
    }
    this.clearHandlers();
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    if (this.aborted) throw new Error('[anthropic-cli] session was disconnected');

    this.lastTurnReasoning = '';

    const turnTimeoutMs = opts?.timeoutMs ?? TURN_TIMEOUT_DEFAULT_MS;

    const spec: ClaudeWorkerSpec = {
      binaryPath: this.deps.binaryPath,
      model: this.deps.model,
      ...(this.deps.reasoningEffort ? { reasoningEffort: this.deps.reasoningEffort } : {}),
      permissionMode: this.deps.permissionMode,
      systemMessage: this.deps.systemMessage,
      context: this.deps.context,
      runtimeDir: this.deps.runtimeDir,
      manageRuntimeFiles: this.deps.manageRuntimeFiles,
      ...(this.deps.mcpServer ? { mcpServer: this.deps.mcpServer } : {}),
      ...(this.deps.extraMcpServers ? { extraMcpServers: this.deps.extraMcpServers } : {}),
      ...(this.claudeSessionIdCache ? { initialResumeId: this.claudeSessionIdCache } : {}),
    };

    const hooks = this.buildTurnHooks();
    const sendOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: turnTimeoutMs };
    if (opts?.queue?.signal) sendOpts.signal = opts.queue.signal;

    try {
      const text = await this.deps.pool.runTurn(spec, prompt, hooks, sendOpts);
      // Refresh the cached session id from the worker — it may have been
      // newly captured this turn (first turn of a session) or unchanged
      // (subsequent turns reuse the same upstream session id).
      const worker = this.deps.pool
        .snapshot()
        .workers.find((w) => w.sessionId === this.deps.context.sessionId);
      if (worker?.claudeSessionId) {
        this.claudeSessionIdCache = worker.claudeSessionId;
      }
      return text;
    } catch (err) {
      // If the upstream session is gone, our cached id is stale. Clearing
      // here means the next sendAndWait spawns a fresh worker without
      // `--resume`. ChatManager's resume-error path is the higher-level
      // recovery; this is a belt-and-braces local clear.
      if (err instanceof Error && err.name === 'SessionResumeError') {
        this.claudeSessionIdCache = null;
      }
      throw err;
    }
  }

  private buildTurnHooks(): WorkerTurnHooks {
    return {
      emitDelta: (text: string) => this.emitDelta(text),
      emitReasoningDelta: (text: string) => {
        this.lastTurnReasoning += text;
        this.emitReasoningDelta(text);
      },
      emitHeartbeat: (label?: string) => this.emitHeartbeat(label),
      emitToolArgsDelta: (name: string, chunk: string, meta?: ToolArgsDeltaMeta) =>
        this.emitToolArgsDelta(name, chunk, meta),
      emitWarning: (message: string) => this.emitWarning(message),
      emitUsage: (usage: TurnUsage) => this.emitUsage(usage),
      ...(this.deps.onToolCall
        ? { onToolCall: (ev: ToolCallEvent) => this.deps.onToolCall?.(ev) }
        : {}),
      ...(this.deps.knownSecretValues ? { knownSecretValues: this.deps.knownSecretValues } : {}),
    };
  }
}

/**
 * The Claude CLI doesn't (yet) emit a typed error for "resume id not found"
 * — it surfaces as a non-zero exit with a short stderr message. We match a
 * narrow set of phrases so a stray exit-9 with unrelated stderr doesn't get
 * treated as a resume failure.
 *
 * Exported for `worker.ts`.
 */
export function isResumeFailureSignal(input: { stderr: string; exitCode: number | null }): boolean {
  const lower = input.stderr.toLowerCase();
  return (
    lower.includes('session not found') ||
    lower.includes('no such session') ||
    lower.includes('session does not exist') ||
    lower.includes('session has expired') ||
    lower.includes('could not resume')
  );
}
