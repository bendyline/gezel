import type { ChatSessionSummary } from '@bendyline/gezel';
import { parseTaskRef } from '@bendyline/gezel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';
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
   * Overrides the per-row engine/model suffix (normally the chat
   * provider + model, e.g. "This Mac (qwen3.6-…)"). Set for fixed-function
   * generator gezels so the row shows the generation model instead, e.g.
   * "Video · ltx-video-0.9.7". When null/undefined the default suffix shows.
   */
  engineLabel?: string | null;
}

/**
 * Coalesce the user-message + done pair (and bursts of concurrent external
 * turns) into one session-list read. This is deliberately much shorter than
 * a polling interval: the event itself is the invalidation signal.
 */
const LIVE_SESSION_REFRESH_DEBOUNCE_MS = 150;

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
  engineLabel,
}: Props) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const autoPickedFor = useRef<string | null>(null);
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
    if (sessions.length === 0) return;
    autoPickedFor.current = key;
    onSessionIdChange(sessions[0]!.id);
  }, [sessions, sessionsScope, sessionId, scopeKey, onSessionIdChange]);

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

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, LIVE_SESSION_REFRESH_DEBOUNCE_MS);
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
            if (envelope.projectId !== projectId || envelope.gezelId !== gezelId) continue;
            const { event } = envelope;
            if (event.type === 'user_message' || event.type === 'done') scheduleRefresh();
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

  const archiveCurrent = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.archiveChatSession(sessionId);
      const remaining = await refresh();
      onSessionIdChange(remaining[0]?.id);
    } finally {
      setBusy(false);
    }
  }, [sessionId, refresh, onSessionIdChange]);

  const hasSessions = sessions.length > 0;
  const activeValue = sessionId && hasSessions ? sessionId : '__NONE__';
  const emptyLabel = gezelName
    ? `No threads with ${gezelName} yet — a message starts one`
    : 'No threads yet';

  return (
    <div className="gezel-chat-session-header">
      <Select.Root
        value={activeValue}
        onValueChange={(v) => {
          if (v && v !== '__NONE__') onSessionIdChange(v);
        }}
        disabled={!hasSessions || busy}
      >
        <Select.Trigger className="gezel-chat-session-select">
          <Select.Value placeholder={hasSessions ? 'Pick a thread' : emptyLabel} />
        </Select.Trigger>
        <Select.Content className="gezel-chat-session-menu">
          {hasSessions ? (
            sessions.map((s) => (
              <Select.Item key={s.id} value={s.id} textValue={rowTextValue(s, engineLabel)}>
                {renderRow(s, engineLabel)}
              </Select.Item>
            ))
          ) : (
            <Select.Item value="__NONE__" disabled>
              {emptyLabel}
            </Select.Item>
          )}
        </Select.Content>
      </Select.Root>
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
