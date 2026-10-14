/**
 * The composer's in-memory index over the prompt drafts on disk.
 *
 * Drafts themselves live in the project's artifact drawer
 * (`artifacts/prompts/<draftId>/`) and are the source of truth. What stays in
 * memory is only what makes returning to a conversation feel instant:
 *
 * - **which draft each composer surface had open**, so coming back to a
 *   thread reopens the same one rather than guessing from a list; and
 * - **the last text we knew for a draft**, so the editor paints immediately
 *   on mount instead of flashing empty until the GET lands.
 *
 * Both are caches. Losing either costs a fetch and nothing else — which is
 * the whole point of the change: before this, losing them cost the user their
 * message.
 *
 * Keep this module editor-free for the same reason `composer-prefill.ts` is:
 * surfaces that only want to read or drop a draft must not pull the Squisq
 * editor into their navigation chunk.
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
 * One composer surface pointed at one thread. Unlike the address, this DOES
 * include the session: a draft now belongs to the thread it is addressed to,
 * and picking another thread should bring up that thread's own draft.
 * `sessionId: null` is the thread that does not exist yet.
 */
export interface PromptDraftSlot extends ComposerDraftAddress {
  sessionId: string | null;
}

const MAX_ENTRIES = 64;

/** slot key → the draft id that slot had open. */
const activeDrafts = new Map<string, string>();
/** draft id → last known markdown. Insertion order is the LRU order. */
const draftText = new Map<string, string>();

export function composerDraftKey(address: ComposerDraftAddress): string {
  return [
    address.scope ?? 'chat',
    address.projectId,
    address.gezelId,
    address.taskRef ?? '',
    address.craftbookRef ?? '',
  ].join('|');
}

export function promptDraftSlotKey(slot: PromptDraftSlot): string {
  return `${composerDraftKey(slot)}|${slot.sessionId ?? 'new'}`;
}

export function readActiveDraftId(slotKey: string): string | undefined {
  return activeDrafts.get(slotKey);
}

export function writeActiveDraftId(slotKey: string, draftId: string | undefined): void {
  if (!draftId) {
    activeDrafts.delete(slotKey);
    return;
  }
  activeDrafts.delete(slotKey);
  activeDrafts.set(slotKey, draftId);
  while (activeDrafts.size > MAX_ENTRIES) {
    const oldest = activeDrafts.keys().next();
    if (oldest.done) break;
    activeDrafts.delete(oldest.value);
  }
}

/**
 * Readers that want to follow the text as it is typed — the thread picker
 * names the draft the composer is writing, and the draft has no name until
 * this cache has its first autosave. Notified on every write, which is the
 * autosave cadence (about once a second), not the keystroke one.
 */
const textListeners = new Set<() => void>();

export function subscribeDraftText(listener: () => void): () => void {
  textListeners.add(listener);
  return () => {
    textListeners.delete(listener);
  };
}

function notifyDraftText(): void {
  for (const listener of textListeners) listener();
}

export function readDraftText(draftId: string): string | undefined {
  return draftText.get(draftId);
}

export function writeDraftText(draftId: string, source: string): void {
  draftText.delete(draftId);
  draftText.set(draftId, source);
  while (draftText.size > MAX_ENTRIES) {
    const oldest = draftText.keys().next();
    if (oldest.done) break;
    draftText.delete(oldest.value);
  }
  notifyDraftText();
}

/** Drop a draft's text and every slot still pointing at it. */
export function forgetDraft(draftId: string): void {
  draftText.delete(draftId);
  for (const [slotKey, id] of activeDrafts) {
    if (id === draftId) activeDrafts.delete(slotKey);
  }
  notifyDraftText();
}

/**
 * Drafts this window has sent. A host may accept a send before it marks the
 * draft sent (the phone does while the thread is still busy and the message
 * queues), so for a moment the draft still lists as open. Reopening it in
 * that window binds the composer to a draft that is sent a second later, and
 * everything typed next fails to save and fails to send.
 */
const sentDrafts = new Set<string>();

export function noteDraftSent(draftId: string): void {
  sentDrafts.delete(draftId);
  sentDrafts.add(draftId);
  while (sentDrafts.size > MAX_ENTRIES) {
    const oldest = sentDrafts.values().next();
    if (oldest.done) break;
    sentDrafts.delete(oldest.value);
  }
}

export function wasDraftSent(draftId: string): boolean {
  return sentDrafts.has(draftId);
}

/**
 * Writes that outlive the composer that started them. A phone's navigation
 * unmounts the chat, so a person who types and taps away at once leaves while
 * the draft is still being created or its last edits are still on the wire. A
 * surface that comes back must wait for those before it asks the daemon, or it
 * reads the disk a moment too early and opens empty or a second behind.
 */
const creatingBySlot = new Map<string, Promise<void>>();
const flushingByDraft = new Map<string, Promise<void>>();

function track(map: Map<string, Promise<void>>, key: string, work: Promise<unknown>): void {
  const settled: Promise<void> = work.then(
    () => {},
    () => {},
  );
  map.set(key, settled);
  void settled.then(() => {
    if (map.get(key) === settled) map.delete(key);
  });
}

/** A draft is being created for this slot; resolves once it is on disk (or failed). */
export function noteDraftCreating(slotKey: string, work: Promise<unknown>): void {
  track(creatingBySlot, slotKey, work);
}

export function draftCreating(slotKey: string): Promise<void> | undefined {
  return creatingBySlot.get(slotKey);
}

/** A closing flush of this draft's latest text is in flight. */
export function noteDraftFlushing(draftId: string, work: Promise<unknown>): void {
  track(flushingByDraft, draftId, work);
}

export function draftFlushing(draftId: string): Promise<void> | undefined {
  return flushingByDraft.get(draftId);
}

/** Re-point a slot's draft — used when an address moves under a live composer. */
export function moveActiveDraftId(
  fromKey: string,
  toKey: string,
  draftId: string | undefined,
): void {
  if (fromKey === toKey) return;
  activeDrafts.delete(fromKey);
  writeActiveDraftId(toKey, draftId);
}

/** Test seam. */
export function resetComposerDrafts(): void {
  activeDrafts.clear();
  draftText.clear();
  sentDrafts.clear();
  creatingBySlot.clear();
  flushingByDraft.clear();
  notifyDraftText();
}
