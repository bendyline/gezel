import type { SessionOpts } from './types.js';

export type TerminalToolPolicy = NonNullable<SessionOpts['terminalToolPolicy']>;

export const TERMINAL_ACTION_SKIPPED_OUTPUT =
  '[runtime] Skipped because an earlier terminal action in this tool batch succeeded. Ownership has transferred; end the turn without further side effects.';

/**
 * Runtime-owned terminal tools. These are terminal because their successful
 * side effect transfers ownership away from the current model turn, not
 * because a particular project profile opted into a closing policy.
 *
 * `advance_task_step` is the important case: once it activates the successor
 * step, the old step's session is stale. Asking that model for another
 * generation lets it keep writing after handoff (and, with prose salvage,
 * overwrite the deliverable that just cleared the gate).
 */
const BUILTIN_TERMINAL_TOOLS = new Set(['advance_task_step']);

function compactClosing(text: string, fallback: string, maxChars: number): string {
  const compact = (text.trim() || fallback).replace(/\s+/g, ' ');
  const max = Math.max(1, maxChars);
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

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
  if (output.trimStart().startsWith('ERROR:')) return null;
  if (BUILTIN_TERMINAL_TOOLS.has(toolName)) {
    return compactClosing(output, 'Step completed and handed off.', 280);
  }
  if (!policy?.toolNames.includes(toolName)) return null;
  const fromArg =
    policy.closingArg && typeof args[policy.closingArg] === 'string'
      ? (args[policy.closingArg] as string)
      : '';
  return compactClosing(fromArg, policy.fallbackText.trim(), policy.maxClosingChars ?? 180);
}
