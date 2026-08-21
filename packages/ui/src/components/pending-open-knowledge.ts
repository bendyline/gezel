/**
 * One-shot mailbox for "open this knowledge document" navigation — the same
 * contract as pending-open-handboek: a titlebar search pick queues the
 * intent BEFORE dispatching the area tab, so the freshly-mounted
 * KnowledgeView consumes it as its initial selection; a TTL keeps a stale
 * intent from hijacking an unrelated later visit.
 */

export interface OpenKnowledgeIntent {
  catalogId: string;
  documentId?: string;
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
