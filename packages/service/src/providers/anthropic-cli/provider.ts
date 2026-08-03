import { createLogger } from '@bendyline/gezel';
import { ProviderQueue } from '../queue.js';
import { ExternalToolsUnsupportedError, SessionResumeError } from '../types.js';
import type { LLMProvider, LLMSession, ModelInfo, ProviderName, SessionOpts } from '../types.js';
import { type ClaudeBinary, resolveClaudeBinary } from './binary.js';
import { type ClaudeReasoningEffort, isClaudeReasoningEffort } from './reasoning.js';
import { AnthropicCliSession, type SessionDeps } from './session.js';
import { ClaudeWorkerPool } from './worker-pool.js';

const DEFAULT_MODEL = 'sonnet';

const log = createLogger('anthropic-cli');

/**
 * Claude Code's stable `--model` aliases. They keep working across CLI/model
 * upgrades, while users who need a provider-specific or pinned id can add it
 * through `config.anthropicCli.extraModels`.
 *
 * `opusplan` is the CLI-specific hybrid: Opus for `/plan` mode, Sonnet for
 * execution. Useful for review-style gezels that we don't expose as a
 * separate provider but is worth surfacing here.
 *
 * Display names intentionally describe the alias rather than today's
 * version. Alias resolution depends on the user's account/provider and moves
 * independently of Gezel, so embedding version numbers here creates cosmetic
 * drift even though the actual model selection remains current.
 */
const HARDCODED_MODELS: ModelInfo[] = [
  { id: 'default', name: 'default — Recommended for your account' },
  {
    id: 'best',
    name: 'best — Latest Claude Opus',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
  },
  {
    id: 'sonnet',
    name: 'sonnet — Latest Claude Sonnet',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'sonnet[1m]',
    name: 'sonnet[1m] — Latest Claude Sonnet · 1M context',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'opus',
    name: 'opus — Latest Claude Opus',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
  },
  {
    id: 'opus[1m]',
    name: 'opus[1m] — Latest Claude Opus · 1M context',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
  },
  { id: 'haiku', name: 'haiku — Latest Claude Haiku' },
  {
    id: 'opusplan',
    name: 'opusplan — Opus planning + Sonnet execution',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
  },
];

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface AnthropicCliProviderOptions {
  /** Explicit override for the `claude` binary path. Defaults to PATH lookup. */
  binaryPath?: string;
  /** Default model when neither the gezel nor session opts pin one. */
  defaultModel?: string;
  /** Default effort when the session does not provide a recognized value. */
  defaultReasoningEffort?: ClaudeReasoningEffort;
  /** User-supplied additions to the hardcoded model list. */
  extraModels?: ModelInfo[];
  /** Per-install permission mode default. Falls back to `acceptEdits`. */
  defaultPermissionMode?: ClaudePermissionMode;
  /** Concurrency cap for parallel `claude` invocations. Default 2. */
  concurrency?: number;
  /** Affinity scoring on/off. Default whatever the queue picks. */
  affinity?: boolean;
  /**
   * Root directory for per-session runtime files —
   * `~/.gezel/runtime/anthropic-cli/`. The session writes its `.mcp.json`
   * to `<runtimeDir>/<projectId>/<sessionId>.mcp.json`.
   */
  runtimeDir: string;
  /** Default true — set to false to skip the runtime `.mcp.json` write. */
  manageRuntimeFiles?: boolean;
  /**
   * Maximum number of long-lived `claude` subprocesses to keep warm at
   * once. Default 4. Each worker is pinned to a single chat session;
   * when N+1 sessions need slots, the LRU non-busy worker is evicted.
   */
  poolSize?: number;
  /**
   * Idle timeout (seconds) before a warm worker shuts itself down to free
   * memory. Default 600 (10 min). Mirrors `NativeEngineSupervisor`.
   */
  workerIdleSec?: number;
}

/**
 * Drives Anthropic's `claude` CLI as an in-app gezel provider.
 *
 * Each chat session is pinned to a long-lived `claude` subprocess managed
 * by the provider's `ClaudeWorkerPool`. The first turn of a session pays
 * the cold-start cost (process fork, bundle parse, auth probe, MCP server
 * spawn, tools/list discovery — typically ~1–2 s); subsequent turns are
 * routed to the same warm worker over a stream-json stdin pipe and
 * complete with no subprocess overhead. Five concurrent gezel-to-gezel
 * sessions with a default pool size of 4 means one cold spawn (the
 * eviction-replacement) and four warm. The pool evicts the LRU non-busy
 * worker when at capacity.
 *
 * MCP wiring is external to the subprocess: the worker writes a
 * per-session `.mcp.json` (consumed via `--mcp-config <path>`) once on
 * spawn. Claude's native MCP layer launches gezel-mcp itself. Tools that
 * overlap with Claude's built-ins are filtered out via the existing
 * `GEZEL_MCP_EXCLUDE` env var (see `excluded-mcp-tools.ts`) which
 * ChatManager sets before `SessionOpts.mcpServer` reaches us.
 *
 * Session continuity uses `claude --resume <id>` ON SPAWN. The CLI emits
 * a `system.init` event at process start carrying the session id; we
 * capture it via the worker. Within a single live process, subsequent
 * turns don't need `--resume` — the CLI tracks history in-memory.
 * On worker eviction or crash, the next turn for that session re-spawns
 * with `--resume <captured-id>`. Stale-resume failures surface as
 * `SessionResumeError` (mapped from the CLI's stderr signal), which
 * ChatManager already handles.
 */
export class AnthropicCliProvider implements LLMProvider {
  readonly name: ProviderName = 'anthropic-cli';
  /**
   * External tool calling (`SessionOpts.externalTools`) is NOT supported
   * here. The Claude CLI is a black box that runs its own tool loop
   * internally via MCP. Even though tool_use events surface via the
   * stream-json parser, the CLI has already decided to execute the
   * tool inside its own loop; there's no mechanism to halt and hand
   * control back to the route. Surfacing tools through an ephemeral
   * MCP server that captured-instead-of-executing would deadlock the
   * CLI's inner loop. `/v1/chat/completions` returns
   * `400 tools_not_supported_for_provider` for tool-bearing requests
   * routed to this provider.
   */
  readonly queue: ProviderQueue;
  readonly pool: ClaudeWorkerPool;

  private resolved: ClaudeBinary | null = null;
  private readonly binaryPathOverride?: string;
  private readonly defaultModel: string;
  private readonly defaultReasoningEffort?: ClaudeReasoningEffort;
  private readonly extraModels: ModelInfo[];
  private readonly defaultPermissionMode: ClaudePermissionMode;
  private readonly runtimeDir: string;
  private readonly manageRuntimeFiles: boolean;

  constructor(opts: AnthropicCliProviderOptions) {
    if (opts.binaryPath !== undefined) this.binaryPathOverride = opts.binaryPath;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    if (opts.defaultReasoningEffort) {
      this.defaultReasoningEffort = opts.defaultReasoningEffort;
    }
    this.extraModels = opts.extraModels ?? [];
    this.defaultPermissionMode = opts.defaultPermissionMode ?? 'acceptEdits';
    this.runtimeDir = opts.runtimeDir;
    this.manageRuntimeFiles = opts.manageRuntimeFiles ?? true;
    // Default `concurrency` matches `poolSize` so warm slots aren't
    // wasted: pool size 4 + concurrency 2 means we keep four
    // subprocesses warm but only ever exercise two of them in
    // parallel. Each `claude` subprocess is heavy (memory + MCP
    // children + Claude bundle), so keeping subprocesses around just
    // to gate parallelism would be paying for capacity we never use.
    // The pool's "concurrency > poolSize" warning at construction
    // catches the inverse misconfiguration loudly.
    const poolSize = opts.poolSize ?? 4;
    const concurrency = opts.concurrency ?? poolSize;
    this.queue = new ProviderQueue({
      concurrency,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
    this.pool = new ClaudeWorkerPool({
      poolSize,
      workerIdleMs: (opts.workerIdleSec ?? 600) * 1000,
      providerConcurrency: concurrency,
    });
  }

  async initialize(): Promise<void> {
    if (this.resolved) return;
    this.resolved = await resolveClaudeBinary({
      ...(this.binaryPathOverride !== undefined ? { override: this.binaryPathOverride } : {}),
    });
    log.info(`[anthropic-cli] resolved ${this.resolved.path} (${this.resolved.version})`);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
    this.resolved = null;
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    // See the class docstring: the CLI's inner tool loop can't halt and
    // hand control back, so caller-supplied tools must be refused, not
    // silently dropped. Guarded before initialize() so the rejection
    // doesn't depend on a resolvable binary.
    if (opts.externalTools && opts.externalTools.length > 0) {
      throw new ExternalToolsUnsupportedError(this.name);
    }
    await this.initialize();
    if (!this.resolved) throw new Error('[anthropic-cli] binary not resolved');
    // ChatManager always populates `claudeCliContext` for normal session
    // builds. One-shot completions (icon/about generation, summarization)
    // call `createSession` without it; we synthesize a transient context so
    // those still work — runtime files land under a `oneshot/` bucket and
    // get garbage-collected by the runtime-dir-wide cleanup the next time
    // the manager prunes.
    const ctx: NonNullable<SessionOpts['claudeCliContext']> = opts.claudeCliContext ?? {
      sessionId: `oneshot-${Math.random().toString(36).slice(2, 10)}`,
      gezelId: 'oneshot',
      projectId: 'oneshot',
      cwd: process.cwd(),
    };
    const reasoningEffort = pickReasoningEffort(opts.reasoningEffort, this.defaultReasoningEffort);
    const deps: SessionDeps = {
      binaryPath: this.resolved.path,
      model: opts.model ?? this.defaultModel,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      permissionMode: ctx.permissionModeOverride ?? this.defaultPermissionMode,
      systemMessage: opts.systemMessage,
      context: ctx,
      runtimeDir: this.runtimeDir,
      manageRuntimeFiles: this.manageRuntimeFiles,
      queue: this.queue,
      pool: this.pool,
      ...(opts.mcpServer ? { mcpServer: opts.mcpServer } : {}),
      ...(opts.extraMcpServers ? { extraMcpServers: opts.extraMcpServers } : {}),
      ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
      ...(opts.knownSecretValues ? { knownSecretValues: opts.knownSecretValues } : {}),
      ...(opts.claudeCliSessionId ? { initialResumeId: opts.claudeCliSessionId } : {}),
    };
    return new AnthropicCliSession(deps);
  }

  async resumeSession(sessionId: string, opts: SessionOpts): Promise<LLMSession> {
    if (!sessionId) {
      throw new SessionResumeError('[anthropic-cli] empty session id passed to resumeSession');
    }
    return this.createSession({ ...opts, claudeCliSessionId: sessionId });
  }

  async listModels(): Promise<ModelInfo[]> {
    const merged = new Map<string, ModelInfo>();
    for (const m of HARDCODED_MODELS) merged.set(m.id, m);
    for (const m of this.extraModels) merged.set(m.id, m);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

function pickReasoningEffort(
  sessionValue: string | undefined,
  providerDefault: ClaudeReasoningEffort | undefined,
): ClaudeReasoningEffort | undefined {
  return isClaudeReasoningEffort(sessionValue) ? sessionValue : providerDefault;
}
