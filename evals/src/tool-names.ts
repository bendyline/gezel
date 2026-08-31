/**
 * One normalization for tool names across every provider surface.
 *
 * Providers spell the same capability three ways and the harness has now
 * been bitten by each of them:
 *   - gezel-mcp over a CLI provider: `mcp__gezel__append_to_file`
 *   - the Claude CLI's built-ins: `Write`, `Edit`, `Read`
 *   - a local engine's plain MCP bridge: `append_to_file`
 *
 * Matching only the bare gezel-mcp spelling made `sessionReadPaths` blind
 * to every seeded read on the Claude CLI provider, which booked winnable
 * scenarios as MODEL failures. Anything that classifies a tool call by
 * name goes through here so that class of bug has exactly one home.
 */

/** Strip an MCP namespace prefix: `mcp__gezel__read_file` -> `read_file`. */
export function bareToolName(name: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return (match?.[1] ?? name).toLowerCase();
}
