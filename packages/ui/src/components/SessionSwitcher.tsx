import type { ChatSessionSummary } from '@bendyline/gezel';
import { parseTaskRef } from '@bendyline/gezel';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { providerLabel as resolveProviderLabel } from './provider-label.js';

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
  onNewSessionCreated,
  refreshKey,
  taskRef,
  stepId,
  engineLabel,
}: Props) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const autoPickedFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
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
    // Clear the list synchronously so the auto-pick effect below
    // doesn't fire on stale data while `refresh()` is in flight.
    // Without this, an @-mention pivot from gezel A to B (which
    // changes `gezelId` and resets `sessionId` in the parent in
    // the same tick) leaves us showing A's sessions and we'd
    // auto-pick A's most-recent session — landing the parent on
    // a session id that isn't even in B's list, so the dropdown
    // renders empty. Clearing first means the auto-pick waits
    // for B's list to resolve before settling.
    setSessions([]);
    void refresh();
  }, [refresh, refreshKey]);

  // Auto-pick the most-recent session when we mount (or swap to a new
  // scope) and the caller doesn't already have one. Only once per scope
  // — we don't want to stomp a user's explicit pick after they've acted.
  useEffect(() => {
    const key = `${gezelId}:${projectId}:${taskRef ?? ''}`;
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
  }, [sessions, sessionId, gezelId, projectId, taskRef, onSessionIdChange]);

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
 * `@[Label](gezel:id)` mention markdown — the same wire form
 * `extractMentionTokens` reads. Used here to swap raw mention syntax in a
 * thread title for a compact `@Label` pill. The provider name in each row
 * comes from the shared `providerLabel` helper (e.g. "This Windows PC").
 */
const MENTION_RE = /@\[([^\]]+)\]\(gezel\\?:[^)\s]+\)/g;

/** Render a thread title with its `@mention`s as pills, rest as text. */
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

/** Flatten mentions to `@Label` text for typeahead + the trigger value. */
function plainTitle(title: string): string {
  return title.replace(MENTION_RE, (_full, label: string) => `@${label}`);
}

/**
 * The service stamps a fresh thread with the sentinel title "New session"
 * (and keys its auto-title logic off that exact string — see
 * `chat/manager.ts`). Show it as "New thread" in the UI without renaming
 * the stored sentinel.
 */
const NEW_THREAD_SENTINEL = 'New session';
function displayThreadTitle(title: string): string {
  return title === NEW_THREAD_SENTINEL ? 'New thread' : title;
}

// The engine/model suffix shown after the relative time. `engineLabel`
// (fixed-function generators) wins; otherwise it's the chat provider + model.
function engineSuffix(s: ChatSessionSummary, engineLabel?: string | null): string {
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
      <span className="session-row-meta">
        {` · ${formatRelativeTime(s.lastActivityAt)} · ${engineSuffix(s, engineLabel)}`}
      </span>
    </span>
  );
}

function rowTextValue(s: ChatSessionSummary, engineLabel?: string | null): string {
  return `${plainTitle(displayThreadTitle(s.title))} · ${formatRelativeTime(s.lastActivityAt)} · ${engineSuffix(s, engineLabel)}`;
}

function formatRelativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
