import { createLogger } from '@bendyline/gezel';
import { TOOL_REGISTRY, canonicalToolName } from '@bendyline/gezel-mcp';
import { type AnthropicTool, McpBridge, type OpenAIFunctionTool } from './mcp-bridge.js';
import type { SessionOpts } from './types.js';

const log = createLogger('mcp-bridge');

/**
 * A small coordinator that owns the primary `McpBridge` (built-in gezel-mcp)
 * plus one extra bridge per installed toolset. Presents the same surface
 * `OpenAIProvider` / `OllamaProvider` already use (`getOpenAITools`,
 * `hasTool`, `callTool`, `stop`) so they don't have to know whether there's
 * one bridge under the hood or five.
 *
 * Tool-name collision policy: first bridge wins. The primary gezel-mcp is
 * started first, so its tools shadow any colliding toolset tool. In
 * practice we namespace tool names when we can (future work), but for v1
 * this bias keeps core behavior stable.
 */
export class McpBridgePool {
  private readonly bridges: Array<{ id: string; bridge: McpBridge }> = [];
  /**
   * Role-based allowlist for *built-in* tools (those owned by
   * `@bendyline/gezel-mcp` and grouped in `BUILTIN_TOOLSETS`). When
   * set, `getOpenAITools()` omits any built-in tool whose name isn't
   * in the set so the model sees a role-appropriate slice of our
   * ~60-tool surface. The model-facing `hasTool` / `callTool` /
   * `callToolRich` paths enforce the same filter: local providers can
   * salvage freeform text into a tool call by name, so hiding the
   * schema is not enough to prevent an out-of-role built-in call.
   *
   * **Third-party MCP tools (anything absent from `TOOL_REGISTRY`)
   * pass through this pool-level filter.** A server-specific bridge wrapper
   * may still prune its own advertised/callable surface (the managed
   * local-preview Playwright profile does this). Ordinary user-installed
   * toolsets remain untouched here; per-tool UI exclusion is future work.
   */
  private toolAllowlist: Set<string> | null = null;

  /**
   * Start the primary + extras based on SessionOpts. Returns a pool that
   * exposes a merged tool list. On any individual bridge failure the pool
   * logs and skips — the session still runs with whatever bridges came up.
   */
  static async fromSessionOpts(opts: SessionOpts, logPrefix: string): Promise<McpBridgePool> {
    const pool = new McpBridgePool();
    if (opts.toolAllowlist) pool.toolAllowlist = opts.toolAllowlist;

    const secrets = opts.knownSecretValues ?? new Set<string>();
    const debugOn = opts.debug?.isEnabled() === true;
    const modelTier = opts.modelTier ?? 'large';
    const isMeester = opts.isMeester === true;
    if (opts.mcpServer) {
      const primary = new McpBridge();
      if (opts.onToolCall) primary.onToolCall = opts.onToolCall;
      if (opts.imagePersister) primary.imagePersister = opts.imagePersister;
      if (opts.audioPersister) primary.audioPersister = opts.audioPersister;
      if (opts.artifactPersister) primary.artifactPersister = opts.artifactPersister;
      if (opts.workspacePreview) primary.workspacePreview = opts.workspacePreview;
      primary.knownSecretValues = secrets;
      if (opts.debug) primary.debug = opts.debug;
      primary.modelTier = modelTier;
      primary.isMeester = isMeester;
      if (opts.profile) primary.profile = opts.profile;
      if (opts.hookRunner) primary.hookRunner = opts.hookRunner;
      if (opts.hookAskUser) primary.askUser = opts.hookAskUser;
      if (opts.onHookDecision) primary.onHookDecision = opts.onHookDecision;
      for (const entry of opts.craftbookHooks ?? []) {
        primary.installCraftbookHooks(entry.craftbookId, entry.hooks);
      }
      try {
        await primary.start(opts.mcpServer);
        pool.bridges.push({ id: 'gezel', bridge: primary });
      } catch (err) {
        if (debugOn) {
          log.error(
            `${logPrefix} primary MCP bridge failed to start — session will run without built-in tools:`,
            err,
          );
        } else {
          // Pass the full error (not just `.message`) so the stack + any
          // spawn/fs errno is captured — this is the session-fatal path
          // where every tool vanishes, so the on-disk trace matters.
          log.warn(
            `${logPrefix} primary MCP bridge failed to start — session will run without built-in tools:`,
            err,
          );
        }
        opts.onBridgeFailure?.({ bridgeId: 'gezel', error: err });
      }
    }

    for (const extra of opts.extraMcpServers ?? []) {
      const bridge = new McpBridge();
      if (opts.onToolCall) bridge.onToolCall = opts.onToolCall;
      if (opts.imagePersister) bridge.imagePersister = opts.imagePersister;
      if (opts.audioPersister) bridge.audioPersister = opts.audioPersister;
      if (opts.artifactPersister) bridge.artifactPersister = opts.artifactPersister;
      if (opts.workspacePreview) bridge.workspacePreview = opts.workspacePreview;
      bridge.knownSecretValues = secrets;
      if (opts.debug) bridge.debug = opts.debug;
      bridge.modelTier = modelTier;
      bridge.isMeester = isMeester;
      if (opts.profile) bridge.profile = opts.profile;
      if (opts.hookRunner) bridge.hookRunner = opts.hookRunner;
      if (opts.hookAskUser) bridge.askUser = opts.hookAskUser;
      if (opts.onHookDecision) bridge.onHookDecision = opts.onHookDecision;
      for (const entry of opts.craftbookHooks ?? []) {
        bridge.installCraftbookHooks(entry.craftbookId, entry.hooks);
      }
      // The spec is the full extra entry minus its `id`. The bridge's
      // `start()` discriminates on `kind` — stdio (default) for the
      // legacy {command, args, env} shape, http for hosted MCPs.
      const { id: _id, ...spec } = extra;
      try {
        await bridge.start(spec);
        pool.bridges.push({ id: extra.id, bridge });
      } catch (err) {
        if (debugOn) {
          log.error(`${logPrefix} toolset bridge "${extra.id}" failed to start — skipping:`, err);
        } else {
          log.warn(
            `${logPrefix} toolset bridge "${extra.id}" failed to start — skipping:`,
            err instanceof Error ? err.message : err,
          );
        }
        opts.onBridgeFailure?.({ bridgeId: extra.id, error: err });
      }
    }

    // Seed every wrapper that opted into `seedFromText` with the
    // rendered system prompt. ChatManager bakes the project id, the
    // active task ref, the voorman gezel id, and the assigned-tasks
    // list directly into the prompt — those values ARE legitimate
    // even though no tool result has yet returned them. Without this
    // seed, the strict-IDs validator rejects the very first call
    // referencing one of those values (e.g. a voorman session whose
    // prompt says `tank-combat-arcade-game/2 — "Build Tank Combat…"`
    // gets `get_task ref: "tank-combat-arcade-game/2"` rejected).
    // Single point of integration: every provider that uses this
    // pool gets the seed for free.
    //
    // Seed the volatile band too, NOT just the stable prefix: the
    // active-task context (`### Current task: squisq/5`) is tagged
    // `volatile` in the prompt-layer split, so it lands in
    // `volatileContext` (the second `system` message) rather than
    // `systemMessage`. Seeding only the stable prefix left the
    // canonical task ref unseen, and the strict-IDs validator
    // false-rejected the step's very first `write_task_note` /
    // `read_task_notes` / `advance_task_step` — wedging the craftbook
    // gate in a ref-required-but-ref-fabricated catch-22.
    if (opts.systemMessage) {
      pool.seedWrappersFromText(opts.systemMessage);
    }
    if (opts.volatileContext) {
      pool.seedWrappersFromText(opts.volatileContext);
    }

    return pool;
  }

  isEmpty(): boolean {
    return this.bridges.length === 0;
  }

  // Allowlist + group membership run in CANONICAL name space: the sets
  // hold canonical names, but the advertised name can be a legacy spelling
  // in the naming-A/B legacy arm. Registry membership, rather than catalog
  // grouping, also covers contextual built-ins such as draft_email.
  private allowsBuiltin(allow: ReadonlySet<string>, name: string): boolean {
    const canonical = canonicalToolName(name);
    const builtin = canonical in TOOL_REGISTRY;
    if (!builtin) return true;
    const entry = TOOL_REGISTRY[canonical as keyof typeof TOOL_REGISTRY];
    if (!entry.modelFacing) return false;
    return allow.has(canonical);
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    const allow = this.toolAllowlist;
    const seen = new Set<string>();
    const out: OpenAIFunctionTool[] = [];
    for (const { bridge } of this.bridges) {
      for (const t of bridge.getOpenAITools()) {
        if (seen.has(t.name)) continue;
        if (allow && !this.allowsBuiltin(allow, t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  getAnthropicTools(): AnthropicTool[] {
    const allow = this.toolAllowlist;
    const seen = new Set<string>();
    const out: AnthropicTool[] = [];
    for (const { bridge } of this.bridges) {
      for (const t of bridge.getAnthropicTools()) {
        if (seen.has(t.name)) continue;
        if (allow && !this.allowsBuiltin(allow, t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  hasTool(name: string): boolean {
    const resolved = this.resolveBridgeTool(name);
    return resolved !== null && this.isCallableByModel(resolved.name);
  }

  /**
   * Forward a one-shot `seedWrappersFromText` to every bridge in the
   * pool. Used by ChatManager to feed the rendered system prompt into
   * the strict-IDs validator (and any future wrappers with similar
   * stateful needs) at session-start time, so prompt-provided IDs
   * aren't flagged as fabrications by the very first tool call.
   */
  seedWrappersFromText(text: string): void {
    for (const { bridge } of this.bridges) {
      bridge.seedWrappersFromText(text);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { budgetChars?: number; numCtxTokens?: number },
  ): Promise<string> {
    const resolved = this.resolveBridgeTool(name);
    if (resolved && !this.isCallableByModel(resolved.name)) {
      throw new Error(`[mcp-bridge-pool] tool "${name}" is not available in this session`);
    }
    if (resolved) return resolved.bridge.callTool(resolved.name, args, opts);
    throw new Error(`[mcp-bridge-pool] no bridge has tool "${name}"`);
  }

  async callToolRich(
    name: string,
    args: Record<string, unknown>,
    opts?: { budgetChars?: number; numCtxTokens?: number },
  ): Promise<{
    text: string;
    images: Array<{ base64: string; mimeType: string }>;
    isError: boolean;
  }> {
    const resolved = this.resolveBridgeTool(name);
    if (resolved && !this.isCallableByModel(resolved.name)) {
      throw new Error(`[mcp-bridge-pool] tool "${name}" is not available in this session`);
    }
    if (resolved) return resolved.bridge.callToolRich(resolved.name, args, opts);
    throw new Error(`[mcp-bridge-pool] no bridge has tool "${name}"`);
  }

  /**
   * First-bridge-wins lookup in each bridge's final advertised namespace.
   * Authorization deliberately happens only after this resolution: otherwise
   * a spelling such as `write-file` looks third-party to the allowlist and is
   * then normalized to the forbidden built-in by `McpBridge` at dispatch.
   */
  private resolveBridgeTool(name: string): { bridge: McpBridge; name: string } | null {
    for (const { bridge } of this.bridges) {
      const resolved = bridge.resolveToolName(name);
      if (resolved !== null) return { bridge, name: resolved };
    }
    return null;
  }

  private isCallableByModel(name: string): boolean {
    const canonical = canonicalToolName(name);
    // Immediate-write sessions intentionally advertise only `write_file` on
    // their first request. If that write is truncated, the local-provider
    // loop injects a temporary `append_to_file` schema so the model can finish
    // the saved partial without re-streaming the whole file. Treat append as
    // an in-scope recovery primitive whenever write_file was authorized;
    // otherwise the injected continuation tool is visible but the pool
    // rejects it as unavailable.
    if (canonical === 'append_to_file' && this.toolAllowlist?.has('write_file')) return true;
    if (!this.toolAllowlist) return true;
    return this.allowsBuiltin(this.toolAllowlist, name);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.bridges.map(({ bridge }) => bridge.stop()));
    this.bridges.length = 0;
  }
}
