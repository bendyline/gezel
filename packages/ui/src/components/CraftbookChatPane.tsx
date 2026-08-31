import { type GezelSummary, displayName } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

interface CraftbookChatPaneProps {
  craftbookId: string;
  craftbookName: string;
  readOnly?: boolean;
}

// Craftbook templates are global, so their editing sessions live in the
// implicit "default" project alongside the Meester's own.
const PANE_PROJECT = 'default';

/**
 * The craftbook editor's AI-assist pane. A streaming chat scoped to the
 * craftbook (`craftbookRef`) and driven by the **voorman** (the role that
 * authors craftbooks) — the same persona and `craftbook_*` tools used when
 * building a task's craftbook on the fly. Reuses ChatComposer +
 * ProjectTimeline wholesale; when a `craftbook_*` tool fires it nudges the
 * editor to refetch so the voorman's edits appear live in the tracker.
 */
export function CraftbookChatPane({
  craftbookId,
  craftbookName,
  readOnly,
}: CraftbookChatPaneProps) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [sessionId, setSessionId] = useState('');

  useEffect(() => {
    api
      .listGezels()
      .then((r) => setGezels(r.gezels))
      .catch(() => {});
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: craftbookId is the reset trigger.
  useEffect(() => {
    setSessionId('');
  }, [craftbookId]);

  // The voorman authors craftbooks; fall back to the Meester, then anyone.
  const gezel = useMemo(
    () =>
      gezels.find((g) => g.role === 'voorman') ??
      gezels.find((g) => g.role === 'meester') ??
      gezels[0],
    [gezels],
  );

  const onCraftbookTool = (name: string | undefined) => {
    if (name?.startsWith('craftbook_')) {
      window.dispatchEvent(
        new CustomEvent('gezel:craftbook-edited', { detail: { id: craftbookId } }),
      );
    }
  };

  if (readOnly) {
    return (
      <div className="craftbook-chat-pane muted small">
        This craftbook is read-only — fork it to a local copy to edit it with AI.
      </div>
    );
  }
  if (!gezel) {
    return (
      <div className="craftbook-chat-pane muted small">
        No gezel available yet. Create a voorman or the Meester first, then come back.
      </div>
    );
  }
  const gezelDisplayName = displayName(gezel, roleBasedNameOnlyMode);

  return (
    <div className="craftbook-chat-pane task-detail-chat">
      <ProjectTimeline
        projectId={PANE_PROJECT}
        activeSessionId={sessionId || undefined}
        onFocusSession={(sid, gid) => {
          if (gid === gezel.id) setSessionId(sid);
        }}
        onToolActivity={(tool) => onCraftbookTool(tool.name)}
      />
      <ChatComposer
        gezelId={gezel.id}
        gezelName={gezel.name}
        gezelRoleBasedName={gezel.roleBasedName}
        gezelRole={gezel.role}
        gezelIcon={gezel.icon ?? null}
        {...(gezel.poppetje ? { gezelPoppetje: gezel.poppetje } : {})}
        {...(gezel.iconOverride ? { gezelIconOverride: gezel.iconOverride } : {})}
        projectId={PANE_PROJECT}
        sessionId={sessionId || undefined}
        onSessionCreated={(sid) => setSessionId(sid)}
        onToolActivity={(tool) => onCraftbookTool(tool.name)}
        craftbookRef={craftbookId}
        placeholder={`Ask ${gezelDisplayName} to shape “${craftbookName}” — add steps, set roles, wire gates…`}
      />
    </div>
  );
}
