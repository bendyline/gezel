import type { PromptDraftMeta, PromptDraftSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  type AutosavePhase,
  SerializedAutosaveController,
} from '../hooks/useSerializedAutosave.js';
import {
  type ComposerDraftAddress,
  forgetDraft,
  promptDraftSlotKey,
  readActiveDraftId,
  readDraftText,
  writeActiveDraftId,
  writeDraftText,
} from './composer-drafts.js';

/**
 * The composer's half of prompt drafts: owns which draft is open, creates one
 * the moment there is something to keep, and autosaves it.
 *
 * Rules that are easy to get wrong and expensive when wrong:
 *
 * - **The hook never owns the text.** The composer's `draftRef` does, because
 *   the editor is a black box that reports changes and cannot be driven
 *   character by character. The hook is told what the text is and decides what
 *   to persist.
 * - **A draft is created lazily, exactly once.** Three things can trigger it
 *   (a keystroke, a paste, a send) and they can race, so the creation promise
 *   is memoized and every path awaits the same one.
 * - **Nothing is written for an empty composer.** A draft only comes into
 *   being when there is something to lose.
 * - **Forgetting is synchronous.** After a send, the editor remounts and
 *   emits its (now empty) content; if the hook still knew the draft id at
 *   that moment it would helpfully erase the message the user just sent.
 */

export interface UsePromptDraftOptions {
  address: ComposerDraftAddress;
  sessionId: string | undefined;
  /** Controlled selection: a draft picked from the thread picker. */
  draftId?: string | undefined;
  onDraftIdChange?: (draftId: string | undefined) => void;
  /** Read the live editor source. */
  getText: () => string;
  /** The loaded draft differs from what is on screen — swap the editor to it. */
  onLoaded: (markdown: string, meta: PromptDraftSummary) => void;
}

export interface PromptDraftAutosave {
  phase: AutosavePhase;
  dirty: boolean;
  error: Error | null;
  retry: () => Promise<void>;
}

export interface PromptDraftController {
  draftId: string | null;
  meta: PromptDraftMeta | null;
  /** The user explicitly chose to start a new thread with this draft. */
  isFreshThread: boolean;
  autosave: PromptDraftAutosave;
  update: (markdown: string) => void;
  ensureDraft: () => Promise<string>;
  flush: () => Promise<void>;
  markSent: () => void;
  discard: () => Promise<void>;
  noteFileAdded: () => void;
}

const DEBOUNCE_MS = 1000;

export function usePromptDraft(options: UsePromptDraftOptions): PromptDraftController {
  const {
    address,
    sessionId,
    draftId: selectedDraftId,
    onDraftIdChange,
    getText,
    onLoaded,
  } = options;

  // Keyed on the address's fields rather than the object: the composer
  // rebuilds that object every render, and a slot key that changed identity
  // every render would restart the load effect forever.
  const { scope: addressScope, projectId, gezelId, taskRef, craftbookRef } = address;
  const slotKey = useMemo(
    () =>
      promptDraftSlotKey({
        ...(addressScope ? { scope: addressScope } : {}),
        projectId,
        gezelId,
        ...(taskRef ? { taskRef } : {}),
        ...(craftbookRef ? { craftbookRef } : {}),
        sessionId: sessionId ?? null,
      }),
    [addressScope, projectId, gezelId, taskRef, craftbookRef, sessionId],
  );

  const [draftId, setDraftIdState] = useState<string | null>(
    () => selectedDraftId ?? readActiveDraftId(slotKey) ?? null,
  );
  const [meta, setMeta] = useState<PromptDraftMeta | null>(null);
  const [autosaveSnapshot, setAutosaveSnapshot] = useState<{
    phase: AutosavePhase;
    dirty: boolean;
    error: Error | null;
  }>({ phase: 'idle', dirty: false, error: null });

  // Refs shadow the state wherever a decision must be made synchronously —
  // a send clearing the editor cannot wait for a re-render.
  const draftIdRef = useRef<string | null>(draftId);
  const slotKeyRef = useRef(slotKey);
  const hasFilesRef = useRef(false);
  const bornWithoutSessionRef = useRef(sessionId === undefined);
  const freshThreadRef = useRef(false);
  const creatingRef = useRef<Promise<string> | null>(null);
  const discardedRef = useRef(false);
  const generationRef = useRef(0);
  const getTextRef = useRef(getText);
  getTextRef.current = getText;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onDraftIdChangeRef = useRef(onDraftIdChange);
  onDraftIdChangeRef.current = onDraftIdChange;
  const addressRef = useRef(address);
  addressRef.current = address;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const setDraftId = useCallback((next: string | null) => {
    draftIdRef.current = next;
    setDraftIdState(next);
  }, []);

  // One save lane per draft. Rebuilt when the draft changes, which is exactly
  // the generation boundary the autosave controller is designed around.
  const controllerRef = useRef<SerializedAutosaveController<void> | null>(null);
  const controllerDraftRef = useRef<string | null>(null);

  const saveDraft = useCallback(
    async (value: string): Promise<void> => {
      const id = draftIdRef.current;
      if (!id) return;
      const projectId = addressRef.current.projectId;
      // A draft with no words and nothing attached is not a draft. Delete it
      // rather than leaving a blank row in the picker, and forget it locally so
      // the next keystroke starts a fresh one.
      if (!value.trim() && !hasFilesRef.current) {
        await api.deletePromptDraft(projectId, id).catch(() => {});
        forgetDraft(id);
        writeActiveDraftId(slotKeyRef.current, undefined);
        controllerRef.current = null;
        controllerDraftRef.current = null;
        setDraftId(null);
        setMeta(null);
        onDraftIdChangeRef.current?.(undefined);
        return;
      }
      try {
        const result = await api.writePromptDraftContent(projectId, id, value);
        if (result.deleted) {
          forgetDraft(id);
          writeActiveDraftId(slotKeyRef.current, undefined);
          setDraftId(null);
          setMeta(null);
          onDraftIdChangeRef.current?.(undefined);
          return;
        }
        if (result.draft) {
          setMeta(result.draft);
          hasFilesRef.current = result.draft.hasFiles;
        }
        writeDraftText(id, value);
      } catch (err) {
        // The draft was swept or deleted elsewhere. Drop the id so the next
        // edit recreates one instead of writing into a void forever.
        if (isNotFound(err)) {
          forgetDraft(id);
          writeActiveDraftId(slotKeyRef.current, undefined);
          setDraftId(null);
          setMeta(null);
          onDraftIdChangeRef.current?.(undefined);
          return;
        }
        throw err;
      }
    },
    [setDraftId],
  );

  const laneFor = useCallback(
    (id: string): SerializedAutosaveController<void> => {
      if (controllerRef.current && controllerDraftRef.current === id) {
        controllerRef.current.configure(saveDraft);
        return controllerRef.current;
      }
      const controller = new SerializedAutosaveController<void>({
        resourceKey: `prompt-draft:${addressRef.current.projectId}:${id}`,
        initialValue: readDraftText(id) ?? '',
        save: saveDraft,
        debounceMs: DEBOUNCE_MS,
      });
      controller.subscribe((snapshot) => setAutosaveSnapshot(snapshot));
      controllerRef.current = controller;
      controllerDraftRef.current = id;
      return controller;
    },
    [saveDraft],
  );

  const ensureDraft = useCallback(async (): Promise<string> => {
    const existing = draftIdRef.current;
    if (existing) return existing;
    if (creatingRef.current) return creatingRef.current;
    const projectId = addressRef.current.projectId;
    const pending = (async () => {
      const created = await api.createPromptDraft(projectId, {
        gezelId: addressRef.current.gezelId,
        sessionId: sessionIdRef.current ?? null,
        content: getTextRef.current(),
        ...(addressRef.current.taskRef ? { taskRef: addressRef.current.taskRef } : {}),
        ...(addressRef.current.craftbookRef
          ? { craftbookRef: addressRef.current.craftbookRef }
          : {}),
        ...(addressRef.current.scope ? { scope: addressRef.current.scope } : {}),
      });
      // Discarded while the POST was in flight — clean up rather than
      // resurrecting a draft the user already threw away.
      if (discardedRef.current) {
        await api.deletePromptDraft(projectId, created.id).catch(() => {});
        throw new Error('draft discarded while it was being created');
      }
      bornWithoutSessionRef.current = sessionIdRef.current === undefined;
      hasFilesRef.current = created.hasFiles;
      writeActiveDraftId(slotKeyRef.current, created.id);
      setDraftId(created.id);
      setMeta(created);
      onDraftIdChangeRef.current?.(created.id);
      // Baseline the lane on what the server actually has, THEN hand it what
      // is on screen. Someone can keep typing through the round trip, and a
      // lane baselined on that newer text would consider it already saved.
      writeDraftText(created.id, created.content);
      const lane = laneFor(created.id);
      const live = getTextRef.current();
      if (live !== created.content) {
        writeDraftText(created.id, live);
        lane.update(live);
      }
      return created.id;
    })();
    creatingRef.current = pending;
    try {
      return await pending;
    } finally {
      if (creatingRef.current === pending) creatingRef.current = null;
    }
  }, [laneFor, setDraftId]);

  const update = useCallback(
    (markdown: string) => {
      const id = draftIdRef.current;
      if (id) {
        // Take the lane BEFORE touching the cache. The lane is built lazily
        // from the cached text as its already-saved baseline, so seeding the
        // cache first would make the very first edit after a draft is created
        // look like it had already been written, and it would sit unsaved
        // until the next keystroke.
        const lane = laneFor(id);
        writeDraftText(id, markdown);
        lane.update(markdown);
        return;
      }
      // Nothing to keep yet. An empty composer never creates a draft — the
      // feature is for words worth losing, and a folder per stray click would
      // fill the picker with blanks.
      if (!markdown.trim()) return;
      discardedRef.current = false;
      void ensureDraft().catch(() => {
        // Creation failed; the text is still in the editor and the next
        // keystroke tries again.
      });
    },
    [ensureDraft, laneFor],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (creatingRef.current) await creatingRef.current.catch(() => {});
    const id = draftIdRef.current;
    if (!id || controllerDraftRef.current !== id) return;
    await controllerRef.current?.flush().catch(() => {});
  }, []);

  /**
   * The draft became a message. Forget it synchronously — the editor is about
   * to remount empty, and a lane that still knew the id would write that
   * emptiness over the prompt the user just sent.
   */
  const markSent = useCallback(() => {
    const id = draftIdRef.current;
    if (!id) return;
    controllerRef.current = null;
    controllerDraftRef.current = null;
    forgetDraft(id);
    writeActiveDraftId(slotKeyRef.current, undefined);
    hasFilesRef.current = false;
    freshThreadRef.current = false;
    setDraftId(null);
    setMeta(null);
    setAutosaveSnapshot({ phase: 'idle', dirty: false, error: null });
    onDraftIdChangeRef.current?.(undefined);
  }, [setDraftId]);

  const discard = useCallback(async (): Promise<void> => {
    discardedRef.current = true;
    if (creatingRef.current) await creatingRef.current.catch(() => {});
    const id = draftIdRef.current;
    controllerRef.current = null;
    controllerDraftRef.current = null;
    hasFilesRef.current = false;
    freshThreadRef.current = false;
    setDraftId(null);
    setMeta(null);
    setAutosaveSnapshot({ phase: 'idle', dirty: false, error: null });
    onDraftIdChangeRef.current?.(undefined);
    if (!id) return;
    forgetDraft(id);
    writeActiveDraftId(slotKeyRef.current, undefined);
    await api.deletePromptDraft(addressRef.current.projectId, id).catch(() => {});
  }, [setDraftId]);

  /** An upload landed, so an empty-looking draft is no longer empty. */
  const noteFileAdded = useCallback(() => {
    hasFilesRef.current = true;
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    await controllerRef.current?.retry().catch(() => {});
  }, []);

  // Load a draft into the composer: seed instantly from what we last knew,
  // then reconcile with disk. `generation` guards against a slower fetch for a
  // thread the user has already left.
  const loadDraft = useCallback(
    async (id: string, generation: number) => {
      // Seed from what we last knew so the editor paints without waiting for
      // the round trip — but only into an empty composer. Text on screen is
      // always newer than the cache, and overwriting it is the one failure
      // this whole feature exists to prevent.
      const cached = readDraftText(id);
      if (cached !== undefined && !getTextRef.current().trim() && cached !== getTextRef.current()) {
        onLoadedRef.current(cached, { id } as unknown as PromptDraftSummary);
      }
      try {
        const draft = await api.getPromptDraft(addressRef.current.projectId, id);
        if (generationRef.current !== generation) return;
        hasFilesRef.current = draft.hasFiles;
        freshThreadRef.current = draft.sessionId === null;
        writeDraftText(id, draft.content);
        setMeta(draft);
        // Never overwrite what the user is typing: a lane with unsaved edits
        // is newer than anything the server can tell us.
        const lane = laneFor(id);
        if (lane.getSnapshot().dirty) return;
        const shown = lane.hydrate(draft.content);
        if (shown !== getTextRef.current()) onLoadedRef.current(shown, draft);
      } catch (err) {
        if (generationRef.current !== generation) return;
        if (isNotFound(err)) {
          forgetDraft(id);
          writeActiveDraftId(slotKeyRef.current, undefined);
          setDraftId(null);
          setMeta(null);
          onDraftIdChangeRef.current?.(undefined);
        }
      }
    },
    [laneFor, setDraftId],
  );

  const prevSlotKeyRef = useRef(slotKey);
  const prevGezelIdRef = useRef(address.gezelId);
  const prevProjectIdRef = useRef(address.projectId);
  const prevSessionIdRef = useRef(sessionId);
  const prevSelectedRef = useRef(selectedDraftId);
  const initializedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: slotKey and the explicit selection are the generation boundary; the callbacks are refs.
  useEffect(() => {
    const previousSlot = prevSlotKeyRef.current;
    const gezelChanged = prevGezelIdRef.current !== address.gezelId;
    const projectChanged = prevProjectIdRef.current !== address.projectId;
    const sessionAppeared = prevSessionIdRef.current === undefined && sessionId !== undefined;
    const selectionChanged = prevSelectedRef.current !== selectedDraftId;
    const first = !initializedRef.current;
    // The parent took the draft away rather than swapping it: "+ New", the
    // picker's fresh-thread row. That is a request for a blank sheet, and it
    // is the one case where this slot's remembered draft must not answer for
    // it. Distinct from arriving at a surface with nothing selected, where
    // reopening what you were writing is the whole point.
    const deselected =
      !first && prevSelectedRef.current !== undefined && selectedDraftId === undefined;

    slotKeyRef.current = slotKey;
    prevSlotKeyRef.current = slotKey;
    prevGezelIdRef.current = address.gezelId;
    prevProjectIdRef.current = address.projectId;
    prevSessionIdRef.current = sessionId;
    prevSelectedRef.current = selectedDraftId;
    initializedRef.current = true;

    const live = draftIdRef.current;

    // The address moved under a live composer — an @-mention pivot, a To-line
    // recipient swap. The text stays with the person typing it, so the draft
    // follows rather than being swapped for whatever the destination held.
    if (!first && live && gezelChanged && !projectChanged && !selectionChanged) {
      writeActiveDraftId(previousSlot, undefined);
      writeActiveDraftId(slotKey, live);
      void api
        .patchPromptDraft(address.projectId, live, {
          gezelId: address.gezelId,
          sessionId: sessionId ?? null,
        })
        .then((updated) => setMeta(updated))
        .catch(() => {});
      return;
    }

    // The thread the composer was already writing into just materialized
    // (the picker's auto-pick landed after the user started typing). Adopt it
    // rather than leaving the draft orphaned on "new thread".
    if (
      !first &&
      live &&
      sessionAppeared &&
      bornWithoutSessionRef.current &&
      !freshThreadRef.current &&
      !selectionChanged
    ) {
      bornWithoutSessionRef.current = false;
      writeActiveDraftId(previousSlot, undefined);
      writeActiveDraftId(slotKey, live);
      void api
        .patchPromptDraft(address.projectId, live, { sessionId: sessionId ?? null })
        .then((updated) => setMeta(updated))
        .catch(() => {});
      return;
    }

    if (!first && !selectionChanged && previousSlot === slotKey) return;

    // Resolve which draft this slot should show.
    if (deselected) writeActiveDraftId(slotKey, undefined);
    const resolved = selectedDraftId ?? readActiveDraftId(slotKey);

    // Already showing it. This is the composer being told the id of the draft
    // it just created from the text on screen — reloading here would drop the
    // live save lane and paint the freshly-saved copy back over whatever the
    // person has typed since.
    if (resolved && resolved === live) {
      writeActiveDraftId(slotKey, resolved);
      return;
    }

    const generation = ++generationRef.current;
    controllerRef.current = null;
    controllerDraftRef.current = null;
    discardedRef.current = false;
    bornWithoutSessionRef.current = sessionId === undefined;
    setAutosaveSnapshot({ phase: 'idle', dirty: false, error: null });

    if (resolved) {
      writeActiveDraftId(slotKey, resolved);
      setDraftId(resolved);
      void loadDraft(resolved, generation);
      return;
    }

    const carriedText = live ? '' : getTextRef.current();
    setDraftId(null);
    setMeta(null);
    hasFilesRef.current = false;
    freshThreadRef.current = false;
    // Never take words away. A composer holding text that has no draft yet is
    // mid-creation (or its creation failed); moving the address under it must
    // leave the typing alone, and the next keystroke files it under the new
    // slot. Only a slot the user had genuinely nothing in gets cleared.
    if (!first && !carriedText.trim()) {
      onLoadedRef.current('', { id: '' } as unknown as PromptDraftSummary);
    }

    // With no thread chosen the picker owns the pick — asking here would race
    // its auto-pick and could seed text the user is about to navigate away
    // from. With a thread, its newest open draft is the right one to reopen.
    if (sessionId === undefined) return;
    void (async () => {
      try {
        const { drafts } = await api.listPromptDrafts(address.projectId, {
          gezelId: address.gezelId,
          sessionId,
          status: 'draft',
        });
        if (generationRef.current !== generation) return;
        const newest = drafts[0];
        if (!newest) return;
        writeActiveDraftId(slotKey, newest.id);
        setDraftId(newest.id);
        await loadDraft(newest.id, generation);
      } catch {
        /* an empty composer is a fine outcome */
      }
    })();
  }, [slotKey, selectedDraftId]);

  // A closing window or a backgrounded tab must not cost the last second of
  // typing. Both events fire before teardown; the debounce bounds the loss to
  // whatever arrived after the most recent save.
  useEffect(() => {
    const flushNow = () => {
      void controllerRef.current?.flush().catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      flushNow();
    };
  }, []);

  const autosave = useMemo<PromptDraftAutosave>(
    () => ({ ...autosaveSnapshot, retry }),
    [autosaveSnapshot, retry],
  );

  return {
    draftId,
    meta,
    isFreshThread: freshThreadRef.current || (meta?.sessionId === null && sessionId === undefined),
    autosave,
    update,
    ensureDraft,
    flush,
    markSent,
    discard,
    noteFileAdded,
  };
}

function isNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(message) || /not found/i.test(message);
}
