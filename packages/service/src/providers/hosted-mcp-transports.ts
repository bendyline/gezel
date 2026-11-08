/**
 * Whether a provider can reach a hosted MCP server over this transport.
 *
 * The managed bridge, the Copilot SDK and Claude CLI each take Streamable
 * HTTP and SSE. Codex's config takes a URL only as Streamable HTTP: an SSE
 * server gets a streamable POST, answers 404, and Codex drops it at startup
 * (checked against codex-cli 0.160.0). The chat manager reads this for both
 * the prompt's toolset roster and the servers it hands the provider, so the
 * two cannot disagree.
 */
export function providerCanReachHostedMcp(
  providerName: string | undefined,
  transport: 'streamable-http' | 'sse',
): boolean {
  return transport === 'streamable-http' || providerName !== 'codex-cli';
}
