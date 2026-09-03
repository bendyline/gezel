import type { ChatSessionSummary, PromptDraftSummary } from '@bendyline/gezel';
import { parseTaskRef } from '@bendyline/gezel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';
import { ContextMeter, type ContextMeterStatus } from './ContextMeter.js';
import { PromptDraftsMenu } from './PromptDraftsMenu.js';
import { providerLabel as resolveProviderLabel } from './provider-label.js';
import { MENTION_RE, displayThreadTitle, plainTitle } from './session-labels.js';

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
  /** Runs after "+ New" has created and selected a fresh session. */
  onNewSessionCreated?: (sessionId: string) => void;
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
  onNewSessionCreated,
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
  // Open drafts on the selected thread. More than one is allowed: a person
  // can keep a long ask and a quick one going in the same conversation.
  const [threadDrafts, setThreadDrafts] = useState<PromptDraftSummary[]>([]);
  const [busy, setBusy] = useState(false);
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

  const refreshDrafts = useCallback(async () => {
    try {
      const [fresh, onThread] = await Promise.all([
        api.listPromptDrafts(projectId, { gezelId, sessionId: null, status: 'draft' }),
        sessionId
          ? api.listPromptDrafts(projectId, { gezelId, sessionId, status: 'draft' })
          : Promise.resolve({ drafts: [] }),
      ]);
      setNewThreadDrafts(fresh.drafts.filter(belongsHere));
      setThreadDrafts(onThread.drafts.filter(belongsHere));
    } catch {
      // A picker that cannot list drafts still lists threads.
    }
  }, [projectId, gezelId, sessionId, belongsHere]);

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

  const createNew = useCallback(async () => {
    setBusy(true);
    try {
      const body = {
        gezelId,
        projectId,
        ...(taskRef ? { taskRef } : {}),
        ...(stepId ? { stepId } : {}),
      };
      const created = await api.createChatSession(body);
      await refresh();
      onSessionIdChange(created.id);
      onNewSessionCreated?.(created.id);
    } finally {
      setBusy(false);
    }
  }, [gezelId, projectId, taskRef, stepId, refresh, onSessionIdChange, onNewSessionCreated]);

  const createDraft = useCallback(async () => {
    setBusy(true);
    try {
      const created = await api.createPromptDraft(projectId, {
        gezelId,
        sessionId: null,
        ...(taskRef ? { taskRef } : {}),
        ...(craftbookRef ? { craftbookRef } : {}),
        ...(draftScope ? { scope: draftScope } : {}),
      });
      setNewThreadDrafts((prev) => [created, ...prev.filter((d) => d.id !== created.id)]);
      // No session is created here: the thread comes into being when the
      // message is sent, so abandoning this leaves no empty thread behind.
      onSessionIdChange(undefined);
      onDraftSelect?.(created.id);
    } finally {
      setBusy(false);
    }
  }, [projectId, gezelId, taskRef, craftbookRef, draftScope, onSessionIdChange, onDraftSelect]);

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

  const hasSessions = sessions.length > 0;
  const hasDrafts = newThreadDrafts.length > 0;
  // A draft only owns the trigger while no thread is chosen: once a thread is
  // active the picker is showing the conversation, not the message.
  const activeValue =
    activeDraftId && !sessionId
      ? `${DRAFT_VALUE_PREFIX}${activeDraftId}`
      : sessionId && hasSessions
        ? sessionId
        : '__NONE__';
  const emptyLabel = gezelName
    ? `No threads with ${gezelName} yet — a message starts one`
    : 'No threads yet';
  // Nothing picked. With auto-pick on that is a momentary state before the
  // newest thread lands; with it off it is the deliberate resting state, and
  // the trigger has to say so rather than read as a control the user forgot.
  const unselectedLabel = autoPickNewest ? 'Pick a thread' : 'New thread';
  const emptyMenuLabel = hasDrafts ? 'No threads yet' : emptyLabel;

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
        onValueChange={(v) => {
          if (!v || v === '__NONE__') return;
          if (v.startsWith(DRAFT_VALUE_PREFIX)) {
            // Clear the thread first: the composer must not see a draft
            // arrive while it still believes it is addressing a conversation.
            onSessionIdChange(undefined);
            onDraftSelect?.(v.slice(DRAFT_VALUE_PREFIX.length));
            return;
          }
          onDraftSelect?.(undefined);
          onSessionIdChange(v);
        }}
        disabled={(!hasSessions && !hasDrafts) || busy}
      >
        <Select.Trigger className="gezel-chat-session-select">
          <Select.Value placeholder={hasSessions ? unselectedLabel : emptyLabel} />
        </Select.Trigger>
        <Select.Content className="gezel-chat-session-menu">
          {hasDrafts && (
            <Select.Group>
              <Select.Label>Drafts</Select.Label>
              {newThreadDrafts.map((d) => (
                <Select.Item
                  key={d.id}
                  value={`${DRAFT_VALUE_PREFIX}${d.id}`}
                  textValue={draftRowTextValue(d)}
                >
                  {renderDraftRow(d)}
                </Select.Item>
              ))}
            </Select.Group>
          )}
          {hasDrafts && hasSessions && <Select.Separator />}
          {hasSessions ? (
            sessions.map((s) => (
              <Select.Item key={s.id} value={s.id} textValue={rowTextValue(s, engineLabel)}>
                {renderRow(s, engineLabel)}
              </Select.Item>
            ))
          ) : hasDrafts ? (
            <Select.Item value="__NONE__" disabled>
              {emptyMenuLabel}
            </Select.Item>
          ) : (
            <Select.Item value="__NONE__" disabled>
              {emptyLabel}
            </Select.Item>
          )}
        </Select.Content>
      </Select.Root>
      <ContextMeter status={contextStatus} sessionId={sessionId} />
      <button
        type="button"
        className="gezel-chat-session-btn"
        onClick={() => void createNew()}
        disabled={busy}
        title="Start a fresh thread with this gezel"
      >
        + New
      </button>
      <button
        type="button"
        className="gezel-chat-session-btn"
        onClick={() => void createDraft()}
        disabled={busy}
        title="Start a message you can come back to — no thread until you send it"
      >
        + Draft
      </button>
      <PromptDraftsMenu
        projectId={projectId}
        gezelId={gezelId}
        sessionId={sessionId}
        activeDraftId={activeDraftId}
        drafts={threadDrafts}
        onDraftSelect={onDraftSelect}
        onChanged={() => void refreshDrafts()}
        {...(taskRef ? { taskRef } : {})}
        {...(craftbookRef ? { craftbookRef } : {})}
        {...(draftScope ? { draftScope } : {})}
      />
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

function renderRow(s: ChatSessionSummary, engineLabel?: string | null): ReactNode {
  return (
    <span className="session-row">
      <span className="session-row-title">
        {renderTitleWithMentions(displayThreadTitle(s.title))}
      </span>
      <span className="session-row-meta" title={formatAbsoluteTime(s.lastActivityAt)}>
        {` · ${formatRelativeTime(s.lastActivityAt)} · ${engineSuffix(s, engineLabel)}`}
      </span>
    </span>
  );
}

function rowTextValue(s: ChatSessionSummary, engineLabel?: string | null): string {
  return `${plainTitle(displayThreadTitle(s.title))} · ${formatRelativeTime(s.lastActivityAt)} · ${engineSuffix(s, engineLabel)}`;
}

/**
 * A draft that has no thread yet. It reads like a thread row on purpose —
 * from the user's side it is the same thing, one step earlier — with a badge
 * so the difference is visible before they commit to it.
 */
function renderDraftRow(d: PromptDraftSummary): ReactNode {
  return (
    <span className="session-row">
      <span className="session-row-title">{d.title || 'Untitled draft'}</span>
      <span className="session-row-draft-mark">draft</span>
      <span className="session-row-meta" title={formatAbsoluteTime(d.updatedAt)}>
        {` · ${formatRelativeTime(d.updatedAt)}`}
      </span>
    </span>
  );
}

function draftRowTextValue(d: PromptDraftSummary): string {
  return `${d.title || 'Untitled draft'} · draft · ${formatRelativeTime(d.updatedAt)}`;
}
