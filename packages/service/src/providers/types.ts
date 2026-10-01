import type { CodexPermissionModeCompat, ProviderName } from '@bendyline/gezel';
import type {
  ActiveCraftbookStep,
  CompactionRequester,
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMSession,
  ProviderSessionState,
  QuotaBucket,
  SendAndWaitOpts,
  TerminalToolPolicy,
  ToolArgsDeltaMeta,
  TurnUsage,
} from '@bendyline/gezel/local-loop';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import type { CodexReasoningEffort } from './codex-cli/reasoning.js';
import type { McpServerSpec } from './mcp-bridge.js';

// The local loop's contract lives in core; re-exported for every provider here.
export type {
  ActiveCraftbookStep,
  CompactionRequester,
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMSession,
  ProviderSessionState,
  SendAndWaitOpts,
  TerminalToolPolicy,
  ToolArgsDeltaMeta,
  TurnUsage,
};

export type { ProviderName };

export interface ProviderCredentials {
  githubToken?: string;
  openaiApiKey?: string;
  openaiOrganization?: string;
}

export interface SessionOpts {
  systemMessage: string;
  /**
   * Layered prompt-cache prefixes (flag `layeredPrefixCache`). Present
   * only when layered caching is ON; the cache adapters key the
   * `prefix-gezel` / `prefix-gp` entries on these cumulative stable
   * substrings instead of hashing the whole prompt. Undefined → legacy
   * whole-prompt keying. See {@link SystemPromptLayers}.
   */
  systemPromptLayers?: import('../cache/adapter.js').SystemPromptLayers;
  /**
   * Leading run of `systemMessage` that sibling sessions of the same
   * (gezel, project) render identically. Set only when the shared-band
   * prefix flag is on; drives the MLX adapter's `prefix-band-` key and the
   * sidecar's snapshot cut. See ADR 0010.
   */
  systemSharedPrefix?: string;
  /**
   * Volatile band (workspace files, task, recall, anchor, …) split out
   * of `systemMessage` when layered caching is ON. The session seeds it
   * as a frozen `system` message right after `messages[0]` so the wire
   * prefix `[stable system][tools]` stays reusable across sessions.
   * Undefined → legacy inline-in-systemMessage layout.
   */
  volatileContext?: string;
  model?: string;
  /** Reasoning effort level — only honored by models that advertise support. */
  reasoningEffort?: string;
  /**
   * OpenAI only: pre-seed the session with a `previous_response_id` so the
   * next turn continues a server-side conversation instead of starting fresh.
   */
  openaiPreviousResponseId?: string;
  /**
   * `anthropic-cli` only: pre-seed the session with a session id captured
   * from a prior `claude -p` invocation. The provider passes
   * `--resume <id>` on the first turn; on resume failure it throws
   * `SessionResumeError` and ChatManager falls back to a fresh session.
   */
  claudeCliSessionId?: string;
  /**
   * `codex-cli` only: pre-seed the session with a thread id captured
   * from a prior `codex exec` invocation. The provider routes follow-up
   * turns through `codex exec resume <thread_id>` instead of starting a
   * fresh thread. On resume failure (Codex stderr-pattern match) the
   * provider throws `SessionResumeError` and ChatManager falls back to
   * a fresh thread.
   */
  codexCliThreadId?: string;
  /**
   * `anthropic-cli` only: per-session context the CLI provider needs to
   * resolve cwd (the project's workingDir), pick a runtime `.mcp.json`
   * path, and tag log lines. Populated by ChatManager from the live
   * `ChatSession` record + project. Required when the session is built
   * by the Claude CLI provider; ignored by every other provider.
   *
   * `permissionModeOverride` resolves the gezel-frontmatter override
   * once at session-build time; the provider plugs it into every
   * `--permission-mode <…>` arg without having to read frontmatter on
   * every turn.
   */
  claudeCliContext?: {
    sessionId: string;
    gezelId: string;
    projectId: string;
    cwd: string;
    permissionModeOverride?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    /**
     * Claude built-in tool names to pass via `--disallowedTools` so the
     * model literally cannot reach for those surfaces. Derived from the
     * gezel's role + toolsets groups (`claudeBuiltinsToDisallow` in
     * `chat/role-tool-filter.ts`) — e.g. a Meester (no `workspace-fs-*`
     * or `code-execution` groups) gets `['Bash', 'Read', 'Write',
     * 'Edit', 'Grep', 'Glob', 'NotebookEdit']` and is forced to
     * delegate to specialist gezels. A Voorman (read-only workspace)
     * keeps `['Read', 'Grep', 'Glob']` and only loses the writes. A
     * Developer (full coverage) gets `[]`.
     */
    disallowedBuiltinTools?: string[];
    /**
     * Claude built-in tool names to pass via `--allowedTools` so they
     * auto-approve (skip the `--permission-prompt-tool` flow). Inverse
     * of `disallowedBuiltinTools` — the role's allowed set, plus
     * always-allowed `TodoWrite`. The user already gave this gezel
     * the role; prompting on every Bash/Write/Edit inside that
     * already-approved surface is just friction.
     */
    allowedBuiltinTools?: string[];
    /**
     * gezel-mcp tool names to pass via `--allowedTools`, in the
     * `mcp__gezel__<tool>` format Claude CLI expects. We auto-approve
     * the role's gezel-mcp surface because it's our own server —
     * `save_memory`, `list_gezels`, `create_task`, etc. shouldn't pop
     * a permission card on every use. Extra MCP servers (Playwright,
     * GitHub, …) are NOT included; those carry side effects beyond
     * gezel-mcp's trusted surface and continue to flow through the
     * `--permission-prompt-tool` path.
     */
    allowedMcpTools?: string[];
  };
  /**
   * `codex-cli` only: per-session context the Codex CLI provider needs
   * to write a per-session `CODEX_HOME` directory (config.toml,
   * symlinked auth.json) and resolve the cwd to pass via `--cd`.
   * Mirrors `claudeCliContext` — populated by ChatManager from the
   * live `ChatSession` record + project. Required when the session is
   * built by the Codex CLI provider; ignored by every other provider.
   *
   * `permissionModeOverride` resolves the gezel-frontmatter override
   * once at session-build time; the provider maps it onto Codex's
   * two-axis `--sandbox` / `--ask-for-approval` flags.
   *
   * `reasoningEffortOverride` carries the per-gezel `reasoningEffort`
   * when it is a Codex-recognized value. The provider forwards it as
   * `-c model_reasoning_effort=…`; the supported subset remains
   * model-dependent.
   */
  codexCliContext?: {
    sessionId: string;
    gezelId: string;
    projectId: string;
    cwd: string;
    permissionModeOverride?: CodexPermissionModeCompat;
    reasoningEffortOverride?: CodexReasoningEffort;
  };
  /**
   * Local MCP server to launch and expose to the session. The primary
   * entry (`mcpServer`) is the built-in gezel-mcp — always-present,
   * always stdio, keyed as `gezel` in Copilot's config.
   * `extraMcpServers` holds per-gezel toolsets installed from the
   * catalog; each entry can be either a stdio subprocess (legacy
   * shape) or a hosted HTTP server, distinguished by the `kind`
   * discriminator on `McpServerSpec`. Bridge-backed providers consume
   * both shapes through `McpBridgePool`; CLI providers wire what their
   * native MCP config supports.
   */
  mcpServer?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  extraMcpServers?: Array<
    {
      /** Stable identifier (the toolset id). Used as the key in Copilot's
       * `mcpServers` map and as the lookup key for callTool dispatch in
       * bridge-based providers. */
      id: string;
    } & McpServerSpec
  >;
  /**
   * Optional callback fired when the session invokes a tool and the
   * provider can observe it. Bridge-backed providers fire this from
   * `McpBridge`; CLI providers may synthesize it from their JSON stream
   * events. Copilot still runs tools inside its SDK and only surfaces
   * the subset we can observe from SDK callbacks.
   */
  onToolCall?: (info: ToolCallEvent) => void | Promise<void>;
  /**
   * Prior transcript to seed a stateless provider with. Honored by the
   * providers that build each request's message array themselves
   * (Ollama, llama.cpp, MLX, OpenAI-without-previous_response_id,
   * Anthropic, remote) — they advertise `LLMProvider.supportsPriorMessages`.
   * Ignored by Copilot (server-side session handles history) and the
   * CLI providers (subprocess owns its transcript); stateless routes
   * must flatten history into the prompt for those instead.
   *
   * Tool-calling history: `role: 'tool'` entries carry the result of a
   * prior tool invocation (the callee's response). `role: 'assistant'`
   * entries may carry `toolCalls` describing the calls the model made
   * on a prior turn. Providers that don't support tool calling drop
   * these fields silently — the same way they drop priorMessages for
   * stateful sessions.
   */
  priorMessages?: Array<
    | { role: 'user' | 'assistant'; content: string; images?: string[] }
    | {
        role: 'assistant';
        content: string;
        toolCalls: ExternalToolCall[];
        reasoning?: string;
      }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  /**
   * Caller-provided tool definitions in OpenAI's `function` shape.
   *
   * When set, the session enters "external tools" mode: the provider
   * advertises these tools to the model alongside (or instead of)
   * gezel's own MCP-bridge tools, but DOES NOT execute them. On the
   * first model-emitted tool call the session halts and surfaces the
   * captured call(s) via {@link LLMSession.capturedToolCalls}. The
   * caller (`/v1/chat/completions` for third-party apps) then returns
   * the calls to the user-side, who executes them and posts back the
   * results in a follow-up turn via `priorMessages` `tool` entries.
   *
   * Providers that don't implement external tool calling reject with
   * a clear `tools_not_supported_for_provider` error at session
   * creation. Today: MockProvider, OpenAIProvider, and the local
   * llama-cpp family (including ds4, which wraps the same session)
   * support this — the fitness probe (fitness/probe.ts) rides the
   * llama-cpp path. Anthropic / Copilot are deferred.
   */
  externalTools?: ExternalToolSpec[];
  /**
   * Secret values the session should never leak into logs, SSE tool-call
   * events, or error messages. Populated from the SecretStore at session
   * build time; the MCP bridge redacts occurrences of these strings from
   * everything it emits.
   */
  knownSecretValues?: Set<string>;
  /**
   * Ollama-only: override the `num_ctx` passed with each /api/chat request.
   * Ignored by Copilot/OpenAI (whose server-side sessions manage context).
   */
  numCtx?: number;
  /**
   * Local-providers only (llama-cpp, mlx, ds4, ollama): callback the session
   * invokes mid-tool-loop when its in-memory transcript is filling the
   * context window. The session passes the messages BEFORE the current
   * turn's user message — the callback runs a one-shot compaction LLM
   * call on them and returns the wrapped synthetic message body the
   * session should swap in.
   *
   * Optional. When unset, the session falls back to the existing
   * post-turn pressure check that runs at the next user-message
   * boundary — fine for short turns, but a single tool-heavy turn can
   * blow past `numCtx` without ever crossing a user-message boundary
   * for the manager to compact at. Returning `null` (insufficient
   * prior, LLM error, empty synthesis) tells the session to keep going
   * without swapping anything; the in-flight turn proceeds and may
   * still hit a server-side parse error / context-overflow which the
   * provider then surfaces as a warning per its existing recovery
   * paths.
   */
  requestCompaction?: CompactionRequester;
  /**
   * Process-wide verbose-diagnostics flag. Passed through to every MCP
   * bridge this session spawns so tool calls can log full args +
   * responses (redacted) when debug mode is on.
   */
  debug?: { isEnabled(): boolean };
  /**
   * Called when a bridge fails to start (primary or extra). Service
   * uses this to surface `debug.bridge.failed` history events when
   * debug mode is on — silent otherwise.
   */
  onBridgeFailure?: (info: { bridgeId: string; error: unknown }) => void;
  /**
   * Role-derived ceiling on advertised and callable built-in tools.
   * Third-party tools are unaffected by this set; an authored step's
   * toolNamePolicy can constrain those too. The bridge pool retains a
   * narrow append recovery exception for truncated write_file calls.
   * See chat/role-tool-filter.ts. Unset adds no role-based restriction.
   */
  toolAllowlist?: Set<string>;
  /** Authored step ceiling for all bridge tools, including third-party MCP tools. */
  toolNamePolicy?: {
    allow?: ReadonlySet<string>;
    deny?: ReadonlySet<string>;
  };
  /**
   * The chat manager classified this session's current turn as direct
   * file work and narrowed its tool surface accordingly. Local providers
   * may use this authoritative signal instead of re-inferring the mode
   * from user wording. The manager rebuilds the session when the clamp
   * turns on or off, so the flag follows the same lifetime as the tools.
   */
  forceDirectFileWork?: boolean;
  /**
   * The chat manager clamped this turn to ONE pre-resolved action (the
   * exact-craftbook route). A local provider may stop generating the moment
   * that call is complete in the stream: nothing written after it can be
   * acted on, and a model that keeps going after an unfamiliar call shape
   * can loop until max_tokens. Same lifetime as the clamp — the manager
   * rebuilds the session when it flips. See `complete-tool-call.ts`.
   */
  singleToolCallTurn?: boolean;
  /**
   * Local bridge-backed providers: a successful call to one of these
   * action tools is the terminal outcome for the turn. The provider
   * appends one short closing line (preferably from `closingArg`) and
   * returns without asking the model to analyze the completed action
   * again. Used by lean game projects (`make_move`) where a continuation
   * generation otherwise invites stale-board rumination and repeat moves.
   */
  terminalToolPolicy?: TerminalToolPolicy;
  /**
   * Authoritative expected output path paired with
   * {@link forceDirectFileWork}. This is especially important when the
   * clamp came from `ChatSession.expectedDeliverable` rather than wording
   * in the latest message.
   */
  directFileWorkTargetPath?: string;
  /**
   * Persists images returned by MCP tool calls (Playwright screenshots,
   * etc.) into the project's artifacts/ tree. When set, the bridge calls
   * this for any tool result with image content blocks and includes the
   * resulting paths on the `images` field of the `ToolCallEvent`. The
   * UI then renders thumbnails inline with the tool row. Built per-
   * session by ChatManager so the persister knows which (project,
   * session) it's writing into.
   */
  imagePersister?: import('./tool-image-persister.js').ToolImagePersister;
  /**
   * Optional persister for audio content blocks (`synthesize_speech`
   * outputs). Mirrors `imagePersister` exactly.
   */
  audioPersister?: import('./tool-audio-persister.js').ToolAudioPersister;
  /**
   * Optional callback for persisting large tool outputs to the
   * session's project artifacts tree. Used by the outboard-storage
   * MCP wrapper to turn a 200KB browser_snapshot into a summary +
   * path so the model isn't forced to swallow the whole payload.
   * Bridge-agnostic: works from any wrapper on any bridge (including
   * third-party MCPs that don't host `write_artifact`). When unset,
   * the wrapper degrades to the existing capToolOutput truncation
   * path. The chat manager wires this to
   * `store.writeProjectArtifact(record.projectId, ...)`.
   */
  artifactPersister?: (relPath: string, content: string) => Promise<void>;
  /**
   * Active-project preview hosting available to MCP wrappers. Used by the
   * Playwright argument adapter to rewrite workspace `file:` navigation onto
   * the daemon's short-lived, capability-scoped preview URL.
   */
  workspacePreview?: {
    projectId: string;
    root: string;
    /** Dedicated loopback origin that serves only capability-scoped previews. */
    origin?: string;
    /**
     * Restrict Playwright to the local-preview tool surface and network
     * boundary. Set whenever External services are disabled.
     */
    localOnly?: boolean;
    createUrl: (relativePath: string) => Promise<string | null>;
  };
  /**
   * Craftbook hooks active for the session — the `hooks?: HookSpec[]`
   * list from the session's active craftbook(s). The MCP bridge
   * installs these via `installCraftbookHooks` at session start and
   * consults them before every tool call. Multiple craftbooks may
   * each contribute hooks; the entries are tagged with their owning
   * craftbookId.
   */
  craftbookHooks?: Array<{
    craftbookId: string;
    hooks: import('@bendyline/gezel').HookSpec[];
  }>;
  /**
   * Runs a hook script when the bridge needs a decision. Receives the
   * active hook plus the tool-call context (name + args; result for
   * PostToolUse) and returns `{ decision: 'allow'|'deny'|'ask',
   * message? }`. Wired by ChatManager from the ScriptRunner.
   */
  hookRunner?: import('./mcp-bridge.js').HookRunner;
  /**
   * Surfaces an "ask" hook decision to the user. Returns true to
   * proceed, false to cancel (treated as deny).
   */
  hookAskUser?: (info: {
    phase: import('@bendyline/gezel').HookPhase;
    toolName: string;
    message: string;
    craftbookId: string;
    hookLabel?: string;
  }) => Promise<boolean>;
  /**
   * Audit sink for hook decisions. Fires once per hook that ran,
   * regardless of decision. ChatManager pipes this to HistoryManager
   * as `tool.gated` events.
   */
  onHookDecision?: (info: {
    phase: import('@bendyline/gezel').HookPhase;
    toolName: string;
    decision: 'allow' | 'deny' | 'ask';
    message?: string;
    craftbookId: string;
    hookLabel?: string;
  }) => void | Promise<void>;
  /**
   * Active craftbook step context, threaded through from ChatManager
   * for anti-spin guidance. Local providers' abort-message builders
   * use this to surface "the right next call is `run_script({ name:
   * '<onExitScriptName>' })`" instead of pointing the model at
   * generic `write_file`/`assign_task` candidates that are wrong for
   * mid-craftbook work. Unset for sessions not scoped to a task with
   * an active step.
   */
  activeCraftbookStep?: ActiveCraftbookStep;
  /**
   * Capability tier of the model running this session, derived from
   * the model id's parameter count + the provider. MCP wrappers
   * branch on this so a 4B local gets relaxed schemas + auto-filled
   * defaults while a 70B local or a cloud frontier model keeps the
   * strict surface frontier models prefer. See
   * `chat/local-model-tier.ts`.
   *
   *   - 'tiny':   <5B, or unknown size on a local provider
   *   - 'small':  5–11.99B
   *   - 'medium': 12–44.99B
   *   - 'large':  ≥45B (local) — top of what an enthusiast runs locally
   *   - 'cloud':  any cloud provider — effectively running on >512GB
   *               of GPU memory we don't pay for
   *
   * When unset, wrappers treat as 'large' (least invasive — no schema
   * relaxation, no localHints).
   */
  modelTier?: 'tiny' | 'small' | 'medium' | 'large' | 'cloud';
  /**
   * True when the session's gezel is the currently designated Meester
   * (`config.meesterGezelId === record.gezelId`). Threaded into the MCP
   * bridge so wrappers configured with `meesterOnly: true` (the
   * Gemma-26B single-tool-per-turn guard, for example) can short-
   * circuit on voorman and worker sessions instead of firing
   * everywhere. Defaults to false when unset; provider implementations
   * that don't run an MCP bridge can ignore this.
   */
  isMeester?: boolean;
  /**
   * Resolved per-model behavior profile, threaded through to the MCP
   * bridge so per-session wrappers can compose with the static ones.
   * Built once in `ChatManager.buildSessionOpts` via `resolveProfile`,
   * carried alongside `modelTier` for the lifetime of the session.
   *
   * Provider implementations that don't run an MCP bridge (Copilot,
   * Anthropic CLI, Codex CLI) ignore this. For Ollama / llama-cpp /
   * mlx, the bridge consults `profile.behaviors` to assemble the
   * per-session wrapper list and to decide whether to run the
   * Gemma special-token salvage / preamble fold / ramble detector.
   */
  profile?: ResolvedModelProfile;
  /**
   * Resolved per-model tuning (sampling, reasoning, structured-output,
   * tool-choice). Built once in `ChatManager.buildSessionOpts` from the
   * gezel-frontmatter `tuning` override on top of the catalog manifest
   * `tuning` defaults, with `samplingWhenThinking` folded in when
   * reasoning is engaged. Providers consume via `applyTuning(body,
   * tuning, MAP)` at request-build time. Unset → providers fall back
   * to their built-in defaults.
   */
  tuning?: import('../model-profile/index.js').ResolvedTuning;
  /**
   * Copilot-only: unless explicitly false, the provider installs a
   * permission handler that denies every tool call except MCP / custom-tool
   * kinds, forcing the model through our MCP surface instead of the SDK's
   * built-in bash / web_fetch / file-edit / grep. Other providers ignore this.
   */
  sandboxCopilot?: boolean;
  /**
   * Fires when sandbox mode denies a Copilot built-in tool call. The
   * ChatManager uses this to record `copilot.builtin.denied` history
   * events so sandbox-mode sessions keep an audit trail the SDK's
   * in-subprocess tools otherwise bypass. Only fires when the effective
   * Copilot sandbox is enabled and the Copilot provider is in use.
   */
  onSandboxDenial?: (info: {
    kind: string;
    toolName?: string;
    fileName?: string;
    fullCommandText?: string;
  }) => void | Promise<void>;
}

export interface ToolCallEvent {
  name: string;
  argKeys: string[];
  /**
   * Shallow copy of the args the tool was called with. Kept optional because
   * not every caller of the bridge populates it, and history logging only
   * uses `argKeys` anyway. Chat-stream forwarding uses this to pluck file
   * paths for the References panel.
   */
  args?: Record<string, unknown>;
  /**
   * Wall-clock start of the tool invocation (epoch ms). Optional so
   * third-party producers keep working; ChatManager falls back to
   * `now - durationMs`, which is exact for any producer that computes
   * durationMs at fire time.
   */
  startedAtMs?: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  /**
   * Text returned by the tool when the provider exposes it. Producers must
   * redact known secrets before firing the event. ChatManager bounds this
   * into a short full response or a deterministic summary before persistence.
   */
  resultText?: string;
  /** True when the bridge clipped the provider-visible text after the MCP tool returned. */
  deliveredResultTruncated?: boolean;
  /**
   * Image artifacts the tool returned (Playwright `browser_*` screenshots,
   * etc.) — already written to disk by the bridge's image persister, paths
   * are relative to the project's artifacts/ root. Forwarded onto both
   * the SSE tool segment (live UI) and the persisted ChatMessageToolCall
   * (session reload).
   */
  images?: Array<{ path: string; mimeType: string }>;
  /**
   * Audio artifacts the tool returned (synthesize_speech narrations) —
   * persisted parallel to images. Same forwarding shape onto SSE tool
   * segment + the persisted ChatMessageToolCall.
   */
  audios?: Array<{
    path: string;
    mimeType: string;
    durationSeconds?: number;
    voice?: string;
  }>;
  /**
   * MCP `structuredContent` returned by the tool. Layer 4 surgical-edit
   * tools (`replace_in_file`, `apply_patch`, `insert_at_marker`) populate
   * `{diff, addedLines, removedLines, diffTruncated?}` here. The chat
   * manager copies known fields onto ChatMessageToolCall for the UI
   * inline diff viewer. Other tools can populate other fields; the
   * bridge passes them through untouched.
   */
  structuredContent?: Record<string, unknown>;
}

/** Provider-specific state we persist after each turn so the session can resume. */
/**
 * Live launch provenance of a supervised native engine — see
 * `LLMProvider.engineLaunchSnapshot`. `diagnostics` carries the launch
 * payload the spawner attached (the `launch {...}` log line fields:
 * `model`, `contextPerSlot`, `contextTotal`, `slots`, `kvCacheType`,
 * `backend`, …), safe request-independent facts only.
 */
export interface EngineLaunchSnapshot {
  pid?: number;
  /** Epoch ms when the current child was spawned. */
  startedAt: number;
  diagnostics?: Record<string, string | number | boolean>;
}

export interface ModelInfo {
  id: string;
  name: string;
  supportsReasoning?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  contextWindow?: number;
  /**
   * Whether the model supports structured tool / function calling. Ollama
   * sets this via a family-prefix allowlist so the UI can warn when a gezel
   * is pinned to a non-tool-capable local model.
   */
  supportsTools?: boolean;
  /** Short human-friendly size hint (Ollama's `details.parameter_size`). */
  parameterSize?: string;
}

import type { ProviderQueue } from './queue.js';

/**
 * Thrown by `LLMProvider.resumeSession` when the underlying provider can't
 * restore the given session (Copilot session expired, etc.). Caller should
 * fall back to a fresh `createSession` and surface a warning.
 */
export class SessionResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionResumeError';
  }
}

/**
 * Thrown by a provider's `createSession` (or first `sendAndWait`) when
 * `externalTools` was set on the session opts but the provider doesn't
 * yet implement external tool calling. The route maps this to
 * `400 tools_not_supported_for_provider` so the caller knows the
 * gezel's backend can't honor the request and what to do (pick a
 * different provider, or omit `tools`).
 */
export class ExternalToolsUnsupportedError extends Error {
  constructor(providerName: string) {
    super(`Provider "${providerName}" does not support external tool calling.`);
    this.name = 'ExternalToolsUnsupportedError';
  }
}

/**
 * Thrown when a request names a local-engine model id that isn't
 * installed on this machine. Routes map it to `404 model_not_found`.
 * Deliberately NOT auto-resolved by downloading: a chat request must
 * never trigger a multi-GB pull — the job-based `POST /v1/models/ensure`
 * endpoint exists for explicit, consented installs.
 */
export class ModelNotInstalledError extends Error {
  readonly providerName: string;
  readonly modelId: string;
  constructor(providerName: string, modelId: string) {
    super(
      `Model "${modelId}" is not available locally for provider "${providerName}". List local models via GET /v1/models, or download it first via POST /v1/models/ensure.`,
    );
    this.name = 'ModelNotInstalledError';
    this.providerName = providerName;
    this.modelId = modelId;
  }
}

/**
 * Context describing one would-be batch member, passed to
 * {@link BatchCapability.admit} so an engine can make a live headroom
 * decision (per-slot context budget, KV-memory ceiling). Round 1 only
 * populates lane + ids; `estPromptTokens` is wired in the MLX static-
 * batching phase, when per-slot context budgeting starts to matter.
 */
export interface BatchAdmitCtx {
  lane: 'interactive' | 'background';
  sessionId?: string;
  gezelId?: string;
  estPromptTokens?: number;
}

/**
 * How many sequences a provider's engine can generate concurrently, plus
 * an optional live admission check. See {@link LLMProvider.batch}.
 */
export interface BatchCapability {
  /**
   * Sequences this engine can generate truly concurrently right now.
   * 1 = serial (MLX today). N = N KV slots / batch width (llama.cpp
   * `--parallel N`). The queue's effective concurrency and the MLX
   * engine-request gate both read this.
   */
  readonly maxConcurrency: number;
  /**
   * Optional live headroom check — return false to refuse adding
   * `candidate` to the current in-flight set. Defaults to "admit while
   * inflight.length < maxConcurrency" when omitted.
   */
  admit?(candidate: BatchAdmitCtx, inflight: readonly BatchAdmitCtx[]): boolean;
}

export interface LLMProvider {
  readonly supportsImageInput?: boolean;
  readonly name: ProviderName;
  /**
   * The model calls tools through its own API (Apple's on-device model):
   * tool definitions travel outside the prompt, so a minimal-footprint prompt
   * keeps the tool conduct and task step instead of saying "no tools".
   */
  readonly nativeTools?: boolean;
  /** Boot the underlying client / authenticate. Called lazily. */
  initialize(signal?: AbortSignal): Promise<void>;
  /** Tear down everything owned by this provider. */
  shutdown(): Promise<void>;
  createSession(opts: SessionOpts): Promise<LLMSession>;
  /**
   * Resume a previously-saved session by its provider-assigned id. Optional —
   * not every provider exposes this (OpenAI uses SessionOpts.openaiPreviousResponseId
   * instead). Should throw `SessionResumeError` on expiry / not-found.
   */
  resumeSession?(sessionId: string, opts: SessionOpts): Promise<LLMSession>;
  /** Enumerate models this provider currently offers. May hit the network. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /**
   * The model id this provider would use right now if a session
   * doesn't override it. For local providers this is the
   * auto-resolved on-disk model when the user hasn't picked one in
   * Settings → AI; for cloud providers it's typically the id pulled
   * from `config.defaultModel.<provider>`. Synchronous because it
   * reads provider-internal state captured at construction.
   *
   * Used by the chat manager to recover an effective model id for
   * tier classification when neither `record.model` nor
   * `config.defaultModel.<provider>` is set — without this, sessions
   * on auto-picked local models classify as `tier:tiny` (their
   * model id flows to the tier resolver as `undefined`) and the
   * prompt-tuning hints land mis-targeted.
   *
   * Returns undefined when the provider has no effective id to
   * surface (e.g. external base URL mode where the catalog isn't
   * known, or pre-init state).
   */
  getEffectiveModelId?(): string | undefined;
  /**
   * Effective per-turn context window the provider actually gives a
   * session. Supervised local engines may lower the configured/model-native
   * value at launch time to fit live RAM + VRAM; callers that size prompts
   * or tool surfaces must use this post-admission number rather than the
   * requested ceiling.
   */
  getContextWindow?(): number | undefined;
  /**
   * Resolve the effective context window before a session prompt is built.
   *
   * Native providers usually know this synchronously via
   * {@link getContextWindow}. A broker-backed provider must first ask the
   * broker to admit/load the selected model, because live RAM/VRAM pressure
   * can clamp the configured window. Implementations may briefly cache the
   * result because ChatManager can call this twice while opening one session,
   * but must not retain it across later starts where policy or pressure may
   * have changed.
   */
  prepareContextWindow?(model?: string, signal?: AbortSignal): Promise<number | undefined>;
  /**
   * Launch provenance of the provider's LIVE engine process — pid, start
   * time, and the request-independent launch facts (granted context
   * window, slots, KV dtype, backend). Supervised native providers
   * delegate to their supervisor; undefined when no process is up or the
   * provider has no supervised engine (cloud, external base URL). Powers
   * `/api/system/diagnostics` `localEngines` and Settings → About.
   */
  engineLaunchSnapshot?(): EngineLaunchSnapshot | undefined;
  /**
   * Broker-ledger reservation this provider's engine actually needs:
   * resident weights plus KV at the granted context window and cache
   * mode, computed by the build-time admission pass. The pool builder
   * prefers this over catalog/weights-multiplier estimates so
   * co-residency admission sees KV — a dense small model's KV can exceed
   * its weights (qwen3.5-4b at 64K). Undefined when the provider could
   * not price its launch (external base URL, unreadable weights).
   */
  plannedReservationBytes?(): number | undefined;
  /**
   * The concurrency/priority gate this provider's sessions acquire
   * from before invoking the underlying API. Sessions produced by
   * {@link createSession} call `queue.acquire()` in their
   * {@link LLMSession.sendAndWait} and release on completion. Callers
   * (ChatManager, TaskRunner, nudge-suppression checks) can read
   * `queue.snapshot()` for backpressure. Optional — providers that
   * don't gate (e.g. MockProvider) return `undefined`.
   */
  readonly queue?: ProviderQueue;
  /**
   * Batched/continuous-generation capability of this provider's engine.
   * Present (with `maxConcurrency > 1`) when the engine can generate
   * multiple sequences truly concurrently — e.g. llama.cpp launched with
   * `--parallel N`. Absent, or `maxConcurrency: 1`, means serial (today's
   * MLX). The dispatch layer reads `batch?.maxConcurrency ?? 1` to size
   * this provider's queue and (for MLX) the width of its engine-request
   * gate — the single knob that flips an engine from serial to batched
   * with no scheduler changes. Optional — providers that never batch
   * (cloud handles its own batching; MockProvider) omit it.
   */
  readonly batch?: BatchCapability;
  /**
   * Optional embeddings endpoint. Used by `POST /v1/embeddings` (OpenAI-
   * compatible). Returning `undefined` (or omitting this method) signals
   * the provider doesn't support embeddings; the route maps that to a
   * `400 embeddings_not_supported`.
   *
   * `input` may be a single string or an array of strings — the route
   * passes through whatever the OpenAI client sent. `model` is the
   * caller's preferred embedding model id (e.g. `text-embedding-3-small`
   * for OpenAI, a local model name for llama-cpp/mlx).
   *
   * Returns vectors in caller order, plus per-call token usage. The
   * route wraps this into the OpenAI envelope shape.
   */
  createEmbedding?(input: EmbeddingInput): Promise<EmbeddingResult>;
  /**
   * True when this provider implements the
   * {@link SessionOpts.externalTools} pathway — i.e. caller-supplied
   * tool definitions can be advertised to the model and captured calls
   * surface via {@link LLMSession.capturedToolCalls}. The route checks
   * this at request time and returns
   * `400 tools_not_supported_for_provider` when the caller's request
   * carries tools but the provider doesn't.
   *
   * Today: MockProvider sets this; cloud + local providers leave it
   * unset until the external-tools path lands per-provider.
   */
  readonly supportsExternalTools?: boolean;
  /**
   * True when sessions honor {@link SessionOpts.priorMessages} — i.e. a
   * fresh session seeded with explicit history actually replays that
   * history to the model. Stateless surfaces (`/v1/chat/completions`,
   * the Ollama facade) check this: when a provider leaves it unset
   * (Copilot, whose SDK owns history server-side per session id, and
   * the CLI providers, whose subprocess owns its own transcript), the
   * route flattens the prior turns into the prompt text instead of
   * passing `priorMessages` — otherwise the conversation history is
   * silently dropped and every turn looks like the first.
   */
  readonly supportsPriorMessages?: boolean;
}

export interface EmbeddingInput {
  input: string | string[];
  model?: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  usage: {
    inputTokens: number;
  };
}
