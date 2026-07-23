import { useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { ChatTimelineView } from './ChatTimelineView.js';
import type { ToolActivity } from './chat-bubbles.js';

/**
 * Project-scoped chat timeline. Loads + tails every session in the
 * project, interleaved chronologically. When `gezelId` is set, the
 * timeline is additionally filtered to that gezel's sessions — used by
 * the per-gezel Chat tab to feel like a DM scoped to one project.
 *
 * The composer (rendered by the parent) is what scopes new messages to
 * a single (gezel, session).
 */
export function ProjectTimeline({
  projectId,
  gezelId,
  activeSessionId,
  onFocusSession,
  onToolActivity,
  onArtifactReference,
  onTaskReference,
  emptyPlaceholder,
  onTerminalWorkingDirChanged,
  terminalRefreshKey,
}: {
  projectId: string;
  gezelId?: string;
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  onToolActivity?: (tool: ToolActivity) => void;
  onArtifactReference?: (path: string, projectId?: string) => void;
  onTaskReference?: (ref: string, opts?: { scoped?: boolean }) => void;
  emptyPlaceholder?: string;
  onTerminalWorkingDirChanged?: (threadId: string, newWorkingDir: string) => void;
  terminalRefreshKey?: number;
}) {
  const loadTimeline = useCallback(
    (opts: { limit: number; before?: string }) =>
      api.listProjectTimeline(projectId, gezelId ? { ...opts, gezelId } : opts),
    [projectId, gezelId],
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
  // toggle / TerminalComposer don't live in that surface.
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

  return (
    <ChatTimelineView
      scopeKey={gezelId ? `project:${projectId}:gezel:${gezelId}` : `project:${projectId}`}
      activeSessionId={activeSessionId}
      onFocusSession={onFocusSession}
      onToolActivity={onToolActivity}
      onArtifactReference={onArtifactReference}
      {...(onTaskReference ? { onTaskReference } : {})}
      emptyPlaceholder={emptyPlaceholder}
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      {...(gezelId ? {} : { terminalStreamUrl })}
      {...(terminalRefreshKey !== undefined ? { terminalRefreshKey } : {})}
      {...(gezelId || !onTerminalWorkingDirChanged ? {} : { onTerminalWorkingDirChanged })}
      inflightScope={inflightScope}
    />
  );
}
