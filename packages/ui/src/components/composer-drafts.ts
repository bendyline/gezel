/**
 * In-memory drafts for the chat composer, keyed by chat surface.
 *
 * Every chat surface (Home's meester conversation, a gezel tab, a project
 * chat, a task pane) unmounts the moment the user navigates elsewhere — the
 * app keys `TabContent` on the selection and `HomeView` is swapped out
 * wholesale. Before this store existed, the composer's `draftRef` died with
 * the mount, so a half-written message was silently discarded by a trip to
 * Settings and back.
 *
 * Keep this module editor-free for the same reason `composer-prefill.ts` is:
 * surfaces that only want to read or drop a draft must not pull the Squisq
 * editor into their navigation chunk.
 *
 * Drafts are deliberately memory-only, not `localStorage`. The markdown holds
 * `attachments/<file>` refs that resolve against a specific project's artifact
 * drawer, so a draft that outlived the daemon could reference bytes that are
 * no longer there. Session lifetime is the honest lifetime.
 */

export interface ComposerDraftAddress {
  /**
   * Distinguishes surfaces that would otherwise collide on the same
   * (project, gezel) pair — the meester conversation and that gezel's own
   * chat tab, for instance. Omit for the ordinary per-project chat.
   */
  scope?: string;
  projectId: string;
  gezelId: string;
  /**
   * Task-scoped panes address their own drafts. Deliberately NOT joined with
   * `stepId`: a task advancing a step would otherwise orphan the draft the
   * user is in the middle of typing.
   */
  taskRef?: string;
  craftbookRef?: string;
}

/**
 * Bound on retained drafts. A draft is a few KB of markdown at most, and the
 * cap only ever evicts the least-recently-written surface, so the practical
 * effect is nil — it exists so a long session that visits hundreds of chats
 * cannot accumulate unboundedly.
 */
const MAX_DRAFTS = 64;

/** Insertion order is the LRU order — every write re-inserts. */
const drafts = new Map<string, string>();

export function composerDraftKey(address: ComposerDraftAddress): string {
  return [
    address.scope ?? 'chat',
    address.projectId,
    address.gezelId,
    address.taskRef ?? '',
    address.craftbookRef ?? '',
  ].join('|');
}

export function readComposerDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Storing an all-whitespace draft drops the entry — an empty composer is not a draft. */
export function writeComposerDraft(key: string, source: string): void {
  if (!source.trim()) {
    drafts.delete(key);
    return;
  }
  drafts.delete(key);
  drafts.set(key, source);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
}

export function clearComposerDraft(key: string): void {
  drafts.delete(key);
}

/**
 * Re-file a live draft under a new address. The composer keeps its text when
 * its own address moves under it — an @-mention pivot in project chat, a
 * recipient swap from the To-line picker — so the stored copy has to follow
 * rather than being swapped out for whatever the new address held.
 */
export function moveComposerDraft(fromKey: string, toKey: string, source: string): void {
  if (fromKey === toKey) return;
  drafts.delete(fromKey);
  writeComposerDraft(toKey, source);
}

/** Test seam. */
export function resetComposerDrafts(): void {
  drafts.clear();
}
