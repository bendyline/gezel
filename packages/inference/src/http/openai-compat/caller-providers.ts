import type { ProviderName } from '../../providers/types.js';

/**
 * Providers that run an agent with its own tools on this computer: the
 * Claude Code and Codex command lines. Their sessions read files and run
 * commands as the person.
 */
export const AGENT_CLI_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'anthropic-cli',
  'codex-cli',
]);

/**
 * Whether a turn that another app owns (the `/v1` and Ollama surfaces, the
 * Codex, OpenCode, pi and VS Code bridges, Ollama emulation) may run on
 * `provider`. Those callers hold an `openai`-scope token Gezel hands out
 * without a code, or no token at all on the emulated Ollama port, so a
 * Codex agent behind them was a shell for any local program: asked to print
 * `runtime/auth-token`, it did. The one-shot path is now read-only with no
 * shell, but an agent CLI that ships a new built-in tool would reopen it.
 */
export function servesCallerOwnedTurns(provider: ProviderName): boolean {
  return !AGENT_CLI_PROVIDERS.has(provider);
}

/**
 * Why a caller-owned turn may not run on this target, or null when it may.
 * A `gezel:` target counts by the provider the gezel resolved to.
 */
export function callerOwnedTargetRefusal(target: {
  provider: ProviderName;
  gezelId?: string;
}): string | null {
  if (servesCallerOwnedTurns(target.provider)) return null;
  const agent = target.provider === 'codex-cli' ? 'Codex' : 'Claude Code';
  return target.gezelId
    ? `This gezel runs on ${agent}, which runs its own tools on this computer, so Gezel does not serve it to other apps. Choose a gezel on an on-device or cloud model.`
    : `${agent} runs its own tools on this computer, so Gezel does not serve it to other apps. Choose an on-device or cloud model.`;
}
