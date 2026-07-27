/**
 * One-shot "scroll to the failed turn" intent handed from the sidebar's
 * per-project failed-turn indicator to the chat timeline. Clicking the
 * indicator selects the project, which mounts (or remounts) the project view
 * and its timeline — too late for a same-tick `gezel:focus-session-error`
 * event to be heard. Same mailbox pattern as
 * [pending-open-file.ts](./pending-open-file.ts): queue the intent before
 * navigating, consume it when the timeline for that project mounts.
 *
 * The companion live `gezel:focus-session-error` event covers the
 * already-open-project case (no remount) and drains the mailbox so a stale
 * intent can't fire on a later manual navigation.
 */

export interface FocusSessionErrorIntent {
  projectId: string;
  sessionId: string;
}

interface StoredIntent extends FocusSessionErrorIntent {
  at: number;
}

/** Intents older than this are ignored — a safety net against stale jumps. */
const INTENT_TTL_MS = 10_000;

let pending: StoredIntent | null = null;

/** Record that the user asked to see `sessionId`'s failed turn. */
export function queueFocusSessionError(intent: FocusSessionErrorIntent): void {
  pending = { ...intent, at: Date.now() };
}

/**
 * Consume a pending focus intent for `projectId`; returns it (clearing the
 * mailbox) or null. Expired intents are dropped without firing.
 */
export function consumeFocusSessionError(projectId: string): FocusSessionErrorIntent | null {
  if (!pending) return null;
  if (pending.projectId !== projectId) return null;
  const { at, ...intent } = pending;
  pending = null;
  if (Date.now() - at > INTENT_TTL_MS) return null;
  return intent;
}
