import type { ChatEventEnvelope, ChatMessage, ChatSessionSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';
import { displayThreadTitle, plainTitle } from './session-labels.js';
import { useFinishedTaskRefs } from './useFinishedTaskRefs.js';

/**
 * How stale an *idle* thread may be and still earn a pill. A day covers a
 * working session: anything older is history you reach for deliberately
 * through the SessionSwitcher dropdown, not something worth spending a
 * glanceable slot on. Threads that are streaming or errored ignore this
 * entirely — their state is what earns the pill, not their recency.
 */
export const RECENT_THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Inline pill budget before the rest spill into the "+N more" menu.
 * Because {@link selectThreadPills} sorts state-first, the cap can only
 * ever push *idle* pills into the overflow — unless more than this many
 * threads are live or errored at once, in which case the row grows rather
 * than hiding something that needs attention.
 */
export const MAX_INLINE_THREAD_PILLS = 6;

/** Debounce for session re-reads triggered by a burst of stream events. */
const SESSION_REFRESH_DEBOUNCE_MS = 750;

/**
 * Self-heal cadence for the in-flight set. Matches the 20s reconcile in
 * [App.tsx](../App.tsx) for the same reason: a dropped `done` envelope
 * must not pin a pill to "streaming" forever.
 */
const INFLIGHT_RECONCILE_MS = 20_000;

export type ThreadPillState = 'inflight' | 'errored' | 'idle';

export interface ThreadPill {
  sessionId: string;
  gezelId: string;
  /** Sentinel-normalized, mentions flattened to `@Label`. */
  title: string;
  lastActivityAt: string;
  state: ThreadPillState;
  /** Bounded latest-message text supplied by the session summary. */
  lastMessagePreview?: string;
  /**
   * Tool the session is running right now, streamed rather than persisted.
   * Lets a live pill say what the gezel is doing instead of echoing the
   * message that started the turn.
   */
  liveToolName?: string;
  /** Primary session gezel first, followed by any gezels that spoke into it. */
  involvedGezelIds: string[];
  taskRef?: string;
  /** `lastTurnError`, or the optimistic error from a live `error` event. */
  error?: string;
}

const STATE_RANK: Record<ThreadPillState, number> = { inflight: 0, errored: 1, idle: 2 };

function activityMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function messagePreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  let preview = '';
  for (const character of normalized) {
    if (preview.length + character.length > 200) break;
    preview += character;
  }
  return preview;
}

function applyLatestMessage(
  sessions: ChatSessionSummary[],
  sessionId: string,
  message: ChatMessage,
): ChatSessionSummary[] | null {
  let found = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    found = true;
    const involvedGezelIds = new Set(session.involvedGezelIds ?? [session.gezelId]);
    if (message.from) involvedGezelIds.add(message.from.gezelId);
    const preview = messagePreview(message.content);
    return {
      ...session,
      lastActivityAt: message.at,
      involvedGezelIds: [...involvedGezelIds],
      ...(preview ? { lastMessagePreview: preview } : {}),
    };
  });
  return found ? next : null;
}

/**
 * Pure selection core: decide which sessions get pills, in what order, and
 * where the inline list stops. Split out from the hook so the rules are
 * testable without a DOM or a fake clock.
 *
 * `groupedTaskRefs` carries the active tasks that own a unified task/chat
 * pill on the row. Their newest non-archived thread is returned through
 * `taskPills` and never appears as a separate thread pill, regardless of
 * state. The newest independent thread is always retained, even after the
 * ordinary recency window, so the bar keeps one route back to unscoped chat.
 *
 * `finishedTaskRefs` names tasks that have settled (`complete`/`canceled`).
 * Their chats are history — reachable from the task itself — so an idle one
 * earns no glanceable slot. A thread that is streaming, errored, or pinned
 * keeps its pill either way: state and the composer's focus outrank tidiness.
 */
export function selectThreadPills(input: {
  sessions: ChatSessionSummary[];
  inflight: ReadonlySet<string>;
  errored: ReadonlyMap<string, string>;
  now: number;
  pinnedSessionId?: string | undefined;
  groupedTaskRefs?: ReadonlySet<string>;
  finishedTaskRefs?: ReadonlySet<string>;
  /** Session id → the tool it is running, from the live event stream. */
  liveTools?: ReadonlyMap<string, string>;
  maxInline?: number;
}): {
  pills: ThreadPill[];
  overflow: ThreadPill[];
  taskPills: ReadonlyMap<string, ThreadPill>;
} {
  const {
    sessions,
    inflight,
    errored,
    now,
    pinnedSessionId,
    groupedTaskRefs,
    finishedTaskRefs,
    liveTools,
    maxInline = MAX_INLINE_THREAD_PILLS,
  } = input;

  const candidates: ThreadPill[] = [];
  const taskPills = new Map<string, ThreadPill>();
  const latestIndependentSessionId = sessions
    .filter((session) => !session.archived && !session.taskRef)
    .reduce<ChatSessionSummary | null>((latest, session) => {
      if (!latest || activityMs(session.lastActivityAt) > activityMs(latest.lastActivityAt)) {
        return session;
      }
      return latest;
    }, null)?.id;

  for (const s of sessions) {
    if (s.archived) continue;

    const error = errored.get(s.id) ?? s.lastTurnError;
    const state: ThreadPillState = inflight.has(s.id) ? 'inflight' : error ? 'errored' : 'idle';
    // A tool only describes what is happening while the turn is open; once
    // it closes, the message that landed is the truthful summary.
    const liveToolName = state === 'inflight' ? liveTools?.get(s.id) : undefined;

    const pill: ThreadPill = {
      sessionId: s.id,
      gezelId: s.gezelId,
      title: plainTitle(displayThreadTitle(s.title)),
      lastActivityAt: s.lastActivityAt,
      state,
      involvedGezelIds:
        s.involvedGezelIds && s.involvedGezelIds.length > 0 ? s.involvedGezelIds : [s.gezelId],
      ...(s.lastMessagePreview ? { lastMessagePreview: s.lastMessagePreview } : {}),
      ...(liveToolName ? { liveToolName } : {}),
      ...(s.taskRef ? { taskRef: s.taskRef } : {}),
      ...(error ? { error } : {}),
    };

    if (s.taskRef && groupedTaskRefs?.has(s.taskRef)) {
      const current = taskPills.get(s.taskRef);
      if (!current || activityMs(pill.lastActivityAt) > activityMs(current.lastActivityAt)) {
        taskPills.set(s.taskRef, pill);
      }
      continue;
    }

    const pinned = pinnedSessionId !== undefined && s.id === pinnedSessionId;
    // A settled task's chat is a record of finished work, not a live thread.
    if (state === 'idle' && !pinned && s.taskRef && finishedTaskRefs?.has(s.taskRef)) continue;

    const latestIndependent = s.id === latestIndependentSessionId;
    if (state === 'idle' && !pinned && !latestIndependent) {
      if (now - activityMs(s.lastActivityAt) > RECENT_THREAD_WINDOW_MS) continue;
    }

    candidates.push(pill);
  }

  candidates.sort((a, b) => {
    const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (byState !== 0) return byState;
    return activityMs(b.lastActivityAt) - activityMs(a.lastActivityAt);
  });

  // Never overflow something that needs attention: the inline list runs to
  // `maxInline` OR to the end of the live/errored run, whichever is longer.
  const attentionCount = candidates.filter((p) => p.state !== 'idle').length;
  let cut = Math.max(maxInline, attentionCount);
  // The pinned thread is the one the composer posts into, and the newest
  // independent thread is the persistent route back out of task scope.
  // Both must stay inline even when they sort past the normal cut.
  for (const requiredId of [pinnedSessionId, latestIndependentSessionId]) {
    if (requiredId === undefined) continue;
    const requiredAt = candidates.findIndex((p) => p.sessionId === requiredId);
    if (requiredAt >= cut) cut = requiredAt + 1;
  }

  return { pills: candidates.slice(0, cut), overflow: candidates.slice(cut), taskPills };
}

/**
 * Thread-pill data for one project's chat.
 *
 * Live state rides the **existing** project SSE stream rather than a new
 * poller: [shared-chat-events](../shared-chat-events.ts) keys one upstream
 * connection per URL and fans it out in memory, and `ProjectTimeline`
 * already opens exactly this URL for the same project — so this
 * subscription costs no extra connection, and its replay cache paints a
 * mid-turn pill immediately on mount.
 *
 * `gezelId` narrows the list to one gezel's threads, for surfaces like
 * `GezelChatTab` that are scoped that way. `pinnedSessionId` keeps the
 * focused thread's pill alive regardless of age or cap.
 */
export function useChatThreadPills({
  projectId,
  gezelId,
  pinnedSessionId,
  groupedTaskRefs,
  refreshKey,
}: {
  projectId: string;
  gezelId?: string | undefined;
  pinnedSessionId?: string | undefined;
  groupedTaskRefs?: ReadonlySet<string> | undefined;
  refreshKey?: number | undefined;
}): {
  pills: ThreadPill[];
  overflow: ThreadPill[];
  taskPills: ReadonlyMap<string, ThreadPill>;
  loading: boolean;
} {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const sessionsRef = useRef<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set());
  const [errored, setErrored] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [liveTools, setLiveTools] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Re-run selection on a timer tick as well as on data change, so a thread
  // that ages out of the recency window eventually drops without a refetch.
  const [ageTick, setAgeTick] = useState(0);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.listChatSessions({
        projectId,
        ...(gezelId ? { gezelId } : {}),
      });
      sessionsRef.current = res.sessions;
      setSessions(res.sessions);
    } catch {
      // Leave the last good list up — a transient list failure shouldn't
      // blank a row the user is reading.
    } finally {
      setLoading(false);
    }
  }, [projectId, gezelId]);

  const reconcileInflight = useCallback(async () => {
    try {
      const { inflight: turns } = await api.listInflightTurns({
        projectId,
        ...(gezelId ? { gezelId } : {}),
      });
      setInflight(new Set(turns.map((t) => t.sessionId)));
    } catch {
      /* keep the streamed set */
    }
  }, [projectId, gezelId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a bump counter, while pinnedSessionId forces a re-read when a freshly-created session becomes active.
  useEffect(() => {
    setLoading(true);
    void loadSessions();
    void reconcileInflight();
  }, [loadSessions, reconcileInflight, refreshKey, pinnedSessionId]);

  useEffect(() => {
    const t = window.setInterval(() => void reconcileInflight(), INFLIGHT_RECONCILE_MS);
    return () => window.clearInterval(t);
  }, [reconcileInflight]);

  useEffect(() => {
    const t = window.setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // A chat banner cleared a session's error — re-read the durable flag.
  useEffect(() => {
    const onCleared = () => void loadSessions();
    window.addEventListener('gezel:session-error-cleared', onCleared);
    return () => window.removeEventListener('gezel:session-error-cleared', onCleared);
  }, [loadSessions]);

  const noteLiveTool = useCallback((sessionId: string, name: string | null) => {
    setLiveTools((prev) => {
      if (name === null) {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      }
      if (prev.get(sessionId) === name) return prev;
      const next = new Map(prev);
      next.set(sessionId, name);
      return next;
    });
  }, []);

  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    // One trailing refresh per burst: a fan-out that finishes five sessions
    // at once should cost one `listChatSessions`, not five.
    const scheduleSessionRefresh = () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void loadSessions();
      }, SESSION_REFRESH_DEBOUNCE_MS);
    };

    void (async () => {
      try {
        for await (const env of streamSharedProjectChatEvents({
          url: api.projectEventsUrl(projectId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const { event: ev, sessionId } = env as ChatEventEnvelope;
          if (gezelId && env.gezelId !== gezelId) continue;

          // What the gezel is doing right now. `tool_args_delta` fires while
          // the call is still being composed, which is the long part of the
          // wait; `tool` re-stamps it with the name that actually ran.
          if (ev.type === 'tool_args_delta' || ev.type === 'tool') {
            noteLiveTool(sessionId, ev.name);
          } else if (
            ev.type === 'complete' ||
            ev.type === 'done' ||
            ev.type === 'error' ||
            ev.type === 'cancelled'
          ) {
            noteLiveTool(sessionId, null);
          }

          // A turn opens on user_message and closes on done/error/cancelled —
          // the same state machine the sidebar runs in App.tsx.
          if (ev.type === 'user_message') {
            setInflight((prev) => {
              if (prev.has(sessionId)) return prev;
              const next = new Set(prev);
              next.add(sessionId);
              return next;
            });
            const updated = applyLatestMessage(sessionsRef.current, sessionId, ev.message);
            if (updated) {
              sessionsRef.current = updated;
              setSessions(updated);
            } else {
              // The session list may predate this session. In-flight state
              // alone cannot create a pill because selection is anchored on
              // durable summaries, so reconcile before the turn finishes.
              void loadSessions();
            }
          } else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
            setInflight((prev) => {
              if (!prev.has(sessionId)) return prev;
              const next = new Set(prev);
              next.delete(sessionId);
              return next;
            });
          }

          // Paint the error optimistically — the persisted `lastTurnError`
          // lands a beat later and the debounced refresh picks it up.
          if (ev.type === 'error') {
            setErrored((prev) => {
              const next = new Map(prev);
              next.set(sessionId, ev.error);
              return next;
            });
          } else if (ev.type === 'complete') {
            const updated = applyLatestMessage(sessionsRef.current, sessionId, ev.message);
            if (updated) {
              sessionsRef.current = updated;
              setSessions(updated);
            }
            setErrored((prev) => {
              if (!prev.has(sessionId)) return prev;
              const next = new Map(prev);
              next.delete(sessionId);
              return next;
            });
          }

          // Titles and lastActivityAt move when a turn lands.
          if (ev.type === 'done' || ev.type === 'complete') scheduleSessionRefresh();
        }
      } catch {
        /* stream ended or aborted — the 20s reconcile keeps us honest */
      }
    })();

    return () => {
      ctrl.abort();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [projectId, gezelId, loadSessions, noteLiveTool]);

  // Task-scoped threads whose task isn't in the caller's active set: each one
  // is either still live (draft/paused) or already settled, and only the
  // settled ones should lose their pill. The active ones never reach here —
  // they own a unified task pill instead — so this stays a handful of refs.
  const unresolvedTaskRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const s of sessions) {
      if (s.archived || !s.taskRef) continue;
      if (groupedTaskRefs?.has(s.taskRef)) continue;
      refs.add(s.taskRef);
    }
    return [...refs];
  }, [sessions, groupedTaskRefs]);
  const finishedTaskRefs = useFinishedTaskRefs(unresolvedTaskRefs, refreshKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ageTick is the recompute trigger for the recency cutoff — the body reads Date.now(), not the tick.
  const { pills, overflow, taskPills } = useMemo(
    () =>
      selectThreadPills({
        sessions,
        inflight,
        errored,
        now: Date.now(),
        pinnedSessionId,
        liveTools,
        finishedTaskRefs,
        ...(groupedTaskRefs ? { groupedTaskRefs } : {}),
      }),
    [
      sessions,
      inflight,
      errored,
      liveTools,
      pinnedSessionId,
      groupedTaskRefs,
      finishedTaskRefs,
      ageTick,
    ],
  );

  return { pills, overflow, taskPills, loading };
}
