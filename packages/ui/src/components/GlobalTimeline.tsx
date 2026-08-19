import { useCallback } from 'react';
import { api } from '../api.js';
import { ChatTimelineView } from './ChatTimelineView.js';
import type { ToolActivity } from './chat-bubbles.js';

/**
 * Global Meester timeline. Loads + tails every chat session anywhere in
 * the install. Session dividers include the project name so you can tell
 * cross-project work apart at a glance. The composer (rendered by the
 * parent) still scopes its message to a single (gezel, session) — by
 * default the Meester's own session in the default project.
 */
export function GlobalTimeline({
  activeSessionId,
  onFocusSession,
  onToolActivity,
  onArtifactReference,
  onArtifactSeen,
  onWorkspaceReference,
  onWorkspaceSeen,
  onTaskReference,
  emptyPlaceholder,
  emptyContent,
}: {
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  onToolActivity?: (tool: ToolActivity) => void;
  onArtifactReference?: (path: string, projectId?: string) => void;
  onArtifactSeen?: (path: string, projectId?: string) => void;
  onWorkspaceReference?: (path: string, projectId?: string) => void;
  onWorkspaceSeen?: (path: string, projectId?: string) => void;
  onTaskReference?: (ref: string, opts?: { scoped?: boolean }) => void;
  emptyPlaceholder?: string;
  /** Rich empty state; see ChatTimelineView. */
  emptyContent?: import('react').ReactNode;
}) {
  const loadTimeline = useCallback(
    (opts: { limit: number; before?: string }) => api.listGlobalTimeline(opts),
    [],
  );
  const streamUrl = useCallback(() => api.allEventsUrl(), []);

  return (
    <ChatTimelineView
      scopeKey="global"
      activeSessionId={activeSessionId}
      onFocusSession={onFocusSession}
      onToolActivity={onToolActivity}
      onArtifactReference={onArtifactReference}
      onArtifactSeen={onArtifactSeen}
      onWorkspaceReference={onWorkspaceReference}
      onWorkspaceSeen={onWorkspaceSeen}
      {...(onTaskReference ? { onTaskReference } : {})}
      emptyPlaceholder={emptyPlaceholder}
      emptyContent={emptyContent}
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      showProjectName
    />
  );
}
