/**
 * Small MCP client used by the OpenAI provider so that local stdio MCP
 * servers (like @bendyline/gezel-mcp) remain available when the agent is
 * routed through OpenAI's Responses API. OpenAI's native MCP integration
 * is HTTP-only; we run the stdio protocol ourselves and surface tool
 * results as function-call outputs.
 */

import { type HookPhase, type HookResult, type HookSpec, createLogger } from '@bendyline/gezel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ResolvedBehaviorEntry, ResolvedModelProfile } from '../model-profile/types.js';
import {
  type McpToolWrapper,
  type McpToolWrapperContext,
  selectWrappersFor,
} from './mcp-wrappers/index.js';
import type { ToolAudioPersister } from './tool-audio-persister.js';
import type { ToolImagePersister } from './tool-image-persister.js';
import type { ToolCallEvent } from './types.js';

/**
 * Active hook entry. Combines a HookSpec with the craftbook that
 * installed it so audit events can attribute the decision and the UI
 * can surface "which craftbook blocked this?" Multiple craftbooks may
 * be active simultaneously; their hook lists concatenate.
 */
export interface ActiveHook {
  spec: HookSpec;
  craftbookId: string;
  /** Compiled regex from `spec.matcher`. */
  matcher: RegExp;
}

/**
 * Called by the bridge to actually run a hook script. Wired by
 * ChatManager from the ScriptRunner so the bridge stays decoupled
 * from the scripts subsystem. Receives the active hook's script ref +
 * the tool-call context (name + args, plus the post-call result for
 * PostToolUse).
 */
export type HookRunner = (
  hook: ActiveHook,
  ctx: {
    phase: HookPhase;
    toolName: string;
    args: Record<string, unknown>;
    result?: { text: string; isError: boolean };
  },
) => Promise<HookResult>;

const log = createLogger('mcp-bridge');

/**
 * What `McpBridge.start()` needs to bring up a session. Two flavors:
 *
 *   - **stdio** (default when `kind` is omitted) — spawn a local
 *     subprocess and speak MCP over its pipes. The historical shape
 *     and what every existing call site uses.
 *   - **http** — connect to a hosted MCP server over HTTP (Streamable
 *     HTTP for new servers, SSE for older ones). Headers (auth tokens,
 *     custom keys) come from resolved toolset config the same way
 *     subprocess env vars do for stdio.
 *
 * The discriminator is `kind`; a missing `kind` is treated as
 * `'stdio'` so legacy `{command, args, env}` callers keep working.
 */
export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec;

export interface StdioMcpServerSpec {
  kind?: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HttpMcpServerSpec {
  kind: 'http';
  /**
   * `streamable-http` is the current MCP HTTP transport (one URL,
   * POST for messages, optional GET for SSE stream + auto-reconnect).
   * `sse` is the older two-endpoint variant — kept for back-compat
   * with registry entries that still declare it.
   */
  transport: 'streamable-http' | 'sse';
  url: string;
  /**
   * Headers attached to every request. Bearer tokens, API keys, etc.
   * Resolved from toolset config + secrets at session-build time.
   */
  headers: Record<string, string>;
}

export function isStdioSpec(spec: McpServerSpec): spec is StdioMcpServerSpec {
  return spec.kind === undefined || spec.kind === 'stdio';
}

export function isHttpSpec(spec: McpServerSpec): spec is HttpMcpServerSpec {
  return spec.kind === 'http';
}

/**
 * Hard cap on the size of a single tool-output text block fed back to the
 * model. ~80k chars ≈ 20k tokens at the 4-chars/token heuristic — generous
 * enough for any reasonable file read or search result, but a firm wall
 * against pathological cases like `fetch_url` on a modern web page dumping
 * hundreds of KB of inlined HTML/JS/CSS that would blow the context window
 * on a single tool-call iteration.
 *
 * We truncate at the character boundary and append a footer telling the
 * model what happened, so it can reason about the gap instead of assuming
 * it saw everything. Applied universally — providers without server-side
 * history management (Ollama, llama-cpp) would silently choke; providers
 * with it (OpenAI, Copilot) would just silently waste tokens.
 */
export const MAX_TOOL_OUTPUT_CHARS = 80_000;

/**
 * "Useful slice" floor — when the adaptive budget is at least this
 * many chars, callers get a normal truncation footer ("re-run with
 * a more specific request if you need the rest"). Below this, the
 * floor logic in {@link capToolOutput} switches to a stronger
 * "context window is nearly full, refine your request or save to
 * artifacts" footer because at sub-8K the result is too clipped to
 * be the basis for normal follow-up work.
 *
 * Used as a *threshold* for footer wording — NOT as an upward clamp.
 * The previous behavior clamped UP to this floor unconditionally,
 * which could push the transcript past `numCtx` on tight-context
 * sessions. See the absolute hard minimum
 * {@link CAP_TOOL_OUTPUT_HARD_FLOOR} for the actual lower bound.
 */
export const MIN_TOOL_OUTPUT_CHARS = 8_000;

/**
 * Absolute hard floor for {@link capToolOutput} — every tool result
 * delivers at least this many chars (~125 tokens) so the model has
 * something to react to. Below this we'd be better off returning a
 * structured "context exhausted, refine" sentinel instead of a
 * meaninglessly clipped output. 500 chars covers a small JSON
 * error payload or the first sentence of a longer response.
 *
 * Distinct from {@link MIN_TOOL_OUTPUT_CHARS} (the "useful slice"
 * threshold for footer wording).
 */
export const CAP_TOOL_OUTPUT_HARD_FLOOR = 500;

/**
 * Leading marker every script/exec tool stamps on a FAILED run — see the
 * `✗ <label> failed (exit N)` / `✗ <label> timed out` shape emitted by
 * gezel-mcp's run_nodejs_script / run_npx / npm_install / extract_archive.
 * On these, the diagnostic (stderr) sits at the END of the body, so
 * {@link capToolOutput} preserves the tail instead of head-only truncating.
 */
const EXECUTION_FAILURE_MARKER = /✗[^\n]*(?:failed \(exit|timed out)/;

/**
 * Default per-call timeout (ms) for MCP `tools/call` requests. The MCP
 * SDK's default is 60s, which is far too tight for our agentic
 * workload — `npm_install` of a moderate dep tree, a `run_playwright_script`
 * that waits on a real browser, or a `generate_image` cold-start can
 * legitimately blow past a minute. 5 minutes is a safe floor for
 * "ordinary" tools; outliers get explicit overrides in {@link TOOL_TIMEOUT_MS}.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-tool timeout overrides. Picked empirically:
 *
 * - `generate_image`: 30 min — first call cold-loads ~5 GB of weights
 *   into Metal, compiles kernels, then runs the full diffusion loop.
 *   On a warm engine the same call is 10–60 s, but a cold cache plus
 *   slow disk can easily blow past 5 min.
 * - `run_playwright_script`: 15 min — a real browser session can exercise
 *   long flows; the script itself manages its own timeouts internally.
 * - `npm_install`: 10 min — a clean install on a heavy dep tree (Next +
 *   Playwright + types) can cross the 5-min default on slow networks.
 * - `extract_archive`, `run_nodejs_script`, `run_npx`: 10 min — same shape.
 *
 * Read-only tools (`readFile`, `search_history`, etc.) inherit the
 * default; clamping them tighter doesn't gain anything.
 */
export const TOOL_TIMEOUT_MS: Record<string, number> = {
  generate_image: 30 * 60 * 1000,
  // `generate_video`: 60 min — first call provisions the Python venv
  // (torch + diffusers, multi-minute on a cold machine), cold-loads the
  // model, then runs a long multi-frame diffusion loop. Far slower than
  // image generation, especially on the CPU fallback.
  generate_video: 60 * 60 * 1000,
  run_playwright_script: 15 * 60 * 1000,
  run_nodejs_script: 10 * 60 * 1000,
  run_npx: 10 * 60 * 1000,
  npm_install: 10 * 60 * 1000,
  extract_archive: 10 * 60 * 1000,
  render_image: 10 * 60 * 1000,
  // `ask_gezel` / `ask_specialist` have an internal `timeoutMs`
  // parameter clamped to [10 s, 30 min] and default 5 min. When the
  // bridge's transport timeout matches the tool's internal timeout
  // exactly (both default to 5 min), the SDK can race the tool and
  // throw `-32001: Request timed out` before the tool surfaces its
  // own `{outcome: 'error', reason: 'timeout'}` structured result —
  // which then bypasses the wrapper postProcess/postProcessError
  // path entirely. Set the transport ceiling strictly above the
  // tool's maximum so the tool always wins the race and the wrapper
  // layer gets a normal `isError` result to drain its state from.
  ask_gezel: 35 * 60 * 1000,
  ask_specialist: 35 * 60 * 1000,
};

export function timeoutForTool(name: string): number {
  // Role-typed consultations (`consult_developer`, `consult_reviewer`, …)
  // are generated dynamically, so they cannot all live as literal keys in
  // TOOL_TIMEOUT_MS. They use the same synchronous ask pipeline and the same
  // 30-minute inner hard cap as ask_gezel / ask_specialist; keep the MCP
  // transport strictly above that cap so it never wins the timeout race.
  if (name.startsWith('consult_')) return 35 * 60 * 1000;
  return TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Truncate a tool output and append a footer describing the drop.
 * Returns the input unchanged when it fits.
 *
 * Bounds:
 *
 * - **Lower** — {@link CAP_TOOL_OUTPUT_HARD_FLOOR} (500 chars). When
 *   the caller's `maxChars` falls below this, we deliver 500 chars
 *   plus a stronger "context window is nearly full" footer that
 *   tells the model to refine its request or save to artifacts.
 *   The previous floor (8K) clamped UP unconditionally, which could
 *   push the running transcript past `numCtx` on tight-context
 *   sessions — exactly the cliff a model hits when a chain of tool
 *   calls fills the working window.
 *
 * - **Upper** — {@link MAX_TOOL_OUTPUT_CHARS} (80K chars) absolute
 *   safety cap. When `numCtxTokens` is supplied, the upper bound
 *   tightens to `numCtxTokens × CONTEXT_WORKING_RATIO × 4` so the
 *   ceiling tracks the model's actual context window. A 4K-context
 *   model gets ~12K chars max regardless of what `maxChars` says;
 *   a 32K-context model still gets the 80K absolute. Without this,
 *   a caller bypassing {@link computeToolBudgetChars} on a small
 *   model would silently overflow.
 *
 * Exported for tests and for provider-side double-capping
 * (belt-and-braces for tool outputs that bypass the bridge).
 */
export function capToolOutput(
  text: string,
  maxChars: number = MAX_TOOL_OUTPUT_CHARS,
  opts?: { numCtxTokens?: number },
): string {
  const numCtxCeiling =
    opts?.numCtxTokens !== undefined && opts.numCtxTokens > 0
      ? Math.floor(opts.numCtxTokens * CONTEXT_WORKING_RATIO * 4)
      : MAX_TOOL_OUTPUT_CHARS;
  const ceiling = Math.min(MAX_TOOL_OUTPUT_CHARS, numCtxCeiling);
  const clamped = Math.min(Math.max(maxChars, CAP_TOOL_OUTPUT_HARD_FLOOR), ceiling);
  if (text.length <= clamped) return text;
  // Execution failures (`✗ … failed (exit N)` / `… timed out`, stamped by
  // run_nodejs_script / run_npx / npm_install / extract_archive) put the
  // exit code + stderr — the bytes the model needs to FIX the failure —
  // at the END of the body, after a possibly-huge stdout. A plain
  // head-keep truncation drops exactly those bytes, leaving the model to
  // blind-debug a failure it can't see (the data-wrangle eval loop). When
  // the output is failure-shaped, keep the head (exit line + stdout start)
  // AND the error tail, dropping the middle, within the same budget.
  if (EXECUTION_FAILURE_MARKER.test(text.slice(0, 200))) {
    const tailChars = Math.min(Math.floor(clamped * 0.45), 6000);
    const headChars = clamped - tailChars;
    if (headChars > 0 && tailChars > 0) {
      const head = text.slice(0, headChars);
      const tail = text.slice(text.length - tailChars);
      const middleDropped = text.length - headChars - tailChars;
      return `${head}\n\n…[middle truncated: ${middleDropped.toLocaleString('en-US')} chars dropped — the error tail below is preserved so you can diagnose the failure]…\n\n${tail}`;
    }
  }
  const dropped = text.length - clamped;
  // Footer wording bifurcates on whether the cap was set by a
  // tight context (sub-MIN budget) vs the normal "useful slice"
  // case. Tight-context guidance points the model at the artifacts
  // drawer because the conversation can't absorb more text either
  // way; normal guidance just nudges toward a more specific request.
  const isContextTight = maxChars < MIN_TOOL_OUTPUT_CHARS;
  const guidance = isContextTight
    ? 'context window is nearly full — re-ask with a more specific request, or save the output to an artifact and read it in chunks'
    : 'context window protected — re-run with a more specific request if you need the rest';
  return `${text.slice(0, clamped)}\n\n…[tool output truncated: ${dropped.toLocaleString('en-US')} additional chars dropped; ${guidance}]`;
}

/**
 * Fraction of `numCtx` reserved for the running transcript + tool
 * outputs. The remaining 25% covers the assistant's response plus
 * a little slack for the next user message. Lower ratios risk
 * clipping mid-reply; higher ones feel fine until someone writes a
 * long answer and the provider returns a `finish_reason: length`.
 */
const CONTEXT_WORKING_RATIO = 0.75;

/**
 * Compute how many chars of tool output can fit in the remaining
 * context budget for this turn. Inputs are in *tokens* for numCtx
 * (the provider-advertised window) and *chars* for the prompt so
 * far (cheap estimator that every session already exposes). Result
 * is in chars, clamped by the bridge's own floor/ceiling before
 * slicing.
 *
 *   usableTokens   = numCtx × 0.75
 *   transcriptTok  = promptChars / 3.2              (dense-leaning)
 *   remainingTok   = usableTokens − transcriptTok − 512 (reserve)
 *   budgetChars    = remainingTok × 2.8
 *
 * The two ratios are deliberately ASYMMETRIC and conservative. The old
 * symmetric `/4 … ×4` pair assumed 4 chars/token on both sides; dense
 * tool output (catalog JSON, listings) runs ~2.6–3.0 chars/token, so
 * the estimator under-counted the transcript AND over-sized the result
 * budget — the "truncated" payload then overflowed n_ctx by a few
 * hundred tokens and the send died with context-overflow (wild-caught
 * on 4 books in the 2026-07-24 craftbook matrix, overshoots of
 * 111–919 tokens on a 65,536 window). The fixed 512-token reserve
 * absorbs message framing and chat-template overhead the char
 * estimator never sees.
 *
 * Shared by llama-cpp and Ollama providers so they compute the cap
 * identically. Copilot / OpenAI manage history server- or SDK-side;
 * they rely on the fixed `MAX_TOOL_OUTPUT_CHARS` ceiling instead.
 */
export function computeToolBudgetChars(numCtx: number, promptChars: number): number {
  const usableTokens = Math.floor(numCtx * CONTEXT_WORKING_RATIO);
  const transcriptTokens = Math.ceil(promptChars / 3.2);
  const remainingTokens = Math.max(0, usableTokens - transcriptTokens - 512);
  return Math.floor(remainingTokens * 2.8);
}

/**
 * Translate the resolved profile's behaviors into the wrapper list
 * the bridge can call. Each `Behavior.mcpWrapper` is either a static
 * wrapper or a `(config) => wrapper` factory; this helper unifies
 * both shapes. The wrapper's own `matches(spec)` still gates whether
 * it actually decorates this bridge — gezel-mcp-only wrappers won't
 * fire on a Playwright bridge.
 *
 * Behaviors without an `mcpWrapper` (most of them — they're prompt
 * or post-turn behaviors) are skipped silently.
 */
function behaviorWrappersFor(
  profile: ResolvedModelProfile | undefined,
  spec: McpServerSpec,
): McpToolWrapper[] {
  if (!profile) return [];
  const out: McpToolWrapper[] = [];
  for (const entry of profile.behaviors) {
    const w = entry.behavior.mcpWrapper;
    if (!w) continue;
    const wrapper = typeof w === 'function' ? w(entry.config) : w;
    let applies = true;
    try {
      applies = wrapper.matches(spec);
    } catch {
      applies = false;
    }
    if (applies) out.push(wrapper);
  }
  return out;
}

/** Shape of an OpenAI function tool (Responses API format). */
export interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Shape of an Anthropic Messages API tool. Anthropic's tool surface is the
 * same JSON schema we already keep for OpenAI tools, just rebadged: `name`
 * + `description` + `input_schema` in place of OpenAI's `parameters`. We
 * reshape on-the-fly from the existing `tools` list so wrappers/relaxers
 * apply uniformly.
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class McpBridge {
  private client: Client | null = null;
  private tools: OpenAIFunctionTool[] = [];
  private toolNameSet = new Set<string>();
  /**
   * Post-processing wrappers selected for the current server spec at
   * `start()` time. Run in registration order on every successful tool
   * result (before redaction + truncation), to shape upstream MCP
   * responses for smaller models. See `mcp-wrappers/`.
   */
  private wrappers: readonly McpToolWrapper[] = [];
  private wrapperCtx: McpToolWrapperContext | null = null;
  /** Fires after every tool invocation (success or failure). */
  onToolCall?: (info: ToolCallEvent) => void | Promise<void>;
  /**
   * Optional persister that writes any image content blocks returned by a
   * tool into the project's artifacts/ tree. When set, the bridge resolves
   * the saved paths and includes them in the `images` field of the
   * `ToolCallEvent` it emits — letting the UI render thumbnails inline
   * with the tool row. The base64 bytes are still returned to the
   * provider via callToolRich() so vision-capable models can also see
   * the image as an `input_image` follow-up.
   */
  imagePersister?: ToolImagePersister;
  /**
   * Optional persister that writes any audio content blocks returned
   * by a tool into the project's artifacts/ tree. Mirrors
   * `imagePersister`; when set, the persisted paths land on the
   * `audios` field of the `ToolCallEvent` so the UI renders an
   * inline audio row alongside the tool call.
   */
  audioPersister?: ToolAudioPersister;
  /**
   * Optional callback for wrappers that need to persist large tool
   * outputs to the project's artifacts/ tree (e.g. the
   * outboard-storage wrapper that turns a 200KB browser_snapshot into
   * a summary + path). Bridge-agnostic: third-party MCP bridges
   * (Playwright et al.) don't have `write_artifact` registered, so
   * the wrapper can't go through `ctx.callTool('write_artifact')` —
   * the persister provides a direct hop into the Store from any
   * bridge. Set per-session by the chat manager (mirrors
   * `imagePersister`); when unset, the wrapper degrades to the
   * existing capToolOutput truncation path.
   */
  artifactPersister?: (relPath: string, content: string) => Promise<void>;
  /**
   * Secret values to strip from anything this bridge emits — tool args on
   * log/event emission paths, error messages. Populated per-session from
   * the SecretStore; never contains plaintext for unused secrets.
   */
  knownSecretValues: Set<string> = new Set();
  /**
   * Shared process-wide debug flag. When set and enabled, tool-call args
   * + responses are logged in full (redacted). Optional — most callers
   * will populate it; MockProvider leaves it unset for silent tests.
   */
  debug?: { isEnabled(): boolean };
  /**
   * Capability tier of the model that will see this bridge's tools.
   * Wrappers branch on this to relax schemas / auto-fill defaults
   * for tiny models without degrading the strict surface frontier
   * models prefer. Set by `McpBridgePool.fromSessionOpts` from
   * SessionOpts.modelTier; defaults to 'large' when unset.
   */
  modelTier: 'tiny' | 'small' | 'medium' | 'large' | 'cloud' = 'large';

  /**
   * True when the session's gezel is the current Meester. Forwarded
   * to wrappers via {@link McpToolWrapperContext.isMeester} so a
   * `meesterOnly`-scoped wrapper can short-circuit on non-Meester
   * sessions. Set by {@link McpBridgePool.fromSessionOpts} from
   * `SessionOpts.isMeester`; defaults to false when unset (treat
   * unknown sessions as non-Meester).
   */
  isMeester = false;

  /**
   * Resolved per-model behavior profile. When set, the bridge
   * assembles its `wrappers` list as `STATIC_WRAPPERS` + every
   * profile entry whose Behavior carries an `mcpWrapper` (static or
   * factory). When unset (no manifest, third-party catalog import,
   * legacy session), only `STATIC_WRAPPERS` run — preserving today's
   * behavior. Wired via `McpBridgePool.fromSessionOpts` from
   * `SessionOpts.profile`.
   */
  profile?: ResolvedModelProfile;

  /**
   * Active PreToolUse / PostToolUse hooks. Populated when a craftbook
   * with `hooks?: HookSpec[]` is activated on the session. Each entry
   * carries its compiled matcher regex + the craftbook id that installed
   * it (used for audit attribution). Empty by default — sessions
   * without an active craftbook see no gating.
   */
  activeHooks: ActiveHook[] = [];

  /**
   * Runs a single hook against a tool call. Wired by ChatManager from
   * the ScriptRunner. When unset, hooks register but never run —
   * fail-open so a misconfigured wiring doesn't lock the model out.
   */
  hookRunner?: HookRunner;

  /**
   * Audit sink for hook decisions. Called once per hook that fired,
   * regardless of decision. ChatManager pipes this to HistoryManager
   * as `tool.gated` events.
   */
  onHookDecision?: (info: {
    phase: HookPhase;
    toolName: string;
    decision: 'allow' | 'deny' | 'ask';
    message?: string;
    craftbookId: string;
    hookLabel?: string;
  }) => void | Promise<void>;

  /**
   * Surfaces an "ask" hook decision to the user. Returns true to
   * proceed with the tool call, false to treat it as a deny. When
   * unset, "ask" degrades to "deny" so a silently-missing UI path
   * doesn't bypass the guardrail.
   */
  askUser?: (info: {
    phase: HookPhase;
    toolName: string;
    message: string;
    craftbookId: string;
    hookLabel?: string;
  }) => Promise<boolean>;

  /**
   * Install a craftbook's hooks. Replaces any prior hooks installed
   * by the same craftbookId (so re-activation upgrades cleanly), and
   * appends new ones for other craftbooks. Idempotent — calling
   * twice with the same craftbook + hooks doesn't double-register.
   */
  installCraftbookHooks(craftbookId: string, hooks: HookSpec[] | undefined): void {
    this.activeHooks = this.activeHooks.filter((h) => h.craftbookId !== craftbookId);
    if (!hooks || hooks.length === 0) return;
    for (const spec of hooks) {
      let matcher: RegExp;
      try {
        matcher = new RegExp(spec.matcher || '.*');
      } catch (err) {
        log.warn(
          `[hooks] craftbook ${craftbookId}: invalid matcher "${spec.matcher}"; skipping`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      this.activeHooks.push({ spec, craftbookId, matcher });
    }
    if (this.activeHooks.length > 0) {
      log.debug(`[hooks] active: ${this.activeHooks.length} hook(s)`);
    }
  }

  /**
   * Remove hooks installed by a craftbook. Called when a craftbook
   * is deactivated on the session.
   */
  uninstallCraftbookHooks(craftbookId: string): void {
    const before = this.activeHooks.length;
    this.activeHooks = this.activeHooks.filter((h) => h.craftbookId !== craftbookId);
    if (this.activeHooks.length !== before) {
      log.debug(
        `[hooks] uninstalled ${before - this.activeHooks.length} hook(s) from ${craftbookId}`,
      );
    }
  }

  /**
   * Whether a tool call should consult the hook list at all. True when
   * there are active hooks AND we can actually resolve a decision for at
   * least one of them — either a script runner is wired, or a hook
   * carries a static `decision` (which needs no runner). Without this the
   * synthesized auto-allow hooks (static `decision`, no script) would be
   * silently skipped on sessions where the ScriptRunner isn't wired.
   */
  private shouldEvaluateHooks(): boolean {
    if (this.activeHooks.length === 0) return false;
    if (this.hookRunner) return true;
    return this.activeHooks.some((h) => h.spec.decision !== undefined);
  }

  /**
   * Evaluate hooks for a tool call. Returns a deny verdict on the
   * first deny (with the offending hook's message); `ask` decisions
   * are routed to `askUser` and treated as deny on cancel. Allow is
   * the default for hooks that don't match the matcher or whose
   * scripts error out (fail-open). Emits one `onHookDecision` per
   * hook that actually fired.
   *
   * A hook resolves its decision one of two ways: a static
   * `spec.decision` (used directly, no runner — this is how auto-allow
   * toolset hooks work) or a `spec.script` run through `hookRunner`.
   *
   * For PostToolUse, the contract is observational: we never block a
   * call that already happened, but we do emit audit events for hooks
   * that ran and we honor a `deny` decision by transforming the tool
   * output into an error so the model sees a clear signal.
   */
  private async evaluateHooks(
    phase: HookPhase,
    toolName: string,
    args: Record<string, unknown>,
    result?: { text: string; isError: boolean },
  ): Promise<{ allow: true } | { allow: false; reason: string; phase: HookPhase }> {
    if (this.activeHooks.length === 0) return { allow: true };
    for (const hook of this.activeHooks) {
      if (hook.spec.phase !== phase) continue;
      if (!hook.matcher.test(toolName)) continue;
      const hookName = hook.spec.label ?? hook.spec.script?.name ?? 'hook';
      let res: HookResult;
      if (hook.spec.decision !== undefined) {
        // Static verdict — no script run.
        res = { decision: hook.spec.decision };
      } else if (this.hookRunner) {
        try {
          res = await this.hookRunner(hook, {
            phase,
            toolName,
            args,
            ...(result ? { result } : {}),
          });
        } catch (err) {
          log.warn(
            `[hooks] script ${hookName} threw; treating as allow:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
      } else {
        // Script hook with no runner wired — can't resolve; fail-open.
        continue;
      }
      const decision = res.decision ?? 'allow';
      const message = typeof res.message === 'string' ? res.message : undefined;
      try {
        await this.onHookDecision?.({
          phase,
          toolName,
          decision,
          ...(message ? { message } : {}),
          craftbookId: hook.craftbookId,
          ...(hook.spec.label ? { hookLabel: hook.spec.label } : {}),
        });
      } catch {
        /* audit failure is never fatal */
      }
      if (decision === 'deny') {
        return {
          allow: false,
          reason: message ?? `blocked by hook (${hookName})`,
          phase,
        };
      }
      if (decision === 'ask') {
        const proceed = this.askUser
          ? await this.askUser({
              phase,
              toolName,
              message: message ?? `Allow ${toolName}?`,
              craftbookId: hook.craftbookId,
              ...(hook.spec.label ? { hookLabel: hook.spec.label } : {}),
            }).catch(() => false)
          : false;
        if (!proceed) {
          return {
            allow: false,
            reason: message ?? `cancelled by user (${hookName})`,
            phase,
          };
        }
      }
    }
    return { allow: true };
  }

  async start(spec: McpServerSpec): Promise<void> {
    const transport = buildTransport(spec);
    const client = new Client(
      { name: 'gezel-openai-bridge', version: '1.0.0' },
      { capabilities: {} },
    );
    log.debug(`connecting to ${describeSpec(spec)}`);
    try {
      await client.connect(transport);
    } catch (err) {
      log.warn(
        `connect FAILED for ${describeSpec(spec)} — this bridge will register no tools: ${describeBridgeError(err)}`,
      );
      throw err;
    }
    this.client = client;

    let listing: Awaited<ReturnType<typeof client.listTools>>;
    try {
      listing = await client.listTools();
    } catch (err) {
      log.warn(
        `listTools FAILED for ${describeSpec(spec)} — this bridge will register no tools: ${describeBridgeError(err)}`,
      );
      throw err;
    }
    this.tools = listing.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    }));
    // Compose: behavior-driven wrappers from the resolved profile
    // first (they're per-model opt-ins, scoped tightly), then the
    // static wrappers selected for this spec (universal — Zod
    // translator, snapshot inliner, etc.). When no profile is set
    // (third-party catalog, legacy session), only the static set
    // runs. The wrappers themselves still gate on `matches(spec)` so
    // gezel-mcp-only wrappers won't fire on a Playwright bridge etc.
    this.wrappers = [...behaviorWrappersFor(this.profile, spec), ...selectWrappersFor(spec)];
    // Bind the wrapper context up front so `decorateTools` can read
    // `modelTier` (a schema-relaxer needs to know whether the model
    // is tiny before deciding to demote required fields). The context
    // is also a back-channel that lets later hooks call other tools
    // on this same bridge — e.g. auto-screenshot calling
    // browser_take_screenshot after browser_navigate.
    // `hasTool` reads `toolNameSet` lazily so post-decoration tool
    // names work too.
    this.wrapperCtx = {
      spec,
      cwd: process.cwd(),
      modelTier: this.modelTier,
      isMeester: this.isMeester,
      hasTool: (n) => this.toolNameSet.has(n),
      callTool: async (n, a) => {
        const r = await this._invokeRaw(n, a);
        if (r.isError) {
          throw new Error(r.errorMessage ?? `tool ${n} returned an error`);
        }
        return { text: r.text, images: r.images };
      },
      ...(this.artifactPersister ? { writeArtifact: this.artifactPersister } : {}),
    };
    // Let wrappers tighten descriptions / prune args / relax schemas
    // before the model ever sees the tool list. Stable order: each
    // wrapper sees the previous one's output.
    for (const w of this.wrappers) {
      if (!w.decorateTools) continue;
      try {
        this.tools = w.decorateTools(this.tools, this.wrapperCtx);
      } catch (err) {
        log.warn(
          `wrapper ${w.id} decorateTools threw; using prior list:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.toolNameSet = new Set(this.tools.map((t) => t.name));
    if (this.tools.length === 0) {
      log.warn(
        `bridge for ${describeSpec(spec)} connected but listed ZERO tools — the model will see an empty tool schema this session (checkers 'make_move not available', etc.)`,
      );
    }
    if (this.wrappers.length > 0) {
      log.debug(`applying wrappers: ${this.wrappers.map((w) => w.id).join(', ')}`);
    }
    log.debug(`ready with ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(', ')}`);
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    return this.tools;
  }

  /**
   * Reshape the in-memory tool list to Anthropic's Messages API format.
   * Same schemas, different field names — `parameters` → `input_schema`,
   * no top-level `type` discriminator. Wrappers / decorations have already
   * been applied by `start()`, so a tool that's been pruned/relaxed for
   * tiny-model branching looks the same to either provider.
   */
  getAnthropicTools(): AnthropicTool[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  hasTool(name: string): boolean {
    return this.toolNameSet.has(name);
  }

  /**
   * Seed any wrappers that opted into `seedFromText` with a known-good
   * text source — typically the rendered system prompt. The strict-IDs
   * validator uses this to learn the project id, task refs, and gezel
   * ids that ChatManager already injected into the prompt, so the
   * very first tool call referencing one of those values isn't
   * rejected as a fabrication. No-op for wrappers without state to
   * seed, and no-op for bridges whose wrappers don't include a
   * seeding-capable one.
   *
   * Idempotent — calling repeatedly with overlapping text just
   * re-adds the same ids. Callers should pass the rendered system
   * prompt at session-start, before the first `callTool`.
   */
  seedWrappersFromText(text: string): void {
    if (!text) return;
    for (const w of this.wrappers) {
      if (typeof w.seedFromText === 'function') {
        try {
          w.seedFromText(text);
        } catch (err) {
          log.warn(
            `[mcp-bridge] wrapper "${w.id}" seedFromText threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  /**
   * Invoke a tool and coalesce its MCP `content` blocks into a single text
   * string suitable for a function_call_output item. Legacy shim for
   * callers that only need text — delegates to `callToolRich` and drops
   * any image blocks. Keep the image blocks? Call `callToolRich` instead.
   *
   * `opts.budgetChars` narrows the per-call truncation limit from the
   * default `MAX_TOOL_OUTPUT_CHARS` — used by providers that know the
   * remaining context budget for the current turn (llama-cpp, Ollama,
   * MLX) so a single tool output can't overflow the window even when
   * the conversation is nearly full.
   *
   * `opts.numCtxTokens` provides the model's full context window so
   * `capToolOutput` can scale its absolute ceiling for small-context
   * models. Without it, a 4K-context model could be handed an 80K
   * char output (~20K tokens) and silently overflow — passing
   * `numCtxTokens` makes the upper bound `numCtxTokens × 0.75 × 4`
   * chars instead. Optional; the absolute 80K cap still applies.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { budgetChars?: number; numCtxTokens?: number },
  ): Promise<string> {
    const rich = await this.callToolRich(name, args, opts);
    return rich.text;
  }

  /**
   * Inner SDK invocation — does the actual MCP `callTool` and parses
   * its content blocks into text + images. Skips wrappers, redaction,
   * truncation, and event emission. Used by `callToolRich` and exposed
   * to wrappers via the wrapper context's `callTool` callback so a
   * wrapper can chain a follow-up tool call (e.g. auto-screenshot)
   * without recursing through itself.
   */
  private async _invokeRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    text: string;
    images: Array<{ base64: string; mimeType: string }>;
    audios: Array<{
      base64: string;
      mimeType: string;
      durationSeconds?: number;
      voice?: string;
    }>;
    /**
     * MCP `structuredContent` from the tool result, when set. Used by
     * Layer 4 surgical-edit tools to surface `{diff, addedLines,
     * removedLines}` to the UI without embedding sentinel JSON in the
     * text response. Any tool can populate it; the bridge passes it
     * through untouched and the chat manager picks fields it knows.
     */
    structuredContent?: Record<string, unknown>;
    isError: boolean;
    errorMessage?: string;
  }> {
    if (!this.client) throw new Error('[mcp-bridge] not started');
    const images: Array<{ base64: string; mimeType: string }> = [];
    const audios: Array<{
      base64: string;
      mimeType: string;
      durationSeconds?: number;
      voice?: string;
    }> = [];
    // The third arg threads per-call options to the MCP SDK; without a
    // `timeout` here the SDK falls back to its 60 s default, which kills
    // legitimately long calls (image gen, npm install, playwright runs)
    // mid-flight before the engine has a chance to respond.
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutForTool(name),
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        } else if (
          b.type === 'image' &&
          typeof b.data === 'string' &&
          typeof b.mimeType === 'string'
        ) {
          images.push({ base64: b.data, mimeType: b.mimeType });
        } else if (
          b.type === 'audio' &&
          typeof b.data === 'string' &&
          typeof b.mimeType === 'string'
        ) {
          const entry: {
            base64: string;
            mimeType: string;
            durationSeconds?: number;
            voice?: string;
          } = { base64: b.data, mimeType: b.mimeType };
          if (typeof b.durationSeconds === 'number') entry.durationSeconds = b.durationSeconds;
          if (typeof b.voice === 'string') entry.voice = b.voice;
          audios.push(entry);
        }
      }
    }
    const text = texts.join('\n\n').trim();
    const isError = Boolean(result.isError);
    const structuredContent =
      result.structuredContent && typeof result.structuredContent === 'object'
        ? (result.structuredContent as Record<string, unknown>)
        : undefined;
    return {
      text,
      images,
      audios,
      ...(structuredContent ? { structuredContent } : {}),
      isError,
      ...(isError ? { errorMessage: text || 'tool returned an error' } : {}),
    };
  }

  /**
   * Invoke a tool and surface both text and image content blocks. The
   * MCP spec allows tools to return `{ type: 'image', data, mimeType }`
   * blocks alongside text; this is how a multimodal-aware provider can
   * feed the tool's visual output back into the model as a vision input.
   */
  async callToolRich(
    name: string,
    args: Record<string, unknown>,
    opts?: { budgetChars?: number; numCtxTokens?: number },
  ): Promise<{ text: string; images: Array<{ base64: string; mimeType: string }> }> {
    if (!this.client) throw new Error('[mcp-bridge] not started');
    const debugOn = this.debug?.isEnabled() === true;
    if (debugOn) {
      const redactedArgs = redactObject(args, this.knownSecretValues);
      let argsJson: string;
      try {
        argsJson = JSON.stringify(redactedArgs);
      } catch {
        argsJson = '(unserializable)';
      }
      // Full args payload (with secrets stripped) so "what exactly did
      // the model send?" is answerable from the log alone.
      log.debug(`call_tool ${name} args=${argsJson}`);
    } else {
      log.debug(`call_tool ${name} keys=${Object.keys(args).join(',')}`);
    }
    const start = Date.now();
    let errorMessage: string | undefined;
    let combined = '';
    let isError = false;
    let effectiveArgs = args;
    const images: Array<{ base64: string; mimeType: string }> = [];
    const audios: Array<{
      base64: string;
      mimeType: string;
      durationSeconds?: number;
      voice?: string;
    }> = [];
    let structuredContent: Record<string, unknown> | undefined;
    try {
      // PreToolUse hooks: gating the call before any wrapper sees
      // it. A deny short-circuits like a wrapper reject — synthetic
      // error result, success=false, model sees the reason.
      let rejected: string | null = null;
      if (this.shouldEvaluateHooks()) {
        const verdict = await this.evaluateHooks('PreToolUse', name, effectiveArgs);
        if (!verdict.allow) {
          rejected = verdict.reason;
        }
      }
      // Wrapper preProcess: validate / rewrite / reject before we
      // hit the wire. A reject short-circuits to the same path as a
      // tool-side error — synthetic ERROR result, event fires with
      // success=false, model sees a teaching message.
      if (rejected === null && this.wrappers.length > 0 && this.wrapperCtx) {
        for (const w of this.wrappers) {
          if (!w.preProcess) continue;
          try {
            const verdict = await w.preProcess(name, effectiveArgs, this.wrapperCtx);
            if (verdict.kind === 'reject') {
              rejected = verdict.error;
              break;
            }
            if (verdict.args) effectiveArgs = verdict.args;
          } catch (err) {
            log.warn(
              `wrapper ${w.id} preProcess threw for ${name}; allowing call:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      if (rejected !== null) {
        combined = rejected;
        isError = true;
        errorMessage = rejected;
        log.debug(`call_tool ${name} rejected: ${rejected}`);
      } else {
        const raw = await this._invokeRaw(name, effectiveArgs);
        combined = raw.text;
        isError = raw.isError;
        errorMessage = raw.errorMessage;
        for (const img of raw.images) images.push(img);
        for (const aud of raw.audios) audios.push(aud);
        if (raw.structuredContent) structuredContent = raw.structuredContent;
        if (!isError && this.wrappers.length > 0 && this.wrapperCtx) {
          for (const w of this.wrappers) {
            if (!w.postProcess) continue;
            try {
              const wrapped = await w.postProcess(
                name,
                effectiveArgs,
                { text: combined, images },
                this.wrapperCtx,
              );
              combined = wrapped.text;
              // Wrappers can return an extended images array but never
              // mutate the original — assign back to the local mutable.
              if (wrapped.images !== images) {
                images.length = 0;
                for (const img of wrapped.images) images.push(img);
              }
            } catch (err) {
              log.warn(
                `wrapper ${w.id} failed for ${name}; falling back:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        } else if (isError && this.wrappers.length > 0 && this.wrapperCtx) {
          // Translate dense Zod / JSON-schema validation errors into
          // plain English before they hit the model. Smaller models
          // can act on "ERROR: missing required field 'about'" but
          // not on a raw `[{code:invalid_type,...}]` blob.
          for (const w of this.wrappers) {
            if (!w.postProcessError) continue;
            try {
              const translated = await w.postProcessError(
                name,
                effectiveArgs,
                combined,
                this.wrapperCtx,
              );
              if (translated !== combined) {
                combined = translated;
                errorMessage = translated;
              }
            } catch (err) {
              log.warn(
                `wrapper ${w.id} postProcessError failed for ${name}; using raw error:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
        // PostToolUse hooks: observational. The call already happened,
        // but a `deny` decision transforms the output into an error
        // so the model sees a clear signal that the result was
        // rejected (e.g. "this response leaked a secret — do not act
        // on it"). `ask` is treated as deny — once the call ran, we
        // can't roll it back.
        if (this.shouldEvaluateHooks()) {
          const verdict = await this.evaluateHooks('PostToolUse', name, effectiveArgs, {
            text: combined,
            isError,
          });
          if (!verdict.allow) {
            combined = verdict.reason;
            isError = true;
            errorMessage = verdict.reason;
            log.debug(`call_tool ${name} post-hook denied: ${verdict.reason}`);
          }
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      isError = true;
      if (debugOn && err instanceof Error && err.stack) {
        log.error(`call_tool ${name} threw:\n${err.stack}`);
      }
    } finally {
      // Drain per-call wrapper state first — onCallEnd fires exactly
      // once per call regardless of how we got here (success, tool-
      // side isError, or an SDK / transport exception that aborted
      // mid-flight). This is the only hook that survives the
      // `_invokeRaw` throw path; without it, a wrapper holding
      // turn-scoped state (in-flight counter, retry budget) would
      // leak permanently on a single `-32001 Request timed out` and
      // wedge every later call in the session.
      if (this.wrappers.length > 0 && this.wrapperCtx) {
        for (const w of this.wrappers) {
          if (!w.onCallEnd) continue;
          try {
            await w.onCallEnd(name, effectiveArgs, this.wrapperCtx);
          } catch (err) {
            log.warn(
              `wrapper ${w.id} onCallEnd threw for ${name}; continuing:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      // Persist images to the project's artifacts/ tree before firing the
      // event so the persisted paths can ride along on the ToolCallEvent.
      // A persister failure must NOT poison the tool result — log and
      // continue with no `images` on the event.
      let persistedImages: Array<{ path: string; mimeType: string }> = [];
      if (this.imagePersister && images.length > 0) {
        try {
          persistedImages = await this.imagePersister.persist(images);
        } catch (err) {
          log.warn('imagePersister threw:', err);
        }
      }
      let persistedAudios: Array<{
        path: string;
        mimeType: string;
        durationSeconds?: number;
        voice?: string;
      }> = [];
      if (this.audioPersister && audios.length > 0) {
        try {
          persistedAudios = await this.audioPersister.persist(audios);
        } catch (err) {
          log.warn('audioPersister threw:', err);
        }
      }
      if (this.onToolCall) {
        try {
          const redactedArgs = redactObject(args, this.knownSecretValues);
          const redactedError = errorMessage
            ? redactString(errorMessage, this.knownSecretValues)
            : undefined;
          await this.onToolCall({
            name,
            argKeys: Object.keys(args),
            args: redactedArgs,
            durationMs: Date.now() - start,
            success: !isError,
            ...(redactedError ? { errorMessage: redactedError } : {}),
            ...(persistedImages.length > 0 ? { images: persistedImages } : {}),
            ...(persistedAudios.length > 0 ? { audios: persistedAudios } : {}),
            ...(structuredContent ? { structuredContent } : {}),
          });
        } catch (err) {
          log.warn('onToolCall threw:', err);
        }
      }
    }
    if (errorMessage && isError) {
      const redacted = redactString(errorMessage, this.knownSecretValues);
      if (debugOn) {
        log.error(`call_tool ${name} error: ${redacted}`);
      }
      // Preserve the pre-existing behavior: throw if the SDK threw; return
      // an ERROR: string if the tool reported isError via the MCP result.
      if (!combined) throw new Error(redacted);
      return { text: `ERROR: ${redacted}`, images: [] };
    }
    if (debugOn) {
      // Tail-clamp so a giant `readdir` return doesn't flood.
      const tail =
        combined.length > 10_000
          ? `${combined.slice(0, 10_000)}…(${combined.length - 10_000} more chars)`
          : combined;
      log.debug(
        `call_tool ${name} ok (${Date.now() - start}ms, ${images.length} images)\n${redactString(tail, this.knownSecretValues)}`,
      );
    }
    // Redact the result before it's handed to the provider. An MCP
    // tool can't directly pass a token into the model's context, but
    // it CAN echo one in an error body, a git-config dump, or an
    // HTTP response. Scrub any substrings we know are secrets.
    const redactedText = redactString(combined || '(empty)', this.knownSecretValues);
    // Cap the tool output before handing it off so a single tool call
    // can't single-handedly blow the model's context window. When the
    // caller passed `budgetChars` (adaptive budget from a provider
    // that tracks remaining context headroom), use that; otherwise
    // fall back to the fixed ceiling.
    const cap = opts?.budgetChars ?? MAX_TOOL_OUTPUT_CHARS;
    const capped = capToolOutput(
      redactedText,
      cap,
      opts?.numCtxTokens !== undefined ? { numCtxTokens: opts.numCtxTokens } : undefined,
    );
    if (capped.length !== redactedText.length) {
      log.warn(
        `call_tool ${name} output truncated: ${redactedText.length} → ${capped.length} chars (budget=${cap})`,
      );
    }
    return { text: capped, images };
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.tools = [];
    this.toolNameSet.clear();
    this.wrappers = [];
    this.wrapperCtx = null;
  }
}

/** Replace any known secret value in `input` with `[REDACTED]`. */
export function redactString(input: string, secrets: Set<string>): string {
  if (!input || secrets.size === 0) return input;
  let out = input;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/**
 * Construct the SDK transport for a given spec. Centralized so the
 * bridge's `start()` stays transport-agnostic and so unit tests can
 * exercise the branching without spinning up a real server.
 */
export function buildTransport(spec: McpServerSpec): Transport {
  if (isHttpSpec(spec)) {
    const url = new URL(spec.url);
    const requestInit: RequestInit = {
      headers: { ...spec.headers },
    };
    if (spec.transport === 'sse') {
      // SSE transport defaults its EventSource to a no-headers fetch
      // when `eventSourceInit` isn't passed; that's acceptable for
      // unauthenticated / cookie-auth servers. Bearer-auth SSE entries
      // would need a custom EventSource — out of scope for MVP. Most
      // modern hosted MCPs are streamable-http, so this is the rare
      // path.
      return new SSEClientTransport(url, { requestInit });
    }
    return new StreamableHTTPClientTransport(url, { requestInit });
  }
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Filter ambient secrets out of the child env. A third-party MCP
    // server inheriting the daemon's full `process.env` would receive
    // any provider key the USER exported (OPENAI_API_KEY, GH_TOKEN, …)
    // plus GEZEL_TOKEN — readable from the child via /proc/<pid>/environ.
    // Toolsets pass the secrets they actually need through `spec.env`
    // (spread last, so the gezel-mcp server still gets its GEZEL_* vars).
    env: { ...filterMcpChildEnv(process.env), ...spec.env } as Record<string, string>,
  });
}

/** Env-var names that are always stripped from MCP child processes. */
const SECRET_ENV_EXACT = new Set([
  'GEZEL_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

function isSecretEnvName(name: string): boolean {
  const n = name.toUpperCase();
  if (SECRET_ENV_EXACT.has(n)) return true;
  // Catch the common secret-shaped suffixes/segments. Toolsets that
  // genuinely need such a value must pass it explicitly via spec.env.
  return /(?:^|_)(?:API_?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|SESSION_TOKEN)(?:$|_)/.test(
    n,
  );
}

/** Drop ambient secret-shaped env vars before handing the env to an MCP child. */
function filterMcpChildEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (isSecretEnvName(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Short string for logs. Avoids dumping headers (may contain bearer tokens). */
export function describeSpec(spec: McpServerSpec): string {
  if (isHttpSpec(spec)) return `${spec.transport} ${spec.url}`;
  return spec.command;
}

/**
 * Compact one-line rendering of a bridge start failure for the log:
 * error class + message + fs/spawn errno when present. Enough to tell a
 * spawn `ENOENT` (binary/path wrong) or `EMFILE` from a `listTools`
 * timeout without dumping a full stack — the durable clue for a bridge
 * that came up with no tools.
 */
export function describeBridgeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return `${err.name}: ${err.message}${code ? ` [${code}]` : ''}`;
}

/** Recursively redact string values inside a plain object/array. */
export function redactObject<T>(value: T, secrets: Set<string>): T {
  if (secrets.size === 0) return value;
  if (typeof value === 'string') return redactString(value, secrets) as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, secrets)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactObject(v, secrets);
    }
    return out as T;
  }
  return value;
}
