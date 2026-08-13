import { useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { ChatTimelineView } from './ChatTimelineView.js';
import type { ToolActivity } from './chat-bubbles.js';

/**
 * Per-gezel chat timeline. Loads + tails every session for one gezel
 * across every project, interleaved chronologically. The "All
 * projects" mode of the Gezels-tab Chat surface uses this; the
 * single-project mode reuses `ProjectTimeline` with a `gezelId`
 * filter.
 */
export function GezelTimeline({
  gezelId,
  activeSessionId,
  onFocusSession,
  onToolActivity,
  onArtifactReference,
  onArtifactSeen,
  onWorkspaceSeen,
  onTaskReference,
  emptyPlaceholder,
}: {
  gezelId: string;
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  onToolActivity?: (tool: ToolActivity) => void;
  onArtifactReference?: (path: string, projectId?: string) => void;
  onArtifactSeen?: (path: string, projectId?: string) => void;
  onWorkspaceSeen?: (path: string, projectId?: string) => void;
  onTaskReference?: (ref: string, opts?: { scoped?: boolean }) => void;
  emptyPlaceholder?: string;
}) {
  const loadTimeline = useCallback(
    (opts: { limit: number; before?: string }) => api.listGezelTimeline(gezelId, opts),
    [gezelId],
  );
  const streamUrl = useCallback(() => api.gezelEventsUrl(gezelId), [gezelId]);
  const inflightScope = useMemo(() => ({ gezelId }), [gezelId]);

  return (
    <ChatTimelineView
      scopeKey={`gezel:${gezelId}`}
      activeSessionId={activeSessionId}
      onFocusSession={onFocusSession}
      onToolActivity={onToolActivity}
      onArtifactReference={onArtifactReference}
      onArtifactSeen={onArtifactSeen}
      onWorkspaceSeen={onWorkspaceSeen}
      {...(onTaskReference ? { onTaskReference } : {})}
      emptyPlaceholder={emptyPlaceholder}
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      inflightScope={inflightScope}
    />
  );
}
