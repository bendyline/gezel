/**
 * Friendly-display utilities for the tool names that flow through the
 * chat event stream.
 *
 * Background: Claude CLI references MCP tools as `mcp__<server>__<tool>`
 * (e.g. `mcp__gezel__read_task_notes`, `mcp__playwright_mcp__browser_navigate`).
 * The raw form leaks our wire-protocol naming into UI surfaces — both
 * tool-call rows and intent breadcrumbs. Stripping the prefix and
 * humanizing the underscores gives the user a name they can actually
 * read ("read task notes" / "browser navigate") without us having to
 * thread the rich per-tool display map (lives in the UI layer) through
 * every code path.
 *
 * Shared between service and UI so service-emitted intent labels
 * ("using <tool>", "approved: <tool>", "awaiting your approval to use
 * <tool>") and UI-side tool-row rendering use the same conventions.
 */

/**
 * Strip Claude CLI's `mcp__<server>__` prefix from a tool name. The
 * format is two-underscore-delimited (`__`) so server names that
 * themselves contain a single underscore (e.g. `playwright_mcp`) split
 * cleanly. Tools without the prefix (Claude built-ins like `Bash`,
 * `Read`; or gezel-mcp tools referenced bare like `save_memory` from
 * inside our own bridge) pass through unchanged.
 */
export function stripMcpPrefix(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  if (parts.length < 3) return name;
  // Tool name is everything after the second `__`. Re-join in case the
  // tool itself contained `__` (not a real case today, but safe).
  return parts.slice(2).join('__');
}

/**
 * Lightweight humanizer for tool names. Strips the MCP prefix and
 * replaces underscores with spaces. Returns lowercase — callers that
 * want title-case render via CSS (`text-transform: capitalize`) or
 * apply their own casing.
 *
 * Doesn't carry a rich per-tool display map — the UI's
 * `toolDisplayName` does that on top of `stripMcpPrefix`. This helper
 * is for service-side intent labels where the rich map isn't worth
 * threading through and a humanized fallback is enough.
 */
export function prettifyToolName(name: string): string {
  return stripMcpPrefix(name).replace(/_/g, ' ');
}

/**
 * Short, transient status text for a tool that is currently running.
 * Concrete tools keep their humanized name so the user sees useful
 * progress ("advance task step"), while provider-level implementation
 * buckets get a natural-language activity instead of protocol jargon.
 */
export function toolActivityLabel(name: string): string {
  const friendly = prettifyToolName(name);
  switch (friendly.toLowerCase()) {
    case 'shell':
    case 'bash':
    case 'command execution':
      return 'running a command';
    case 'file change':
      return 'updating files';
    case 'web search':
      return 'searching the web';
    case 'mcp tool call':
      return 'working';
    default:
      return friendly;
  }
}
