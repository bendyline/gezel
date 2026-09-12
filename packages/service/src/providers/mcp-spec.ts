/**
 * The MCP server spec: what `McpBridge.start()` needs to bring up a session,
 * plus the `kind` predicates. A leaf module on purpose — wrappers under
 * `mcp-wrappers/` select on the spec, and the bridge imports the wrapper
 * registry, so a wrapper that reached back into `mcp-bridge.ts` for these
 * helpers formed an import cycle (`playwright-arg-validator` →
 * `playwright-snapshot` → `mcp-bridge` → `mcp-wrappers/index` → the
 * validator again, still initializing). Import spec helpers from here;
 * `mcp-bridge.ts` re-exports them for its existing callers.
 *
 * Three flavors:
 *
 *   - **stdio** (default when `kind` is omitted) — spawn a local
 *     subprocess and speak MCP over its pipes. The historical shape
 *     and what every existing call site uses.
 *   - **http** — connect to a hosted MCP server over HTTP (Streamable
 *     HTTP for new servers, SSE for older ones). Headers (auth tokens,
 *     custom keys) come from resolved toolset config the same way
 *     subprocess env vars do for stdio.
 *   - **in-memory** — an MCP server this daemon serves itself, over a
 *     linked transport pair with no process and no socket. Used for tools a
 *     connected app registered through the app-tool relay: the server half
 *     forwards each call up that app's event stream. A bridge is still the
 *     right shape for these because everything a tool surface needs —
 *     timeouts, output caps, redaction, argument coercion, the unresolved
 *     failure ledger, the `tool` chat event — already lives in the bridge
 *     and pool rather than in any one transport.
 *
 * The discriminator is `kind`; a missing `kind` is treated as
 * `'stdio'` so legacy `{command, args, env}` callers keep working.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec | InMemoryMcpServerSpec;

export interface StdioMcpServerSpec {
  kind?: 'stdio';
  /**
   * Catalog toolset id this bridge speaks to, when it was spawned for an
   * installed toolset. Wrappers select on this rather than sniffing the
   * command line, because a managed system install spawns
   * `node <home>/system-toolsets/@playwright__mcp@0.0.78/package/cli.js` —
   * `installDirName` has slugified the `/` away, so the package name never
   * appears in `command`/`args`. Sniffing there left every Playwright
   * wrapper inert against the exact copy Gezel manages: the `file:`-URL
   * rewrite never fired, and the local-preview posture advertised a browser
   * surface nothing had pruned.
   */
  toolsetId?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Working directory for project-local/custom MCP servers. */
  cwd?: string;
}

export interface HttpMcpServerSpec {
  kind: 'http';
  /** Catalog toolset id — see {@link StdioMcpServerSpec.toolsetId}. */
  toolsetId?: string;
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

export interface InMemoryMcpServerSpec {
  kind: 'in-memory';
  /** Catalog toolset id — see {@link StdioMcpServerSpec.toolsetId}. */
  toolsetId?: string;
  /** Short label for logs; never a secret. */
  label: string;
  /**
   * Build the client half of a linked transport pair, with the server half
   * already connected. Called once per bridge start, so a retry gets a fresh
   * pair rather than a closed one.
   */
  connect: () => Transport;
}

export function isStdioSpec(spec: McpServerSpec): spec is StdioMcpServerSpec {
  return spec.kind === undefined || spec.kind === 'stdio';
}

export function isHttpSpec(spec: McpServerSpec): spec is HttpMcpServerSpec {
  return spec.kind === 'http';
}

export function isInMemorySpec(spec: McpServerSpec): spec is InMemoryMcpServerSpec {
  return spec.kind === 'in-memory';
}
