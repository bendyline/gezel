/**
 * One-shot "focus this chat session" intent handed from the titlebar search
 * to `GezelChatTab`. Same mailbox pattern as
 * [pending-open-file.ts](./pending-open-file.ts): selecting a session result
 * dispatches `gezel:open-tab` (which mounts the gezel view) and the freshly
 * mounted view's listener isn't up in time for a same-tick
 * `gezel:open-session` event, so the intent is queued first and consumed on
 * mount. The live event still covers the already-open case.
 */

export interface OpenSessionIntent {
  gezelId: string;
  sessionId: string;
  projectId?: string;
}

interface StoredIntent extends OpenSessionIntent {
  at: number;
}

const INTENT_TTL_MS = 10_000;

let pending: StoredIntent | null = null;

export function queueOpenSession(intent: OpenSessionIntent): void {
  pending = { ...intent, at: Date.now() };
}

export function consumeOpenSession(gezelId: string): OpenSessionIntent | null {
  if (!pending) return null;
  if (pending.gezelId !== gezelId) return null;
  const { at, ...intent } = pending;
  pending = null;
  if (Date.now() - at > INTENT_TTL_MS) return null;
  return intent;
}
