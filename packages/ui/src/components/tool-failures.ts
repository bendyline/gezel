import type { ChatMessageToolCall } from '@bendyline/gezel';
import { toolErrorSummary } from './tool-display.js';

/** Most failures a reader needs to see at once. Beyond this the expando
 *  is the right surface — the notice is a headline, not a log. */
export const VISIBLE_TOOL_FAILURES = 2;

/**
 * Failures the turn never recovered from, newest last.
 *
 * A failure superseded by a later success of the same tool is resolved —
 * the model corrected its arguments and moved on, and surfacing it would
 * make a self-healed turn read as broken. What survives is the case that
 * actually cost the user something: a completion gate that rejected the
 * work, a tool that never came back. Mirrors the service's
 * `unresolvedFailedToolCalls`, which builds the model's recovery nudge
 * from the same rule.
 */
export function unresolvedToolFailures(
  tools: ReadonlyArray<Pick<ChatMessageToolCall, 'name' | 'success' | 'errorMessage'>>,
): Array<{ name: string; reason: string }> {
  return tools
    .filter(
      (t, i) =>
        !t.success && !tools.slice(i + 1).some((later) => later.name === t.name && later.success),
    )
    .map((t) => ({ name: t.name, reason: t.errorMessage ? toolErrorSummary(t.errorMessage) : '' }))
    .filter((f) => f.reason.length > 0);
}

/**
 * A failure reason written for a program rather than a person: a JSON
 * envelope, or a stack trace. A person reading the conversation learns
 * nothing from either.
 */
export function isMachinePayload(reason: string): boolean {
  return /^\s*[[{]/.test(reason) || /\n\s+at\s+\S/.test(reason);
}
