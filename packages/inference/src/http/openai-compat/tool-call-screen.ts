import {
  type EgressIndicator,
  describeEgressIndicators,
  findEgressIndicators,
  findEgressIndicatorsInValue,
} from '@bendyline/gezel';
import type { ExternalToolCall } from '@bendyline/gezel/local-loop';

/**
 * Screens the tool calls a `/v1` turn hands back to the calling app.
 *
 * On these surfaces the app runs the tools, often with a real shell (Codex,
 * OpenCode, Pi on a local model), so the response is the last place Gezel
 * sees a call before it runs. A call naming an egress indicator (core
 * `security/egress-indicators.ts`) never reaches the app as a runnable call;
 * the reply says so instead.
 */
export interface ToolCallScreen {
  /** The calls the app may run. Records the rest. */
  admit(calls: readonly ExternalToolCall[]): ExternalToolCall[];
  /** True when this call must not reach the app. Records it. */
  blocks(name: string, args: string): boolean;
  /** A line for the visible reply once anything was blocked. */
  notice(): string | undefined;
}

export function createToolCallScreen(
  onBlocked?: (tool: string, indicators: EgressIndicator[]) => void,
): ToolCallScreen {
  const blocked: string[] = [];
  const seen = new Set<string>();
  const blocks = (name: string, args: string): boolean => {
    const indicators = indicatorsIn(args);
    if (indicators.length === 0) return false;
    // The serializer and the final reconciliation can both see one call.
    const key = `${name}\u0000${args}`;
    if (!seen.has(key)) {
      seen.add(key);
      blocked.push(`${name} (it named ${describeEgressIndicators(indicators)})`);
      onBlocked?.(name, indicators);
    }
    return true;
  };
  return {
    admit: (calls) => calls.filter((call) => !blocks(call.name, call.arguments)),
    blocks,
    notice: () =>
      blocked.length === 0
        ? undefined
        : `\n\n[Gezel stopped ${blocked.length === 1 ? 'a tool call' : `${blocked.length} tool calls`} before ${blocked.length === 1 ? 'it' : 'they'} ran: ${blocked.join('; ')}.]`,
  };
}

function indicatorsIn(args: string): EgressIndicator[] {
  try {
    return findEgressIndicatorsInValue(JSON.parse(args));
  } catch {
    return findEgressIndicators(args);
  }
}

/**
 * The part of a live-streamed argument string that is safe to send before
 * the call has been screened: everything but a trailing run of closing
 * brackets and whitespace. A tool call's arguments are a JSON object, which
 * must end in `}`, so a client cannot parse — and so cannot run — a call
 * until the screened tail arrives. Grows monotonically as `received` grows.
 */
export function screenableArgumentsPrefix(received: string): string {
  return received.replace(/[\s}\]]+$/, '');
}
