/**
 * MCP server wrappers — small adapters that post-process tool responses
 * from upstream MCP servers to make them more usable, especially to
 * smaller local models.
 *
 * The MCP ecosystem is heterogeneous: different servers return their
 * results in different shapes (file links, plain text, JSON blobs, base64
 * images). Big frontier models route around quirks; small local models
 * (Gemma 4 etc.) tend to fabricate when a tool returns "[Snapshot](path)"
 * because they have no way to read the file. The wrapper layer lives
 * between the MCP bridge and the model, intercepts the tool result, and
 * shapes it into something the model can act on directly.
 *
 * A wrapper is matched against the {@link McpServerSpec} at bridge
 * startup. Matching wrappers run in registration order on each tool
 * result. Wrappers must be idempotent and free of side effects beyond
 * disk reads — they should never mutate the running MCP server's state
 * or rewrite the user's project.
 */
import type { McpServerSpec, OpenAIFunctionTool } from '../mcp-bridge.js';

export interface McpToolResult {
  text: string;
  images: Array<{ base64: string; mimeType: string }>;
}

/**
 * Outcome of a `preProcess` hook. `allow` lets the call proceed
 * (optionally with rewritten args). `reject` short-circuits the
 * invocation: the bridge synthesizes a tool-error result with the
 * given message, fires the usual `onToolCall` event with
 * `success: false`, and returns the error string to the model. Used
 * when a wrapper can confidently say "this call cannot succeed as
 * issued" — e.g. a URL parameter that isn't a URL.
 */
export type McpPreProcessVerdict =
  | { kind: 'allow'; args?: Record<string, unknown> }
  | { kind: 'reject'; error: string };

export interface McpToolWrapperContext {
  /** Spec used to launch the MCP server. */
  spec: McpServerSpec;
  /**
   * Working directory the MCP subprocess inherited from this bridge's
   * parent process. File-link references in tool results that aren't
   * absolute paths are resolved against this directory.
   */
  cwd: string;
  /**
   * Capability tier of the model that will receive this wrapper's
   * output. Lets wrappers branch their behavior — a schema-relaxer
   * runs only for `'tiny'`, an error-translator runs for all tiers.
   */
  modelTier: 'tiny' | 'small' | 'medium' | 'large' | 'cloud';
  /**
   * True when the session's gezel is the currently designated Meester
   * (i.e. `config.meesterGezelId === record.gezelId`). Lets a wrapper
   * scope itself to Meester-only flows without baking the role check
   * into the wrapper-selection layer. Defaults to false on bridges
   * that don't plumb session context (tests, third-party MCPs spun
   * up outside a chat session).
   */
  isMeester: boolean;
  /** True if the bridge exposes a tool with the given name. */
  hasTool: (name: string) => boolean;
  /**
   * Invoke another tool on the same bridge. Wrapper-initiated calls
   * bypass the wrapper layer to avoid recursion, but still flow
   * through the bridge's outer redaction + truncation when the
   * resulting text propagates back through `callToolRich`. Throws on
   * tool error.
   */
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /**
   * Optional: persist content directly to the project's artifacts/
   * tree without round-tripping through `write_artifact`. Set per-
   * session by the chat manager when an artifact persister is
   * configured. Bridge-agnostic — works from any wrapper running on
   * any bridge (third-party MCPs that don't host `write_artifact`
   * still get this).
   *
   * Wrappers that need outboard storage (e.g. the large-output
   * persister) should check for the callback's presence before using
   * it; when undefined, fall back to the original tool result so the
   * absence of the persister never breaks an otherwise-working tool
   * call.
   */
  writeArtifact?: (relPath: string, content: string) => Promise<void>;
}

export interface McpToolWrapper {
  /** Stable identifier for logs. */
  readonly id: string;
  /** Returns true if this wrapper applies to the given server. */
  matches(spec: McpServerSpec): boolean;
  /**
   * Optionally rewrite the tool list shown to the model — tighten a
   * description, prune args, relax required-field arrays, etc. Runs
   * once at bridge `start()` time over the SDK-listed tools. Returns
   * the (possibly modified) list; the bridge stores the result and
   * that's what `getOpenAITools()` exposes from then on. Wrappers
   * run in registration order; each sees the previous wrapper's
   * output. The context carries the model tier so a wrapper can
   * (e.g.) skip schema relaxation for medium / large / cloud models.
   */
  decorateTools?(tools: OpenAIFunctionTool[], ctx: McpToolWrapperContext): OpenAIFunctionTool[];
  /**
   * Optionally validate or rewrite tool arguments before invocation.
   * Return `{ kind: 'allow' }` to let the call proceed unchanged,
   * `{ kind: 'allow', args: ... }` to rewrite args, or
   * `{ kind: 'reject', error }` to short-circuit with a synthetic
   * tool-error. Used when a wrapper can confidently catch a
   * call-shaped-wrong-on-its-face — e.g. a non-URL URL — and turn
   * it into a teaching error before paying the round-trip cost.
   */
  preProcess?(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): Promise<McpPreProcessVerdict>;
  /**
   * Transform a successful tool result. Errors thrown are caught,
   * logged, and ignored — the bridge falls back to the un-wrapped
   * result. Wrappers should never throw on a malformed response.
   */
  postProcess?(
    toolName: string,
    args: Record<string, unknown>,
    result: McpToolResult,
    ctx: McpToolWrapperContext,
  ): Promise<McpToolResult>;
  /**
   * Transform a failed tool result before it reaches the model.
   * Used to translate dense Zod / JSON-schema validation errors into
   * plain English so smaller models can act on them. The result's
   * text becomes the new ERROR string surfaced to the provider via
   * `function_call_output`. Errors thrown are caught + ignored
   * (fall back to the original error). Returning the input
   * unchanged is a no-op.
   */
  postProcessError?(
    toolName: string,
    args: Record<string, unknown>,
    errorText: string,
    ctx: McpToolWrapperContext,
  ): Promise<string>;
  /**
   * Always-fires terminal hook. Invoked exactly once per call —
   * after a successful result, a tool-side error, OR an SDK / transport
   * exception that aborts the call before any result returns (MCP
   * `-32001: Request timed out`, child-process crash, JSON-RPC framing
   * error). Use this for state that MUST drain regardless of outcome:
   * the `turn.single-tool-per-turn` wrapper's in-flight counter, for
   * example, would otherwise leak forever on a transport timeout
   * because neither `postProcess` (success-only) nor `postProcessError`
   * (tool-side error only) runs when the SDK call rejects. Errors
   * thrown are caught and logged — never propagate, never block the
   * tool result from reaching the model.
   *
   * Runs AFTER `postProcess` / `postProcessError` on the happy paths.
   * No return value: wrappers can mutate their own state but cannot
   * change the result the model sees from this hook.
   */
  onCallEnd?(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpToolWrapperContext,
  ): void | Promise<void>;
  /**
   * Seed wrapper state from a known-good text source — typically the
   * rendered system prompt. The Gemma strict-IDs validator uses this
   * to learn the project id, task refs, and gezel ids that ChatManager
   * already injected into the prompt, so the very first tool call
   * referencing one of those values doesn't get rejected as a
   * fabrication. Without this, a voorman session whose prompt says
   * `tank-combat-arcade-game/2 — "Build Tank Combat Arcade Game"`
   * gets its `get_task ref: "tank-combat-arcade-game/2"` rejected
   * because no PRIOR TOOL RESULT yielded that ref — even though the
   * runtime itself put the ref in front of the model.
   *
   * Runs once at session-start, after `start()` and before the first
   * `callTool`. Wrappers without state to seed can omit this.
   */
  seedFromText?(text: string): void;
}
