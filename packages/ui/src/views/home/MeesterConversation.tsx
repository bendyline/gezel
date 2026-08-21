import { type GezelSummary, type Poppetje as PoppetjeStruct, displayName } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { ChatComposer } from '../../components/ChatComposer.js';
import { ChatReferences } from '../../components/ChatReferences.js';
import { GlobalTimeline } from '../../components/GlobalTimeline.js';
import { SessionSwitcher } from '../../components/SessionSwitcher.js';
import { pickChatPlaceholder } from '../../components/chat-placeholder.js';
import { useRoleBasedNameOnlyMode } from '../../components/useRoleBasedNameOnlyMode.js';
import { MeesterGreeting } from './MeesterGreeting.js';

/**
 * The meester conversation in the workshop's main column. Reuses the
 * existing global timeline + composer verbatim (migrated from HomeView's
 * `MeesterChatBody`) so streaming, tool calls, mentions, and markdown all
 * keep working. The conversation rail fills the workshop's main column, while
 * the composer receives its own quiet project-chat-style frame in CSS.
 */
export function MeesterConversation({
  meesterGezelId,
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  emptyPlaceholder,
}: {
  meesterGezelId: string;
  meesterName: string;
  meesterIcon: string | null;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIconOverride: boolean;
  emptyPlaceholder?: string;
}) {
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [selectedGezelId, setSelectedGezelId] = useState(meesterGezelId);
  const [projectId, setProjectId] = useState('default');
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();

  // Reset the focused session if the meester changes (rare).
  useEffect(() => {
    setSessionId('');
    setSelectedGezelId(meesterGezelId);
    setProjectId('default');
    api
      .listGezels()
      .then((response) => setGezels(response.gezels))
      .catch(() => setGezels([]));
  }, [meesterGezelId]);

  const selectedGezel = gezels.find((gezel) => gezel.id === selectedGezelId);
  const activeGezelId = selectedGezelId || meesterGezelId;
  const activeGezelName = selectedGezel
    ? displayName(
        { name: selectedGezel.name, roleBasedName: selectedGezel.roleBasedName },
        roleBasedNameOnlyMode,
      )
    : activeGezelId === meesterGezelId
      ? meesterName
      : activeGezelId;
  const activeGezelRole = selectedGezel
    ? selectedGezel.role
    : activeGezelId === meesterGezelId
      ? 'Meester'
      : undefined;
  const activeGezelIcon = selectedGezel
    ? (selectedGezel.icon ?? null)
    : activeGezelId === meesterGezelId
      ? meesterIcon
      : null;
  const activeGezelPoppetje = selectedGezel
    ? (selectedGezel.poppetje ?? null)
    : activeGezelId === meesterGezelId
      ? meesterPoppetje
      : null;
  const activeGezelIconOverride = selectedGezel
    ? (selectedGezel.iconOverride ?? false)
    : activeGezelId === meesterGezelId
      ? meesterIconOverride
      : false;

  const composerPlaceholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: activeGezelId === meesterGezelId ? 'meester' : 'other',
        gezelName: activeGezelName,
        gezelGender: selectedGezel?.gender,
        fixedFunctionTool: selectedGezel?.fixedFunction?.tool,
      }),
    [
      activeGezelId,
      activeGezelName,
      meesterGezelId,
      selectedGezel?.gender,
      selectedGezel?.fixedFunction?.tool,
    ],
  );

  return (
    <section className="home-workshop-conversation" data-testid="meester-chat">
      <ChatReferences
        chatKey="meester:global"
        projectId={projectId}
        skillsProjectId={projectId === 'default' ? undefined : projectId}
      >
        {({
          onToolActivity,
          onArtifactReference,
          onArtifactSeen,
          onWorkspaceReference,
          onWorkspaceSeen,
          recentReferences,
          onOpenReference,
          onTaskReference,
        }) => (
          <>
            <GlobalTimeline
              activeSessionId={sessionId || undefined}
              onFocusSession={(sid, gezelId, focusedProjectId) => {
                setSelectedGezelId(gezelId);
                setProjectId(focusedProjectId);
                setSessionId(sid);
              }}
              onToolActivity={onToolActivity}
              onArtifactReference={onArtifactReference}
              onArtifactSeen={onArtifactSeen}
              onWorkspaceReference={onWorkspaceReference}
              onWorkspaceSeen={onWorkspaceSeen}
              onOpenReference={onOpenReference}
              onTaskReference={onTaskReference}
              emptyPlaceholder={emptyPlaceholder}
              emptyContent={
                // Only the meester's own thread gets the introduction; a
                // handoff thread with another gezel keeps the plain state.
                // Falsy selection means "not chosen yet" — the same fallback
                // activeGezelId above makes.
                !selectedGezelId || selectedGezelId === meesterGezelId ? (
                  <MeesterGreeting
                    meesterName={meesterName}
                    meesterIcon={meesterIcon}
                    meesterPoppetje={meesterPoppetje}
                    meesterIconOverride={meesterIconOverride}
                    projectId={projectId}
                  />
                ) : undefined
              }
            />
            <ChatComposer
              gezelId={activeGezelId}
              gezelName={activeGezelName}
              gezelRoleBasedName={selectedGezel?.roleBasedName}
              gezelRole={activeGezelRole}
              gezelIcon={activeGezelIcon}
              gezelPoppetje={activeGezelPoppetje}
              gezelIconOverride={activeGezelIconOverride}
              recipientGezels={gezels}
              onPrimaryRecipientChange={(gezelId) => {
                setSelectedGezelId(gezelId);
                setProjectId('default');
                setSessionId('');
              }}
              projectId={projectId}
              sessionId={sessionId || undefined}
              onSessionCreated={(sid) => {
                setSessionId(sid);
                setSessionRefreshKey((k) => k + 1);
              }}
              onToolActivity={onToolActivity}
              recentReferences={recentReferences}
              onOpenReference={onOpenReference}
              placeholder={composerPlaceholder}
              belowAddressLine={
                <SessionSwitcher
                  gezelId={activeGezelId}
                  projectId={projectId}
                  sessionId={sessionId || undefined}
                  gezelName={activeGezelName}
                  onSessionIdChange={(next) => setSessionId(next ?? '')}
                  refreshKey={sessionRefreshKey}
                />
              }
            />
          </>
        )}
      </ChatReferences>
    </section>
  );
}
