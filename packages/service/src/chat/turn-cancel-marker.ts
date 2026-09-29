import type { TurnCancelReason } from '@bendyline/gezel';

/**
 * A turn someone stopped on purpose rejects with whatever the provider threw
 * on abort, which reads exactly like a failure. Code that retries failures
 * (the task handoff loop) needs to tell the two apart, or it re-sends a step
 * the user just stopped. The reason rides on the error under a symbol, so it
 * never reaches a message, a log line, or a serialized error.
 */
const CANCEL_REASON = Symbol('gezel.turnCancelReason');

type MarkedError = Error & { [CANCEL_REASON]?: TurnCancelReason };

/** Record on `err` that its turn was cancelled on purpose, and why. */
export function markTurnCancelled(err: unknown, reason: TurnCancelReason): void {
  if (!(err instanceof Error)) return;
  try {
    Object.defineProperty(err, CANCEL_REASON, { value: reason, configurable: true });
  } catch {
    // A frozen error cannot carry the mark; its turn is treated as failed.
  }
}

/** Why the turn that threw `err` was cancelled, or undefined for a genuine failure. */
export function turnCancelReasonOf(err: unknown): TurnCancelReason | undefined {
  return err instanceof Error ? (err as MarkedError)[CANCEL_REASON] : undefined;
}
