import type { ChatSessionSummary, PromptDraftSummary } from '@bendyline/gezel';
import { derivePromptDraftTitle, parseTaskRef } from '@bendyline/gezel';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';
import { ContextMeter, type ContextMeterStatus } from './ContextMeter.js';
import { readDraftText, subscribeDraftText } from './composer-drafts.js';
import { providerLabel as resolveProviderLabel } from './provider-label.js';
import { MENTION_RE, displayThreadTitle, isUnnamedThread, plainTitle } from './session-labels.js';

interface Props {
  gezelId: string;
  projectId: string;
  sessionId: string | undefined;
  /**
   * Display name for the gezel the list is scoped to. When the switcher
   * sits under a surface that shows OTHER conversations too (the project
   * chat's interleaved timeline), a bare "No threads yet" reads as a
   * contradiction beneath a visible thread — naming the scope ("No
   * threads with Ada yet") keeps the empty state truthful.
   */
  gezelName?: string;
  onSessionIdChange: (next: string | undefined) => void;
  /** Reports the selected record so parents can enforce external read-only UI. */
  onActiveSessionChange?: (session: ChatSessionSummary | null) => void;
  /**
   * The user asked for a fresh thread. No session exists yet — one is minted
   * when the message is sent — so this carries no id; surfaces use it to put
   * the cursor back in the composer.
   */
  onFreshThread?: () => void;
  /** Bumped by the parent after a write it wants the switcher to re-read
   *  (e.g. ChatComposer's lazy-create on first send). */
  refreshKey?: number;
  /** When set, scopes the session list + the "+ New" action to this task.
   *  Lookup uses `api.listTaskSessions` instead of the per-(gezel, project)
   *  list, and new sessions carry `taskRef` + `phaseId`. */
  taskRef?: string;
  stepId?: string;
  /**
   * Whether an unselected composer should fall onto the newest thread in
   * scope (default) or stay blank so the next message starts a fresh one.
   * The project chat turns it off when it opens on a gezel whose last
   * conversation is too old to be resumed — see `RESUMABLE_THREAD_MAX_AGE_MS`
   * in {@link ProjectChat}. Older threads remain pickable from the list
   * either way; this only decides what happens when nobody has picked.
   */
  autoPickNewest?: boolean;
  /**
   * Overrides the per-row engine/model suffix (normally the chat
   * provider + model, e.g. "This Mac (qwen3.6-…)"). Set for fixed-function
   * generator gezels so the row shows the generation model instead, e.g.
   * "Video · ltx-video-0.9.7". When null/undefined the default suffix shows.
   */
  engineLabel?: string | null;
  /** The prompt draft the composer has open, when the parent tracks one. */
  activeDraftId?: string | undefined;
  /** Picking a draft row, or clearing the pick after it is sent or deleted. */
  onDraftSelect?: (draftId: string | undefined) => void;
  /**
   * The composer surface these drafts belong to — the same value the
   * composer takes as `draftScope`, so a gezel’s own tab and Home’s
   * meester conversation do not offer each other’s unsent thread starters.
   */
  draftScope?: string;
  craftbookRef?: string;
}

/**
 * Coalesce the user-message + done pair (and bursts of concurrent external
 * turns) into one session-list read. This is deliberately much shorter than
 * a polling interval: the event itself is the invalidation signal.
 */
const LIVE_SESSION_REFRESH_DEBOUNCE_MS = 150;

/**
 * Draft events fire on every autosave — about once a second while someone is
 * typing — and unlike a finished turn there is nothing urgent about them. A
 * slower coalescing window keeps a second window’s typing from turning this
 * list into a poller.
 */
const LIVE_DRAFT_REFRESH_DEBOUNCE_MS = 1000;

/** Radix needs a non-empty value per item; drafts share the session picker. */
const DRAFT_VALUE_PREFIX = 'draft:';

/**
 * The row that starts a fresh conversation. It is always offered, because
 * "start a new one" is a destination like any thread in the list — and the
 * moment the user types, that fresh thread earns a name of its own (a draft
 * row, then a thread row) and this row is free again for the next one. The
 * angle brackets keep it apart from a real, still-untitled thread, whose
 * row also reads "New thread".
 */
const NEW_THREAD_VALUE = '__NEW__';
const NEW_THREAD_LABEL = '<New thread>';

/** Value for the disabled "nothing here yet" row. Never selectable, and
 *  deliberately not the unselected value — that one is the empty string, the
 *  only value Radix renders the trigger's placeholder for. */
const EMPTY_ROW_VALUE = '__EMPTY__';

/** A draft whose first line is still empty (it opens with an image, say). */
const UNTITLED_DRAFT_LABEL = 'Untitled draft';

/** Recently sent messages offered for reuse under the open thread. */
const RECENT_SENT_LIMIT = 5;
const SENT_VALUE_PREFIX = 'sent:';

/**
 * Inline session picker + "+ New" / "Archive" controls, scoped to a
 * (gezel, project) pair. Rendered above the timeline so the user can pick
 * which session the composer posts into and which session reads as
 * "active" in the interleaved view.
 *
 * First-time UX: if no sessions exist yet, shows "No sessions yet" and
 * leaves `sessionId` undefined so the composer's lazy-create path still
 * works. Once any session exists, auto-picks the most recent on first
 * load.
 */
export function SessionSwitcher({
  gezelId,
  projectId,
  sessionId,
  gezelName,
  onSessionIdChange,
  onActiveSessionChange,
  onFreshThread,
  refreshKey,
  taskRef,
  stepId,
  autoPickNewest = true,
  engineLabel,
  activeDraftId,
  onDraftSelect,
  draftScope,
  craftbookRef,
}: Props) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  // Unsent thread starters. They have no session to belong to, so they are
  // listed above the threads rather than inside one.
  const [newThreadDrafts, setNewThreadDrafts] = useState<PromptDraftSummary[]>([]);
  // Open drafts filed under a thread, keyed by it. More than one per thread
  // is allowed: a person can keep a long ask and a quick one going in the
  // same conversation.
  const [threadDrafts, setThreadDrafts] = useState<Map<string, PromptDraftSummary[]>>(new Map());
  const [busy, setBusy] = useState(false);
  // Recently sent messages on the open thread, read when the menu opens.
  const [sentDrafts, setSentDrafts] = useState<PromptDraftSummary[]>([]);
  // Live context-window readings, keyed by session. The summary carries the
  // persisted values (so a reload shows a meter immediately); these entries
  // let a running turn move the ring without waiting for a list refresh.
  const [liveContext, setLiveContext] = useState<Map<string, ContextMeterStatus>>(new Map());
  const autoPickedFor = useRef<string | null>(null);
  // Read inside the event loop, which is built once per project.
  const activeDraftIdRef = useRef<string | undefined>(activeDraftId);
  activeDraftIdRef.current = activeDraftId;
  const refreshDraftsRef = useRef<() => Promise<void>>(async () => {});
  const refreshedUnknownSession = useRef<string | null>(null);

  // The (gezel, project, task) triple the list is scoped to. Stamped onto
  // the loaded list so the auto-pick below can tell "this list is for the
  // scope I'm looking at" from "this list is the previous scope's, still
  // on screen while the refetch flies".
  const scopeKey = `${gezelId}:${projectId}:${taskRef ?? ''}`;
  const [sessionsScope, setSessionsScope] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const key = `${gezelId}:${projectId}:${taskRef ?? ''}`;
    try {
      let all: ChatSessionSummary[];
      if (taskRef) {
        const parsed = parseTaskRef(taskRef);
        if (!parsed) return [] as ChatSessionSummary[];
        const res = await api.listTaskSessions(parsed.projectId, parsed.num);
        all = res.sessions.filter((s) => s.gezelId === gezelId);
      } else {
        const res = await api.listChatSessions({ gezelId, projectId });
        // The ordinary chat surface is the gezel's lobby conversation.
        // Task-scoped sessions (including night-shift handoffs) have their
        // own task UI and procedure prompt; letting one win this newest-first
        // list silently drops an ordinary user message into that procedure.
        all = res.sessions.filter((s) => !s.taskRef);
      }
      const visible = all.filter((s) => !s.archived);
      setSessions(visible);
      setSessionsScope(key);
      return visible;
    } catch (err) {
      console.error('[SessionSwitcher] list sessions failed', {
        gezelId,
        projectId,
        taskRef,
        err,
      });
      return [] as ChatSessionSummary[];
    }
  }, [gezelId, projectId, taskRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a bump counter — incrementing it is the re-fetch trigger.
  useEffect(() => {
    autoPickedFor.current = null;
    // Drop the previous scope's list and its stamp. Clearing `sessions`
    // alone is not enough: this effect and the auto-pick below run in the
    // same flush, so the auto-pick still closes over the pre-update array.
    // The stamp is what it actually checks — an un-stamped list can't be
    // auto-picked from, so a scope change can't land the parent on the
    // OLD scope's newest thread (an @-mention pivot from gezel A to B
    // picking A's session; a task pill losing its task thread to the
    // gezel's lobby thread one tick after focusing it).
    setSessions([]);
    setSessionsScope(null);
    void refresh();
  }, [refresh, refreshKey]);

  // Drafts that belong to this surface. Filtered client-side on the refs the
  // list API does not key on, so a task pane never offers the lobby's drafts.
  const belongsHere = useCallback(
    (draft: PromptDraftSummary): boolean =>
      (draft.taskRef ?? undefined) === (taskRef ?? undefined) &&
      (draft.craftbookRef ?? undefined) === (craftbookRef ?? undefined) &&
      (draft.scope ?? undefined) === (draftScope ?? undefined),
    [taskRef, craftbookRef, draftScope],
  );

  // One read for every open draft this gezel has here, thread-addressed or
  // not: omitting `sessionId` is the list API's "any thread". The picker needs
  // all of them, not just the open thread's — a thread nobody has sent to yet
  // has no name of its own, and its draft is the only thing that can say what
  // it is about.
  const refreshDrafts = useCallback(async () => {
    try {
      const { drafts } = await api.listPromptDrafts(projectId, { gezelId, status: 'draft' });
      const mine = drafts.filter(belongsHere);
      setNewThreadDrafts(mine.filter((d) => d.sessionId === null));
      const byThread = new Map<string, PromptDraftSummary[]>();
      for (const d of mine) {
        if (!d.sessionId) continue;
        const bucket = byThread.get(d.sessionId);
        if (bucket) bucket.push(d);
        else byThread.set(d.sessionId, [d]);
      }
      setThreadDrafts(byThread);
    } catch {
      // A picker that cannot list drafts still lists threads.
    }
  }, [projectId, gezelId, belongsHere]);

  refreshDraftsRef.current = refreshDrafts;

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  // Auto-pick the most-recent session when we mount (or swap to a new
  // scope) and the caller doesn't already have one. Only once per scope
  // — we don't want to stomp a user's explicit pick after they've acted.
  useEffect(() => {
    const key = scopeKey;
    // Wait for a list that belongs to THIS scope before deciding anything.
    if (sessionsScope !== key) return;
    if (sessionId) {
      // Latch the sessionId only when it's a real id from the
      // CURRENT scope's session list. Otherwise a parent that
      // pre-loaded an id for the previous scope (or any caller
      // that races a scope change) would short-circuit the
      // auto-pick for the new scope, leaving the dropdown empty
      // because the latched id isn't in the new options.
      const inScope = sessions.some((s) => s.id === sessionId);
      if (inScope) {
        autoPickedFor.current = key;
        return;
      }
    }
    if (autoPickedFor.current === key) return;
    if (activeDraftId) {
      // The parent already restored a draft; that IS where the user was.
      autoPickedFor.current = key;
      return;
    }
    const newestDraft = newThreadDrafts[0];
    if (sessions.length === 0 && !newestDraft) return;
    // Latch either way: once this scope has had its one chance, a later
    // flip of `autoPickNewest` must not reach in and move a composer the
    // user is already typing into.
    autoPickedFor.current = key;
    if (autoPickNewest && sessions.length > 0) {
      onSessionIdChange(sessions[0]!.id);
      return;
    }
    // Nothing worth resuming, but an unsent thread starter is waiting. That
    // is a better answer to "where was I" than a blank composer.
    if (newestDraft) {
      onSessionIdChange(undefined);
      onDraftSelect?.(newestDraft.id);
    }
  }, [
    sessions,
    sessionsScope,
    sessionId,
    scopeKey,
    autoPickNewest,
    onSessionIdChange,
    activeDraftId,
    newThreadDrafts,
    onDraftSelect,
  ]);

  useEffect(() => {
    if (sessionsScope !== scopeKey) return;
    const active = sessions.find((session) => session.id === sessionId);
    // A live external session can appear after this list loaded. Keep the
    // parent's current safety state until the one-shot refresh below has had
    // a chance to fetch its provenance.
    if (sessionId && !active) return;
    onActiveSessionChange?.(active ?? null);
  }, [sessions, sessionsScope, sessionId, scopeKey, onActiveSessionChange]);

  useEffect(() => {
    if (sessionsScope !== scopeKey || !sessionId) return;
    if (sessions.some((session) => session.id === sessionId)) return;
    const key = `${scopeKey}:${sessionId}`;
    if (refreshedUnknownSession.current === key) return;
    refreshedUnknownSession.current = key;
    void refresh();
  }, [sessions, sessionsScope, sessionId, scopeKey, refresh]);

  // Sessions can be created or resumed outside this renderer (OpenCode, Pi,
  // another external client, scheduled work). The interleaved timeline sees
  // those turns immediately through the shared project stream, but this
  // switcher used to retain the list it fetched on mount until a local action
  // bumped `refreshKey`. Subscribe to the same shared stream and treat durable
  // turn boundaries as list invalidations. We intentionally do not select the
  // arriving session: background work should appear in the menu without
  // stealing the conversation the user is currently addressing.
  useEffect(() => {
    const ctrl = new AbortController();
    let refreshTimer: number | null = null;
    let stopped = false;

    let draftTimer: number | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, LIVE_SESSION_REFRESH_DEBOUNCE_MS);
    };

    const scheduleDraftRefresh = () => {
      if (draftTimer !== null) window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => {
        draftTimer = null;
        void refreshDraftsRef.current();
      }, LIVE_DRAFT_REFRESH_DEBOUNCE_MS);
    };

    void (async () => {
      let backoffMs = 250;
      while (!stopped) {
        try {
          for await (const envelope of streamSharedProjectChatEvents({
            url: api.projectEventsUrl(projectId),
            headers: api.authHeader(),
            signal: ctrl.signal,
            fetch: api.getFetch(),
          })) {
            if (stopped) return;
            // Draft events name their own gezel in the payload: a lifecycle
            // publish leaves the envelope's scope empty, so the filter below
            // would drop every one of them.
            if (envelope.event.type === 'prompt_draft_changed') {
              const draftEvent = envelope.event;
              if (draftEvent.projectId === projectId && draftEvent.gezelId === gezelId) {
                // Our own autosave is not news. Refetching on it would mean a
                // list read per second for as long as someone is typing.
                const ownEdit =
                  draftEvent.draftId === activeDraftIdRef.current &&
                  !draftEvent.deleted &&
                  draftEvent.status === 'draft';
                if (!ownEdit) scheduleDraftRefresh();
              }
              continue;
            }
            if (envelope.projectId !== projectId || envelope.gezelId !== gezelId) continue;
            const { event } = envelope;
            // A compaction rewrites the transcript on disk, so the summary's
            // token tally is stale until the list is re-read.
            if (
              event.type === 'user_message' ||
              event.type === 'done' ||
              event.type === 'context_compacted'
            ) {
              scheduleRefresh();
            }
            if (
              envelope.sessionId &&
              (event.type === 'context_window' ||
                event.type === 'context_warning' ||
                event.type === 'context_compacted')
            ) {
              const id = envelope.sessionId;
              setLiveContext((prev) => {
                const next = new Map(prev);
                const prior = next.get(id);
                if (event.type === 'context_window') {
                  next.set(id, {
                    ...prior,
                    numCtx: event.numCtx,
                    model: event.model,
                    autoCompactRatio: event.autoCompactRatio,
                    // Older daemons publish the window without a fill; keep
                    // the last reading rather than blanking the ring.
                    ...(event.estimatedTokens !== undefined
                      ? { estimatedTokens: event.estimatedTokens }
                      : {}),
                  });
                } else if (event.type === 'context_warning') {
                  next.set(id, {
                    ...prior,
                    numCtx: event.numCtx,
                    model: event.model,
                    estimatedTokens: event.estimatedTokens,
                    compactionFailed: true,
                  });
                } else {
                  // A compaction that ran is the resolution of a warning.
                  // Every field but `model` is optional on this event (older
                  // daemons omit them), so only what arrived may overwrite.
                  // The measured reading described the prompt that was just
                  // rewritten — drop it and let the refreshed summary's
                  // transcript tally carry the meter until the next turn
                  // measures for real. The automatic path republishes a fresh
                  // measurement right after this, which wins.
                  const numCtx = event.numCtx ?? prior?.numCtx;
                  if (numCtx !== undefined) {
                    const { estimatedTokens: _stale, ...rest } = prior ?? {};
                    next.set(id, {
                      ...rest,
                      numCtx,
                      model: event.model,
                      ...(event.autoCompactRatio !== undefined
                        ? { autoCompactRatio: event.autoCompactRatio }
                        : {}),
                      ...(event.compactionCount !== undefined
                        ? { compactionCount: event.compactionCount }
                        : {}),
                      compactionFailed: false,
                    });
                  }
                }
                return next;
              });
            }
            backoffMs = 250;
          }
        } catch (err) {
          if (stopped || (err as Error).name === 'AbortError') return;
          console.warn(
            `[SessionSwitcher] chat event stream error (reconnecting in ${backoffMs}ms):`,
            err,
          );
        }
        if (stopped) return;
        await new Promise<void>((resolve) => window.setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    })();

    return () => {
      stopped = true;
      ctrl.abort();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (draftTimer !== null) window.clearTimeout(draftTimer);
    };
  }, [gezelId, projectId, refresh]);

  // Another message in progress, filed where the composer is pointed. On a
  // thread that is a second reply to that conversation — the address does not
  // move. Off one it is a thread starter, and no session is created: the
  // thread comes into being when the message is sent, so abandoning it leaves
  // no empty thread behind.
  const createDraft = useCallback(async () => {
    setBusy(true);
    try {
      const created = await api.createPromptDraft(projectId, {
        gezelId,
        sessionId: sessionId ?? null,
        ...(taskRef ? { taskRef } : {}),
        ...(craftbookRef ? { craftbookRef } : {}),
        ...(draftScope ? { scope: draftScope } : {}),
      });
      if (sessionId) {
        setThreadDrafts((prev) => {
          const next = new Map(prev);
          next.set(sessionId, [created, ...(prev.get(sessionId) ?? [])]);
          return next;
        });
      } else {
        setNewThreadDrafts((prev) => [created, ...prev.filter((d) => d.id !== created.id)]);
        onSessionIdChange(undefined);
      }
      onDraftSelect?.(created.id);
    } finally {
      setBusy(false);
    }
  }, [
    projectId,
    gezelId,
    sessionId,
    taskRef,
    craftbookRef,
    draftScope,
    onSessionIdChange,
    onDraftSelect,
  ]);

  // Throwing away a message in progress. No confirmation, matching the menu
  // item this replaces — but the control only appears on the row under the
  // pointer, so it cannot be hit blind.
  const deleteDraft = useCallback(
    async (draftId: string) => {
      setBusy(true);
      try {
        await api.deletePromptDraft(projectId, draftId);
        if (draftId === activeDraftId) onDraftSelect?.(undefined);
        await refreshDrafts();
      } finally {
        setBusy(false);
      }
    },
    [projectId, activeDraftId, onDraftSelect, refreshDrafts],
  );

  // Sent drafts are a recovery affordance, not something worth a request on
  // every thread switch — read when the menu opens, for the open thread only.
  const loadSent = useCallback(async () => {
    if (!sessionId) {
      setSentDrafts([]);
      return;
    }
    try {
      const { drafts } = await api.listPromptDrafts(projectId, {
        gezelId,
        sessionId,
        status: 'sent',
      });
      setSentDrafts(drafts.filter(belongsHere).slice(0, RECENT_SENT_LIMIT));
    } catch {
      setSentDrafts([]);
    }
  }, [projectId, gezelId, sessionId, belongsHere]);

  const useAgain = useCallback(
    async (draftId: string) => {
      setBusy(true);
      try {
        const copy = await api.duplicatePromptDraft(projectId, draftId, {
          sessionId: sessionId ?? null,
        });
        onDraftSelect?.(copy.id);
        await refreshDrafts();
      } finally {
        setBusy(false);
      }
    },
    [projectId, sessionId, onDraftSelect, refreshDrafts],
  );

  const archiveCurrent = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.archiveChatSession(sessionId);
      const remaining = await refresh();
      onDraftSelect?.(undefined);
      onSessionIdChange(remaining[0]?.id);
    } finally {
      setBusy(false);
    }
  }, [sessionId, refresh, onSessionIdChange, onDraftSelect]);

  // The draft the composer is writing has no name until its first autosave,
  // and this list is deliberately NOT refetched on our own edits (that would
  // be a list read per second for as long as someone types). Read the
  // composer's own text cache instead, which every autosave updates, so the
  // picker names the thread as it takes shape. Same derivation and cap as the
  // stored title, so the label doesn't jump when the list catches up.
  const liveDraftText = useSyncExternalStore(subscribeDraftText, () =>
    activeDraftId ? readDraftText(activeDraftId) : undefined,
  );
  const liveDraftTitle = liveDraftText === undefined ? '' : derivePromptDraftTitle(liveDraftText);

  const hasSessions = sessions.length > 0;
  const hasDrafts = newThreadDrafts.length > 0;
  // Whatever the trigger points at needs a row of its own: Radix renders the
  // matching item's text, and nothing at all when the value names no item. A
  // draft seconds old is exactly that — it is on disk, but this list refresh
  // is debounced behind the typing that created it.
  const pendingDraftId =
    activeDraftId && !sessionId && !newThreadDrafts.some((d) => d.id === activeDraftId)
      ? activeDraftId
      : null;
  // Anything the user has started but not sent: thread starters, threads
  // nobody ever sent to, and the draft the composer just filed.
  const showUnsent =
    hasDrafts || pendingDraftId !== null || sessions.some((s) => isUnnamedThread(s.title));
  const hasSent = sessions.some((s) => !isUnnamedThread(s.title));
  /** The row the composer is writing follows the editor; the rest are as filed. */
  const liveTitled = (d: PromptDraftSummary): PromptDraftSummary =>
    d.id === activeDraftId && liveDraftTitle ? { ...d, title: liveDraftTitle } : d;

  // Threads newest-first, where "newest" counts the draft you are writing
  // into one. A thread nobody has sent to has no name either — the service
  // derives one on the first send — so its newest draft lends its first line
  // rather than leaving a column of identical "New thread"s.
  const threadRows = sessions.map((s) => {
    const drafts = (threadDrafts.get(s.id) ?? []).map(liveTitled);
    // Nothing sent: the service derives a thread's title from its first sent
    // message, so the sentinel IS the "unsent" bit. Its newest draft lends
    // its first line rather than leaving a column of "New thread"s.
    const unsent = isUnnamedThread(s.title);
    const namer = unsent ? drafts[0] : undefined;
    return { s, drafts, namer, unsent, at: rowActivityAt(s, namer) };
  });
  const newestFirst = <T extends { at: string }>(a: T, b: T) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
  // The line means "has this gone anywhere yet", not "does a session record
  // exist". Whether the user reached "+ New" (which mints a thread up front)
  // or just started typing (which does not) is an implementation detail they
  // never chose; both leave them holding a message nobody has read. So the
  // unsent section carries thread starters AND threads nothing was ever sent
  // to, ordered together by when they were last touched.
  const unsentRows = [
    ...newThreadDrafts.map((d) => {
      const draft = liveTitled(d);
      return { kind: 'draft' as const, draft, at: draft.updatedAt };
    }),
    ...threadRows.filter((r) => r.unsent).map((r) => ({ kind: 'thread' as const, ...r })),
  ].sort(newestFirst);
  const sentThreads = threadRows.filter((r) => !r.unsent).sort(newestFirst);

  const removeDraftButton = (draftId: string, label: string) => (
    <button
      type="button"
      className="session-row-delete"
      aria-label={`Delete draft ${label}`}
      title="Throw this message away"
      disabled={busy}
      // The row selects on pointer-up; without these the remove control would
      // also address the composer to what it just deleted.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteDraft(draftId);
      }}
    >
      ×
    </button>
  );

  /** One draft row, wherever it sits: a starter, or filed under a thread. */
  const draftItem = (d: PromptDraftSummary, opts?: { child?: boolean }) => (
    <Select.Item
      key={d.id}
      value={`${DRAFT_VALUE_PREFIX}${d.id}`}
      textValue={draftRowTextValue(d)}
      trailing={removeDraftButton(d.id, d.title || UNTITLED_DRAFT_LABEL)}
    >
      {renderDraftRow(d, opts)}
    </Select.Item>
  );

  /** A thread row plus the drafts filed under it, minus the one naming it. */
  const renderThread = ({ s, drafts, namer, unsent }: (typeof threadRows)[number]) => (
    <Fragment key={s.id}>
      <Select.Item value={s.id} textValue={rowTextValue(s, engineLabel, namer, unsent)}>
        {renderRow(s, engineLabel, namer, unsent)}
      </Select.Item>
      {/* The other messages started inside this thread, listed under it
          rather than in a drawer of their own, so one place answers "where
          does the next message go, and which one am I writing". */}
      {drafts.filter((d) => d.id !== namer?.id).map((d) => draftItem(d, { child: true }))}
    </Fragment>
  );
  // Between "the composer filed a draft" and its first autosave we know the
  // id and nothing else. That is still the fresh thread the user picked, so
  // it keeps that name until there are words to show; an empty title with
  // text behind it is a real untitled draft (one that opens with an image).
  const pendingDraftLabel =
    liveDraftTitle || (liveDraftText === undefined ? NEW_THREAD_LABEL : UNTITLED_DRAFT_LABEL);
  // A draft only owns the trigger while no thread is chosen: once a thread is
  // active the picker is showing the conversation, not the message.
  // Radix shows the trigger's placeholder only for the empty string: any
  // other value makes it render that item's text, and an unselected picker
  // used to sit on a sentinel no rendered row carried, so the trigger came
  // up blank. Nothing selected is the empty string.
  const activeValue =
    activeDraftId && !sessionId
      ? `${DRAFT_VALUE_PREFIX}${activeDraftId}`
      : sessionId && hasSessions
        ? sessionId
        : '';
  const emptyLabel = gezelName
    ? `No threads with ${gezelName} yet — a message starts one`
    : 'No threads yet';
  const emptyMenuLabel = showUnsent ? 'No threads yet' : emptyLabel;

  // Context meter for the thread the composer posts into. The persisted
  // summary is the reload seed; live events win field by field so a running
  // turn moves the ring before the debounced list refresh lands.
  const activeSummary = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const persistedContext: ContextMeterStatus | undefined = activeSummary?.contextWindow
    ? {
        numCtx: activeSummary.contextWindow,
        model: activeSummary.model,
        ...(activeSummary.contextEstimatedTokens !== undefined
          ? { estimatedTokens: activeSummary.contextEstimatedTokens }
          : {}),
        ...(activeSummary.contextAutoCompactRatio !== undefined
          ? { autoCompactRatio: activeSummary.contextAutoCompactRatio }
          : {}),
        ...(activeSummary.compactionCount !== undefined
          ? { compactionCount: activeSummary.compactionCount }
          : {}),
        ...(activeSummary.transcriptTokens !== undefined
          ? { transcriptTokens: activeSummary.transcriptTokens }
          : {}),
      }
    : undefined;
  const live = sessionId ? liveContext.get(sessionId) : undefined;
  const contextStatus = live ? { ...persistedContext, ...live } : persistedContext;

  return (
    <div className="gezel-chat-session-header">
      <Select.Root
        value={activeValue}
        onOpenChange={(open) => {
          if (open) void loadSent();
        }}
        onValueChange={(v) => {
          if (!v || v === EMPTY_ROW_VALUE) return;
          if (v.startsWith(SENT_VALUE_PREFIX)) {
            void useAgain(v.slice(SENT_VALUE_PREFIX.length));
            return;
          }
          if (v === NEW_THREAD_VALUE) {
            // Back to an empty composer: the next message opens the thread.
            onDraftSelect?.(undefined);
            onSessionIdChange(undefined);
            onFreshThread?.();
            return;
          }
          if (v.startsWith(DRAFT_VALUE_PREFIX)) {
            const picked = v.slice(DRAFT_VALUE_PREFIX.length);
            // A draft filed under the open thread is a message inside that
            // conversation — switching to it keeps the address. A thread
            // starter has no thread yet, so the address has to be cleared
            // FIRST: the composer must not see a draft arrive while it still
            // believes it is writing into a conversation.
            const parent = [...threadDrafts].find(([, list]) =>
              list.some((d) => d.id === picked),
            )?.[0];
            if (parent !== sessionId) onSessionIdChange(parent);
            onDraftSelect?.(picked);
            return;
          }
          onDraftSelect?.(undefined);
          onSessionIdChange(v);
        }}
        disabled={busy}
      >
        <Select.Trigger className="gezel-chat-session-select">
          {/* Nothing picked means the next message opens a thread — the row
              the user just chose, or the resting state with auto-pick off.
              The trigger names that destination rather than sitting blank
              and reading as a control they forgot to set. */}
          <Select.Value placeholder={hasSessions ? NEW_THREAD_LABEL : emptyLabel} />
        </Select.Trigger>
        <Select.Content className="gezel-chat-session-menu">
          <Select.Item value={NEW_THREAD_VALUE} textValue={NEW_THREAD_LABEL}>
            <span className="session-row">
              <span className="session-row-title">{NEW_THREAD_LABEL}</span>
            </span>
          </Select.Item>
          {(showUnsent || hasSent) && <Select.Separator />}
          {showUnsent && (
            <Select.Group>
              <Select.Label>Not sent yet</Select.Label>
              {pendingDraftId && (
                <Select.Item
                  value={`${DRAFT_VALUE_PREFIX}${pendingDraftId}`}
                  textValue={pendingDraftLabel}
                  trailing={removeDraftButton(pendingDraftId, pendingDraftLabel)}
                >
                  <span className="session-row">
                    <span className="session-row-title">{pendingDraftLabel}</span>
                    <span className="session-row-draft-mark">draft</span>
                  </span>
                </Select.Item>
              )}
              {unsentRows.map((row) =>
                row.kind === 'draft' ? draftItem(row.draft) : renderThread(row),
              )}
            </Select.Group>
          )}
          {showUnsent && hasSent && <Select.Separator />}
          {hasSent ? (
            sentThreads.map(renderThread)
          ) : showUnsent ? (
            <Select.Item value={EMPTY_ROW_VALUE} disabled>
              {emptyMenuLabel}
            </Select.Item>
          ) : // With neither threads nor drafts the menu is just the new-thread
          // row above, and the trigger carries the empty-state sentence.
          null}
          {sentDrafts.length > 0 && (
            <>
              <Select.Separator />
              <Select.Group>
                <Select.Label>Recently sent</Select.Label>
                {/* Picking one copies it into a fresh draft on this thread —
                    the point of keeping sent messages around at all. */}
                {sentDrafts.map((d) => (
                  <Select.Item
                    key={d.id}
                    value={`${SENT_VALUE_PREFIX}${d.id}`}
                    textValue={`${d.title || UNTITLED_DRAFT_LABEL} · use again`}
                  >
                    <span className="session-row session-row-child">
                      <span className="session-row-title">{d.title || UNTITLED_DRAFT_LABEL}</span>
                      <span className="session-row-meta">
                        {` · use again · sent ${formatRelativeTime(d.sentAt ?? d.updatedAt)}`}
                      </span>
                    </span>
                  </Select.Item>
                ))}
              </Select.Group>
            </>
          )}
        </Select.Content>
      </Select.Root>
      <ContextMeter status={contextStatus} sessionId={sessionId} />
      {/* Only on a thread: a second message in progress inside a
          conversation. Off a thread it would mean the same as the picker's
          fresh-thread row, and two controls for one act is one too many. */}
      {sessionId && (
        <button
          type="button"
          className="gezel-chat-session-btn"
          onClick={() => void createDraft()}
          disabled={busy}
          title="Start another message in this thread and keep the one you have"
        >
          + Draft
        </button>
      )}
      <button
        type="button"
        className="gezel-chat-session-btn"
        onClick={() => void archiveCurrent()}
        disabled={!sessionId || busy}
        title="Archive this thread (remains on disk; hidden from the list)"
      >
        Archive
      </button>
    </div>
  );
}

/**
 * Render a thread title with its `@mention`s as pills, rest as text.
 * `MENTION_RE` is the shared `@[Label](gezel:id)` wire form; the provider
 * name in each row comes from the shared `providerLabel` helper (e.g.
 * "This Windows PC").
 */
function renderTitleWithMentions(title: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of title.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(title.slice(last, start));
    parts.push(
      <span key={`m-${i}`} className="session-mention">
        @{m[1]}
      </span>,
    );
    last = start + m[0].length;
    i++;
  }
  if (parts.length === 0) return title;
  if (last < title.length) parts.push(title.slice(last));
  return parts;
}

// The engine/model suffix shown after the relative time. `engineLabel`
// (fixed-function generators) wins; otherwise it's the chat provider + model.
function engineSuffix(s: ChatSessionSummary, engineLabel?: string | null): string {
  if (s.source?.kind === 'external') return `From ${s.source.appName} · read-only`;
  if (engineLabel) return engineLabel;
  const provider = resolveProviderLabel(s.providerName, window.__GEZEL__?.platform);
  return `${provider}${s.model ? ` (${s.model})` : ''}`;
}

/** What the row calls the thread: its own title, or the draft lending one. */
function rowTitle(s: ChatSessionSummary, namer?: PromptDraftSummary): string {
  if (!namer) return displayThreadTitle(s.title);
  return namer.title || UNTITLED_DRAFT_LABEL;
}

/**
 * When the thread was last touched. Writing a draft into a thread does not
 * move its `lastActivityAt` — nothing was sent — so a thread you started
 * three minutes ago reads "29m ago" and sits wherever that puts it in a
 * newest-first list. Among several unsent threads that is the difference
 * between finding the one you just typed into and concluding it is gone.
 */
function rowActivityAt(s: ChatSessionSummary, namer?: PromptDraftSummary): string {
  if (namer && namer.updatedAt > s.lastActivityAt) return namer.updatedAt;
  return s.lastActivityAt;
}

function renderRow(
  s: ChatSessionSummary,
  engineLabel?: string | null,
  namer?: PromptDraftSummary,
  unsent?: boolean,
): ReactNode {
  const at = rowActivityAt(s, namer);
  // A session record carries a provider and model from the moment it is
  // created, but a thread nothing was ever sent to has not run anything —
  // naming an engine there reports a prediction as a fact.
  const meta = unsent
    ? ` · ${formatRelativeTime(at)}`
    : ` · ${formatRelativeTime(at)} · ${engineSuffix(s, engineLabel)}`;
  return (
    <span className="session-row">
      <span className="session-row-title">{renderTitleWithMentions(rowTitle(s, namer))}</span>
      {/* Named by an unsent message, so the row says so — the same badge its
          own draft rows carry. */}
      {namer && <span className="session-row-draft-mark">draft</span>}
      <span className="session-row-meta" title={formatAbsoluteTime(at)}>
        {meta}
      </span>
    </span>
  );
}

function rowTextValue(
  s: ChatSessionSummary,
  engineLabel?: string | null,
  namer?: PromptDraftSummary,
  unsent?: boolean,
): string {
  const head = `${plainTitle(rowTitle(s, namer))}${namer ? ' · draft' : ''} · ${formatRelativeTime(rowActivityAt(s, namer))}`;
  return unsent ? head : `${head} · ${engineSuffix(s, engineLabel)}`;
}

/**
 * A draft that has no thread yet. It reads like a thread row on purpose —
 * from the user's side it is the same thing, one step earlier — with a badge
 * so the difference is visible before they commit to it.
 */
function renderDraftRow(d: PromptDraftSummary, opts?: { child?: boolean }): ReactNode {
  return (
    <span className={opts?.child ? 'session-row session-row-child' : 'session-row'}>
      <span className="session-row-title">{d.title || UNTITLED_DRAFT_LABEL}</span>
      <span className="session-row-draft-mark">draft</span>
      <span className="session-row-meta" title={formatAbsoluteTime(d.updatedAt)}>
        {` · ${formatRelativeTime(d.updatedAt)}`}
      </span>
    </span>
  );
}

function draftRowTextValue(d: PromptDraftSummary): string {
  return `${d.title || UNTITLED_DRAFT_LABEL} · draft · ${formatRelativeTime(d.updatedAt)}`;
}
