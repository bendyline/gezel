import { type GezelSummary, displayName, roleForMatching } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
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
 * The craftbook editor's AI-assist pane: a conversation dedicated to
 * improving this one craftbook. Its threads are pinned to the book
 * (`craftbookRef`), so the daemon gives them the craftbook-editing kit and a
 * prompt about the book, and opens each of the person's messages with the
 * book as it stands and a checkup. The timeline and the thread switcher show
 * only this book's threads, and the newest one resumes when the pane opens.
 * Driven by the **crew lead** (the role that authors craftbooks); when a
 * `craftbook_*` tool fires it nudges the editor to refetch so the edits
 * appear live in the tracker.
 */
export function CraftbookChatPane({
  craftbookId,
  craftbookName,
  readOnly,
}: CraftbookChatPaneProps) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [composerFocusRequestKey, setComposerFocusRequestKey] = useState(0);

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

  // The crew lead authors craftbooks; fall back to the Meester, then anyone.
  const gezel = useMemo(
    () =>
      gezels.find((g) => roleForMatching(g.role)?.toLowerCase() === 'voorman') ??
      gezels.find((g) => g.role?.toLowerCase() === 'meester') ??
      gezels[0],
    [gezels],
  );

  const onCraftbookTool = (name: string | undefined) => {
    if (name?.startsWith('craftbook_') || name === 'set_step_deliverable') {
      window.dispatchEvent(
        new CustomEvent('gezel:craftbook-edited', { detail: { id: craftbookId } }),
      );
    }
  };

  if (readOnly) {
    return (
      <div className="craftbook-chat-pane muted small">
        This craftbook is read-only — fork it to a local copy to improve it with AI.
      </div>
    );
  }
  if (!gezel) {
    return (
      <div className="craftbook-chat-pane muted small">
        No gezel available yet. Create a crew lead or the Meester first, then come back.
      </div>
    );
  }
  const gezelDisplayName = displayName(gezel, roleBasedNameOnlyMode);

  return (
    <div className="craftbook-chat-pane task-detail-chat">
      <ProjectTimeline
        projectId={PANE_PROJECT}
        craftbookRef={craftbookId}
        activeSessionId={sessionId || undefined}
        onFocusSession={(sid, gid) => {
          if (gid === gezel.id) setSessionId(sid);
        }}
        onToolActivity={(tool) => onCraftbookTool(tool.name)}
        emptyPlaceholder={`Ask ${gezelDisplayName} what would make “${craftbookName}” better, or what to change.`}
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
        focusRequestKey={composerFocusRequestKey}
        onSessionCreated={(sid) => {
          setSessionId(sid);
          setSessionRefreshKey((k) => k + 1);
        }}
        onToolActivity={(tool) => onCraftbookTool(tool.name)}
        craftbookRef={craftbookId}
        placeholder={`Ask ${gezelDisplayName} to improve “${craftbookName}”: tighten a step, add a check, name roles…`}
        belowAddressLine={
          <SessionSwitcher
            gezelId={gezel.id}
            projectId={PANE_PROJECT}
            sessionId={sessionId || undefined}
            onSessionIdChange={(next) => setSessionId(next ?? '')}
            onFreshThread={() => setComposerFocusRequestKey((key) => key + 1)}
            refreshKey={sessionRefreshKey}
            craftbookRef={craftbookId}
          />
        }
      />
    </div>
  );
}
