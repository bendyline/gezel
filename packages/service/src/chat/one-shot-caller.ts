/**
 * True when `sessionId` holds a running slot in `queue`. A one-shot that this
 * session's turn is waiting on — a script started by its tool call asking
 * `llm.oneShot` — can only queue behind it there: the turn keeps the slot for
 * its whole tool loop, so on a one-slot engine (ds4, Ollama) nothing reaches
 * the engine until the deadline. Such a one-shot skips the queue, the same
 * bypass an `ask_gezel` target gets; the engine's own request gate still
 * serializes generations, and the waiting turn has released it.
 */
export function sessionHoldsQueueSlot(
  queue: { describe(): { active: ReadonlyArray<{ sessionId?: string }> } } | undefined,
  sessionId: string | undefined,
): boolean {
  if (!queue || !sessionId) return false;
  return queue.describe().active.some((entry) => entry.sessionId === sessionId);
}
