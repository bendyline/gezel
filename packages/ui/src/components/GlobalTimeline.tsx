import { useCallback } from 'react';
import { api } from '../api.js';
import { ChatTimelineView } from './ChatTimelineView.js';
import type { ToolActivity } from './chat-bubbles.js';
import type { OpenChatReference } from './chat-open-command.js';

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
  onOpenReference,
  onTaskReference,
  emptyPlaceholder,
  emptyContent,
  trailingContent,
  trailingContentAfterWrapUp,
  foldWorkingNotes,
  onAttentionChange,
}: {
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  onToolActivity?: (tool: ToolActivity) => void;
  onArtifactReference?: (path: string, projectId?: string) => void;
  onArtifactSeen?: (path: string, projectId?: string) => void;
  onWorkspaceReference?: (path: string, projectId?: string) => void;
  onWorkspaceSeen?: (path: string, projectId?: string) => void;
  onOpenReference?: (reference: OpenChatReference) => void;
  onTaskReference?: (
    ref: string,
    opts?: { scoped?: boolean; focus?: boolean; wrappedUp?: boolean },
  ) => void;
  emptyPlaceholder?: string;
  /** Rich empty state; see ChatTimelineView. */
  emptyContent?: import('react').ReactNode;
  /** After the last message; see ChatTimelineView. */
  trailingContent?: import('react').ReactNode;
  /** Hold trailingContent until a task has finished; see ChatTimelineView. */
  trailingContentAfterWrapUp?: boolean;
  /** Fold launched sessions into one Working notes line; see ChatTimelineView. */
  foldWorkingNotes?: boolean;
  /** What is waiting on the person; see ChatTimelineView. */
  onAttentionChange?: (attention: { failedTurn: boolean; latestReplyAt: string | null }) => void;
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
      onOpenReference={onOpenReference}
      {...(onTaskReference ? { onTaskReference } : {})}
      emptyPlaceholder={emptyPlaceholder}
      emptyContent={emptyContent}
      trailingContent={trailingContent}
      {...(foldWorkingNotes ? { foldWorkingNotes } : {})}
      {...(onAttentionChange ? { onAttentionChange } : {})}
      {...(trailingContentAfterWrapUp ? { trailingContentAfterWrapUp } : {})}
      // The loader leaves scheduled runs out; keep their live turns out too.
      hideScheduledRuns
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      showProjectName
    />
  );
}
