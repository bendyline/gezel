/**
 * One-shot mailbox for "open this knowledge document" navigation — the same
 * contract as pending-open-handboek: a titlebar search pick queues the
 * intent BEFORE dispatching the area tab, so the freshly-mounted
 * KnowledgeView consumes it as its initial selection; a TTL keeps a stale
 * intent from hijacking an unrelated later visit.
 */

import type { SearchMedia } from '@bendyline/gezel';

export interface OpenKnowledgeIntent {
  catalogId: string;
  documentId?: string;
  /** A media hit: the photo, clip or recording to show, and the moment that matched. */
  media?: SearchMedia;
}

interface StoredIntent extends OpenKnowledgeIntent {
  at: number;
}

const INTENT_TTL_MS = 10_000;

let pending: StoredIntent | null = null;

export function queueOpenKnowledge(intent: OpenKnowledgeIntent): void {
  pending = { ...intent, at: Date.now() };
}

export function consumeOpenKnowledge(): OpenKnowledgeIntent | null {
  if (!pending) return null;
  const { at, ...intent } = pending;
  pending = null;
  if (Date.now() - at > INTENT_TTL_MS) return null;
  return intent;
}
