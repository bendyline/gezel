import { createLogger } from '@bendyline/gezel';
import { ProviderQueue } from '../queue.js';
import { SessionResumeError } from '../types.js';
import type { LLMProvider, LLMSession, ModelInfo, ProviderName, SessionOpts } from '../types.js';
import { type CodexBinary, resolveCodexBinary } from './binary.js';
import type { CodexPermissionMode, CodexReasoningEffort } from './invoker.js';
import { CodexCliSession, type CodexSessionDeps } from './session.js';

const DEFAULT_MODEL = 'gpt-5.5';

const log = createLogger('codex-cli');

/**
 * Hardcoded model list. Codex CLI's `-m` flag accepts any model id the
 * upstream account can route to — we ship the common GPT-5 series tags
 * by default. Users who want a different id (legacy `o3-mini`, hosted
 * fine-tunes, OSS models via `--oss`) can extend the list via
 * `config.codexCli.extraModels`.
 *
 * Display labels are cosmetic — the id is what's passed to `-m`. Update
 * here when OpenAI ships a new revision; a stale label just means the
 * dropdown reads the older revision number while the alias still routes
 * to whatever Codex's resolver picks.
 */
const HARDCODED_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    name: 'gpt-5.5 — GPT-5.5',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.4',
    name: 'gpt-5.4 — GPT-5.4',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.3',
    name: 'gpt-5.3 — GPT-5.3',
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
];

export interface CodexCliProviderOptions {
  /** Explicit override for the `codex` binary path. Defaults to PATH lookup. */
  binaryPath?: string;
  /** Default model when neither the gezel nor session opts pin one. */
  defaultModel?: string;
  /** Default reasoning effort when neither the gezel nor session pin one. */
  defaultReasoningEffort?: CodexReasoningEffort;
  /** User-supplied additions to the hardcoded model list. */
  extraModels?: ModelInfo[];
  /** Per-install permission mode default. Falls back to `acceptEdits`. */
  defaultPermissionMode?: CodexPermissionMode;
  /** Concurrency cap for parallel `codex` invocations. Default 4. */
  concurrency?: number;
  /** Affinity scoring on/off. Default whatever the queue picks. */
  affinity?: boolean;
  /**
   * Root directory for per-session runtime files —
   * `~/.gezel/runtime/codex-cli/`. Each session writes a
   * `<projectId>/<sessionId>/` subdir holding `config.toml` and a
   * symlink to `~/.codex/auth.json`.
   */
  runtimeDir: string;
  /** Default true — set to false to skip the per-session CODEX_HOME write. */
  manageRuntimeFiles?: boolean;
  /** Power-user `-c key=value` overrides appended to every spawn. */
  extraConfigOverrides?: Record<string, string>;
}

/**
 * Drives OpenAI's `codex` CLI as an in-app gezel provider.
 *
 * Each user turn spawns a fresh `codex exec` subprocess (or
 * `codex exec resume <thread_id>` for follow-ups). The Codex binary is
 * native (Rust) so spawn cost is small (~tens of ms) compared to model
 * latency — there's no warm worker pool.
 *
 * MCP wiring is per-session: the provider builds a per-session
 * `CODEX_HOME` directory containing a `config.toml` with the gezel's
 * persona (`instructions`), model, reasoning effort, and
 * `[mcp_servers.*]` blocks for gezel-mcp + extras. Codex CLI has no
 * `--mcp-config` flag — `config.toml` is the contract, and `CODEX_HOME`
 * is how we point it at a per-session one.
 *
 * Auth is the user's responsibility — `codex login` populates
 * `~/.codex/auth.json` (which the provider symlinks into the per-
 * session home), or the user sets `OPENAI_API_KEY` / `CODEX_API_KEY`
 * in their env (Codex picks either up via the inherited environment).
 *
 * Session continuity: the first `codex exec` of a thread emits a
 * `thread.started` event whose `thread_id` we capture and persist on
 * `ChatSession.providerState.codexCliThreadId`. Subsequent turns run
 * `codex exec resume <captured-id>`. Stale-thread failures surface as
 * `SessionResumeError` (matched on Codex stderr patterns), which
 * ChatManager's existing resume-fallback path already handles.
 */
export class CodexCliProvider implements LLMProvider {
  readonly name: ProviderName = 'codex-cli';
  /**
   * External tool calling (`SessionOpts.externalTools`) is NOT supported
   * here. Codex spawns a fresh `codex exec` subprocess per turn and
   * runs its own MCP tool loop internally, emitting only the final
   * assembled output. There's no stdin channel to pause-and-resume
   * after a captured tool call, and the per-turn subprocess model
   * makes a halt mechanism architecturally unworkable.
   * `/v1/chat/completions` returns `400 tools_not_supported_for_provider`
   * for tool-bearing requests routed here.
   */
  readonly queue: ProviderQueue;

  private resolved: CodexBinary | null = null;
  private readonly binaryPathOverride?: string;
  private readonly defaultModel: string;
  private readonly defaultReasoningEffort?: CodexReasoningEffort;
  private readonly extraModels: ModelInfo[];
  private readonly defaultPermissionMode: CodexPermissionMode;
  private readonly runtimeDir: string;
  private readonly manageRuntimeFiles: boolean;
  private readonly extraConfigOverrides?: Record<string, string>;

  constructor(opts: CodexCliProviderOptions) {
    if (opts.binaryPath !== undefined) this.binaryPathOverride = opts.binaryPath;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    if (opts.defaultReasoningEffort) this.defaultReasoningEffort = opts.defaultReasoningEffort;
    this.extraModels = opts.extraModels ?? [];
    this.defaultPermissionMode = opts.defaultPermissionMode ?? 'acceptEdits';
    this.runtimeDir = opts.runtimeDir;
    this.manageRuntimeFiles = opts.manageRuntimeFiles ?? true;
    if (opts.extraConfigOverrides) this.extraConfigOverrides = opts.extraConfigOverrides;
    const concurrency = opts.concurrency ?? 4;
    this.queue = new ProviderQueue({
      concurrency,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.resolved) return;
    this.resolved = await resolveCodexBinary({
      ...(this.binaryPathOverride !== undefined ? { override: this.binaryPathOverride } : {}),
    });
    log.info(`[codex-cli] resolved ${this.resolved.path} (${this.resolved.version})`);
  }

  async shutdown(): Promise<void> {
    this.resolved = null;
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    await this.initialize();
    if (!this.resolved) throw new Error('[codex-cli] binary not resolved');
    // Like the Anthropic CLI provider, ChatManager always populates
    // `codexCliContext` for normal session builds; one-shot completions
    // (icon/about generation, summarization) call `createSession` without
    // it. Synthesize a transient context so those still work — runtime
    // files land under a `oneshot/` bucket and get cleaned up by the
    // surrounding runtime-dir cleanup.
    const ctx: NonNullable<SessionOpts['codexCliContext']> = opts.codexCliContext ?? {
      sessionId: `oneshot-${Math.random().toString(36).slice(2, 10)}`,
      gezelId: 'oneshot',
      projectId: 'oneshot',
      cwd: process.cwd(),
    };
    const reasoningEffort = pickReasoningEffort(
      opts.reasoningEffort,
      ctx.reasoningEffortOverride,
      this.defaultReasoningEffort,
    );
    const deps: CodexSessionDeps = {
      binaryPath: this.resolved.path,
      model: opts.model ?? this.defaultModel,
      permissionMode: ctx.permissionModeOverride ?? this.defaultPermissionMode,
      systemMessage: opts.systemMessage,
      context: ctx,
      runtimeDir: this.runtimeDir,
      manageRuntimeFiles: this.manageRuntimeFiles,
      queue: this.queue,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(this.extraConfigOverrides ? { extraConfigOverrides: this.extraConfigOverrides } : {}),
      ...(opts.mcpServer ? { mcpServer: opts.mcpServer } : {}),
      ...(opts.extraMcpServers ? { extraMcpServers: opts.extraMcpServers } : {}),
      ...(opts.toolAllowlist ? { toolAllowlist: opts.toolAllowlist } : {}),
      ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
      ...(opts.knownSecretValues ? { knownSecretValues: opts.knownSecretValues } : {}),
      ...(opts.codexCliThreadId ? { initialResumeId: opts.codexCliThreadId } : {}),
    };
    return new CodexCliSession(deps);
  }

  async resumeSession(sessionId: string, opts: SessionOpts): Promise<LLMSession> {
    if (!sessionId) {
      throw new SessionResumeError('[codex-cli] empty thread id passed to resumeSession');
    }
    return this.createSession({ ...opts, codexCliThreadId: sessionId });
  }

  async listModels(): Promise<ModelInfo[]> {
    const merged = new Map<string, ModelInfo>();
    for (const m of HARDCODED_MODELS) merged.set(m.id, m);
    for (const m of this.extraModels) merged.set(m.id, m);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Resolve the reasoning effort used for a session. Precedence:
 *   1. Per-turn `SessionOpts.reasoningEffort` (if Codex-recognized).
 *   2. Per-session `codexCliContext.reasoningEffortOverride` (gezel
 *      frontmatter resolved by ChatManager).
 *   3. Provider-level `defaultReasoningEffort`.
 *
 * Codex only accepts `low | medium | high`. Any other string is dropped
 * silently — gezels with arbitrary reasoning effort labels (e.g. Ollama's
 * `none`) just run without the override.
 */
function pickReasoningEffort(
  perTurn: string | undefined,
  perGezel: 'low' | 'medium' | 'high' | undefined,
  providerDefault: CodexReasoningEffort | undefined,
): CodexReasoningEffort | undefined {
  if (perTurn === 'low' || perTurn === 'medium' || perTurn === 'high') {
    return perTurn;
  }
  if (perGezel) return perGezel;
  return providerDefault;
}
