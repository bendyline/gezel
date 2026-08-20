import { parseTaskRef } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { ChatTimelineView } from './ChatTimelineView.js';
import type { ToolActivity } from './chat-bubbles.js';

/**
 * Project-scoped chat timeline. Loads + tails every session in the
 * project, interleaved chronologically. When `gezelId` is set, the
 * timeline is additionally filtered to that gezel's sessions — used by
 * the per-gezel Chat tab to feel like a DM scoped to one project.
 *
 * When `taskRef` is set, the timeline narrows to the sessions pinned to
 * that task — used by the Task detail's Chat tab, whose header names a
 * single task and must not show the rest of the project's conversation.
 * Handoff sessions (a different gezel picking up the same task via
 * `advance_task_step`) share the ref and stay in view.
 *
 * The composer (rendered by the parent) is what scopes new messages to
 * a single (gezel, session).
 */
export function ProjectTimeline({
  projectId,
  gezelId,
  taskRef,
  activeSessionId,
  onFocusSession,
  onToolActivity,
  onArtifactReference,
  onArtifactSeen,
  onWorkspaceReference,
  onWorkspaceSeen,
  onTaskReference,
  emptyPlaceholder,
  onTerminalWorkingDirChanged,
  terminalRefreshKey,
  terminalSubmission,
  terminalFocusRequest,
  sessionFocusRequest,
}: {
  projectId: string;
  gezelId?: string;
  taskRef?: string;
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  onToolActivity?: (tool: ToolActivity) => void;
  onArtifactReference?: (path: string, projectId?: string) => void;
  onArtifactSeen?: (path: string, projectId?: string) => void;
  onWorkspaceReference?: (path: string, projectId?: string) => void;
  onWorkspaceSeen?: (path: string, projectId?: string) => void;
  onTaskReference?: (ref: string, opts?: { scoped?: boolean }) => void;
  emptyPlaceholder?: string;
  onTerminalWorkingDirChanged?: (threadId: string, newWorkingDir: string) => void;
  terminalRefreshKey?: number;
  terminalSubmission?: {
    runId: string;
    threadId: string;
    input: string;
  };
  terminalFocusRequest?: { threadId: string; requestKey: number };
  sessionFocusRequest?: { sessionId: string; requestKey: number; messageIndex?: number };
}) {
  const loadTimeline = useCallback(
    (opts: { limit: number; before?: string }) =>
      api.listProjectTimeline(projectId, {
        ...opts,
        ...(gezelId ? { gezelId } : {}),
        ...(taskRef ? { taskRef } : {}),
      }),
    [projectId, gezelId, taskRef],
  );
  // When `gezelId` is set we subscribe to the per-gezel stream rather
  // than the project stream and rely on the inflight-scope guard to
  // drop the (rare) cross-project event a gezel might emit elsewhere.
  // The per-gezel stream is narrower than the project stream so this
  // is also less wasted work.
  const streamUrl = useCallback(
    () => (gezelId ? api.gezelEventsUrl(gezelId) : api.projectEventsUrl(projectId)),
    [projectId, gezelId],
  );
  // Terminal events ride a sibling SSE channel scoped to the project.
  // Only the project-scoped view (no gezelId) opens it — the per-gezel
  // chat tab inside a project also uses ProjectTimeline, and the
  // toggle / TerminalComposer don't live in that surface. A task-scoped
  // timeline skips it for the same reason: project-wide shell output is
  // exactly the noise the task filter exists to remove.
  const terminalStreamUrl = useCallback(() => api.terminalEventsUrl(projectId), [projectId]);
  // `inflightScope` is in ChatTimelineView's reload effect deps. A
  // fresh inline `{ projectId }` literal here would trip the deep
  // reload (clear messages + live state, refetch from disk) on every
  // parent re-render — and the App-level usage poll re-renders the
  // whole tree every 10s, which is exactly the "chat flickers every
  // ~10s with nothing happening" symptom. useMemo keeps the
  // reference stable across re-renders.
  const inflightScope = useMemo(
    () => (gezelId ? { projectId, gezelId } : { projectId }),
    [projectId, gezelId],
  );

  // ── task-scoped session allowlist ──
  //
  // The SSE channel above is project- or gezel-wide and chat envelopes
  // carry no `taskRef`, so the server-side filter on the initial fetch
  // isn't enough on its own: live turns from unrelated sessions would
  // still stream in. Resolve the task's sessions to ids and hand them
  // to the timeline as an allowlist.
  const [taskSessionIds, setTaskSessionIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionsRefreshKey is the refetch trigger — it appears nowhere in the body by design.
  useEffect(() => {
    if (!taskRef) {
      setTaskSessionIds(EMPTY_SET);
      return;
    }
    const parsed = parseTaskRef(taskRef);
    if (!parsed) {
      setTaskSessionIds(EMPTY_SET);
      return;
    }
    let cancelled = false;
    void api
      .listTaskSessions(parsed.projectId, parsed.num)
      .then((res) => {
        if (cancelled) return;
        // Match the server-side timeline, which skips archived sessions —
        // otherwise a live event on an archived thread would render a
        // bubble that the next reload silently drops. An archived session
        // the user deliberately opened still gets through as
        // `activeSessionId` below.
        setTaskSessionIds(new Set(res.sessions.filter((s) => !s.archived).map((s) => s.id)));
      })
      .catch(() => {
        // Non-fatal: the fetched history is already task-filtered
        // server-side. Only the live-stream guard degrades, and the
        // unknown-session refetch below gets another chance.
      });
    return () => {
      cancelled = true;
    };
  }, [taskRef, sessionsRefreshKey]);

  // A session created by this pane's composer, or one the timeline just
  // focused, is in scope by construction — union it in so the user's own
  // first message in a brand-new task thread isn't held back for the
  // round trip the refetch below costs.
  const scopedSessionIds = useMemo(() => {
    if (!taskRef) return undefined;
    if (!activeSessionId) return taskSessionIds;
    if (taskSessionIds.has(activeSessionId)) return taskSessionIds;
    return new Set([...taskSessionIds, activeSessionId]);
  }, [taskRef, taskSessionIds, activeSessionId]);

  // Debounce the refetch: a handoff session mid-turn emits a delta per
  // token, and every one of them misses the allowlist until the refetch
  // lands. Without this guard that's a fetch per token.
  const refetchPendingRef = useRef(false);
  const onUnknownSession = useCallback(() => {
    if (refetchPendingRef.current) return;
    refetchPendingRef.current = true;
    setTimeout(() => {
      refetchPendingRef.current = false;
      setSessionsRefreshKey((k) => k + 1);
    }, 500);
  }, []);

  return (
    <ChatTimelineView
      scopeKey={
        taskRef
          ? `project:${projectId}:task:${taskRef}`
          : gezelId
            ? `project:${projectId}:gezel:${gezelId}`
            : `project:${projectId}`
      }
      activeSessionId={activeSessionId}
      onFocusSession={onFocusSession}
      onToolActivity={onToolActivity}
      onArtifactReference={onArtifactReference}
      onArtifactSeen={onArtifactSeen}
      onWorkspaceReference={onWorkspaceReference}
      onWorkspaceSeen={onWorkspaceSeen}
      {...(onTaskReference ? { onTaskReference } : {})}
      emptyPlaceholder={emptyPlaceholder}
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      {...(gezelId || taskRef ? {} : { terminalStreamUrl })}
      {...(terminalRefreshKey !== undefined ? { terminalRefreshKey } : {})}
      {...(terminalSubmission ? { terminalSubmission } : {})}
      {...(terminalFocusRequest ? { terminalFocusRequest } : {})}
      {...(sessionFocusRequest ? { sessionFocusRequest } : {})}
      {...(gezelId || taskRef || !onTerminalWorkingDirChanged
        ? {}
        : { onTerminalWorkingDirChanged })}
      inflightScope={inflightScope}
      {...(scopedSessionIds ? { scopedSessionIds, onUnknownSession } : {})}
    />
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();
