import type { SessionOpts } from './types.js';

export type TerminalToolPolicy = NonNullable<SessionOpts['terminalToolPolicy']>;

/**
 * Return the one-line reply for a successful terminal action tool.
 * Errors never terminate: their detailed output must go back through the
 * ordinary tool loop so the model can correct its arguments.
 */
export function terminalToolClosingText(
  policy: TerminalToolPolicy | undefined,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string | null {
  if (!policy?.toolNames.includes(toolName) || output.trimStart().startsWith('ERROR:')) return null;
  const fromArg =
    policy.closingArg && typeof args[policy.closingArg] === 'string'
      ? (args[policy.closingArg] as string)
      : '';
  const compact = (fromArg.trim() || policy.fallbackText.trim()).replace(/\s+/g, ' ');
  const max = Math.max(1, policy.maxClosingChars ?? 180);
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}
