/**
 * One-shot "open this Handboek article" intent handed from the titlebar
 * search to `HandboekView`. Same mailbox pattern as
 * [pending-open-file.ts](./pending-open-file.ts): the search queues the
 * intent before dispatching `gezel:open-tab` (which mounts the Handboek
 * area), and the freshly-mounted view consumes it; the live
 * `gezel:open-handboek-article` event covers the already-open case.
 */

export interface OpenHandboekIntent {
  articleId: string;
}

interface StoredIntent extends OpenHandboekIntent {
  at: number;
}

const INTENT_TTL_MS = 10_000;

let pending: StoredIntent | null = null;

export function queueOpenHandboek(intent: OpenHandboekIntent): void {
  pending = { ...intent, at: Date.now() };
}

export function consumeOpenHandboek(): OpenHandboekIntent | null {
  if (!pending) return null;
  const { at, ...intent } = pending;
  pending = null;
  if (Date.now() - at > INTENT_TTL_MS) return null;
  return intent;
}
