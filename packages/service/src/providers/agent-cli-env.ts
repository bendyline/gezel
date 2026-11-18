/**
 * The environment a CLI agent (Claude Code, Codex) runs with. Its own shell
 * inherits it, so it carries none of Gezel's variables and none of the
 * secret-shaped ones the person exported (`GH_TOKEN`, another provider's
 * key), only the sign-in variables that CLI reads for itself. The gezel MCP
 * server it starts gets its own variables from its config, not from here.
 */

import { createLogger } from '@bendyline/gezel';
import { filterMcpChildEnv } from './mcp-bridge.js';

const log = createLogger('agent-cli');

/** Sign-in variables Claude Code reads (API key, OAuth, Bedrock, Vertex). */
export const CLAUDE_CLI_AUTH_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/** Sign-in variables Codex reads when it is not using its own login. */
export const CODEX_CLI_AUTH_ENV: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
];

export function agentCliEnv(
  src: NodeJS.ProcessEnv,
  authVars: readonly string[],
): Record<string, string> {
  const out = filterMcpChildEnv(src);
  for (const name of Object.keys(out)) {
    if (name.toUpperCase().startsWith('GEZEL_')) delete out[name];
  }
  for (const name of authVars) {
    const value = src[name];
    if (value != null) out[name] = value;
  }
  return out;
}

/**
 * The gezel MCP server's env with its session token replaced by a fresh
 * short-lived code it trades for the token at startup, so the config file a
 * CLI agent's own tools can read never holds a live token. Without a minter,
 * or if minting fails, the env is unchanged.
 */
export function withMcpBootstrapCode(
  env: Record<string, string>,
  mint: (() => string) | undefined,
): Record<string, string> {
  if (!mint || !env.GEZEL_TOKEN) return env;
  let code: string;
  try {
    code = mint();
  } catch (err) {
    log.warn(
      `MCP bootstrap code not minted; the config keeps the session token: ${err instanceof Error ? err.message : String(err)}`,
    );
    return env;
  }
  const { GEZEL_TOKEN: _token, ...rest } = env;
  return { ...rest, GEZEL_TOKEN_CODE: code };
}
