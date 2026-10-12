import { type GezelSummary, type Poppetje as PoppetjeStruct, displayName } from '@bendyline/gezel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { ChatComposer } from '../../components/ChatComposer.js';
import { ChatReferences } from '../../components/ChatReferences.js';
import { GlobalTimeline } from '../../components/GlobalTimeline.js';
import { SessionSwitcher } from '../../components/SessionSwitcher.js';
import { pickChatPlaceholder } from '../../components/chat-placeholder.js';
import {
  MEESTER_THREAD_KEY,
  readChatThreadSelection,
  writeChatThreadSelection,
} from '../../components/chat-thread-memory.js';
import { useRoleBasedNameOnlyMode } from '../../components/useRoleBasedNameOnlyMode.js';
import {
  MeesterSetupNote,
  MeesterWelcome,
  type WelcomeHelper,
  type WelcomeSetup,
} from './MeesterWelcome.js';

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
  setup = null,
  justReady = false,
  helperGezelIds = [],
  invite,
  onTurnStarted,
  onIntroductionShown,
}: {
  meesterGezelId: string;
  meesterName: string;
  meesterIcon: string | null;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIconOverride: boolean;
  emptyPlaceholder?: string;
  /** First run: what the meester still needs before they can start. */
  setup?: WelcomeSetup | null;
  /** First run ended during this visit. */
  justReady?: boolean;
  /** The install-wide helpers (Klerk, Boekwachter) the welcome introduces. */
  helperGezelIds?: ReadonlyArray<string | undefined>;
  /** Asked at the foot of the conversation once the crew has finished something. */
  invite?: import('react').ReactNode;
  /** The person sent a message from here. */
  onTurnStarted?: () => void;
  /** The meester's introduction fills the empty conversation. */
  onIntroductionShown?: () => void;
}) {
  // Home is swapped out wholesale when the user opens any other area, so this
  // component's local state cannot be the whole record of where they were.
  // Seed from the session-scoped memory instead of always landing back on the
  // meester's newest thread.
  const remembered = readChatThreadSelection(MEESTER_THREAD_KEY);
  const [sessionId, setSessionId] = useState<string>(remembered?.sessionId ?? '');
  // The prompt draft the composer has open. Tracked here because both the
  // composer and the thread picker act on it, and a draft with no thread
  // yet has nothing else to hang off.
  const [draftId, setDraftId] = useState<string>('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [selectedGezelId, setSelectedGezelId] = useState(remembered?.gezelId || meesterGezelId);
  const [projectId, setProjectId] = useState(remembered?.projectId || 'default');
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();

  // Reset the focused session if the meester changes (rare). The remembered
  // selection is only stale on an actual change of meester, so this skips its
  // first run — otherwise it would wipe what we just restored on every mount.
  const lastMeesterRef = useRef(meesterGezelId);
  useEffect(() => {
    if (lastMeesterRef.current !== meesterGezelId) {
      lastMeesterRef.current = meesterGezelId;
      setSessionId('');
      setSelectedGezelId(meesterGezelId);
      setProjectId('default');
    }
    api
      .listGezels()
      .then((response) => setGezels(response.gezels))
      .catch(() => setGezels([]));
  }, [meesterGezelId]);

  useEffect(() => {
    writeChatThreadSelection(MEESTER_THREAD_KEY, {
      gezelId: selectedGezelId,
      projectId,
      sessionId,
    });
  }, [selectedGezelId, projectId, sessionId]);

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

  const helpers = useMemo<WelcomeHelper[]>(() => {
    const does = ['handles the paperwork — titles and summaries', 'keeps track of your files'];
    return helperGezelIds.flatMap((id, index) => {
      const gezel = id ? gezels.find((g) => g.id === id) : undefined;
      if (!gezel) return [];
      return [
        {
          gezel: {
            ...gezel,
            name: displayName(
              { name: gezel.name, roleBasedName: gezel.roleBasedName },
              roleBasedNameOnlyMode,
            ),
          },
          does: does[index] ?? '',
        },
      ];
    });
  }, [helperGezelIds, gezels, roleBasedNameOnlyMode]);
  const onMeesterThread = !selectedGezelId || selectedGezelId === meesterGezelId;

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
              // The person reads the ask, the crew and the result here; the
              // workers' transcripts fold into one Working notes line.
              foldWorkingNotes
              emptyContent={
                // Only the meester's own thread gets the introduction; a
                // handoff thread with another gezel keeps the plain state.
                // Falsy selection means "not chosen yet" — the same fallback
                // activeGezelId above makes.
                onMeesterThread ? (
                  <MeesterWelcome
                    meesterName={meesterName}
                    meesterIcon={meesterIcon}
                    meesterPoppetje={meesterPoppetje}
                    meesterIconOverride={meesterIconOverride}
                    projectId={projectId}
                    setup={setup}
                    justReady={justReady}
                    helpers={helpers}
                    onShown={onIntroductionShown}
                  />
                ) : undefined
              }
              trailingContent={
                setup ? (
                  <MeesterSetupNote
                    meesterName={meesterName}
                    meesterIcon={meesterIcon}
                    meesterPoppetje={meesterPoppetje}
                    meesterIconOverride={meesterIconOverride}
                    setup={setup}
                  />
                ) : (
                  invite
                )
              }
              {...(!setup && invite ? { trailingContentAfterWrapUp: true } : {})}
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
              // The welcome already says the meester is waiting for tools;
              // a second notice above the composer would say it twice.
              hideWaitingNotice={Boolean(setup) && activeGezelId === meesterGezelId}
              onTurnStateChange={(state) => {
                if (state === 'streaming') onTurnStarted?.();
              }}
              onToolActivity={onToolActivity}
              recentReferences={recentReferences}
              onOpenReference={onOpenReference}
              placeholder={composerPlaceholder}
              draftScope="meester"
              draftId={draftId || undefined}
              onDraftIdChange={(next) => setDraftId(next ?? '')}
              // The attached task launches in the composer's current project
              // (Default runs real work). `projects` is only read when the
              // dialog's project picker shows, which the lock suppresses.
              taskLaunch={{
                gezels,
                projects: [],
                onLaunched: () => setSessionRefreshKey((k) => k + 1),
              }}
              belowAddressLine={
                <SessionSwitcher
                  gezelId={activeGezelId}
                  projectId={projectId}
                  sessionId={sessionId || undefined}
                  onSessionIdChange={(next) => setSessionId(next ?? '')}
                  refreshKey={sessionRefreshKey}
                  activeDraftId={draftId || undefined}
                  onDraftSelect={(next) => setDraftId(next ?? '')}
                  draftScope="meester"
                  // The front door opens on a fresh thread: that is where the
                  // Task key lives, and a launch should not land inside
                  // yesterday's conversation. "Where was I" still wins —
                  // the remembered selection is honoured above, and an
                  // unsent thread starter is still restored by the picker.
                  autoPickNewest={false}
                />
              }
            />
          </>
        )}
      </ChatReferences>
    </section>
  );
}
