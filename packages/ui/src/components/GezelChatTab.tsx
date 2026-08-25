import {
  type ChatSessionSource,
  type GezelDetail,
  type ProjectForGezel,
  displayName,
  pronounFormsForGender,
} from '@bendyline/gezel';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatReferences } from './ChatReferences.js';
import { GezelTimeline } from './GezelTimeline.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { pickChatPlaceholder } from './chat-placeholder.js';
import { type OpenSessionIntent, consumeOpenSession } from './pending-open-session.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

const ALL_PROJECTS = '__ALL__';
const LAST_PROJECT_KEY_PREFIX = 'gezel:chat:last-project:';

function readLastProjectId(gezelId: string): string | undefined {
  try {
    return window.localStorage.getItem(`${LAST_PROJECT_KEY_PREFIX}${gezelId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function initialProjectId({
  projects,
  intentProjectId,
  lastProjectId,
  workingProjectIds,
}: {
  projects: ProjectForGezel[];
  intentProjectId?: string;
  lastProjectId?: string;
  workingProjectIds?: ReadonlySet<string>;
}): string | undefined {
  if (intentProjectId) {
    return (
      projects.find((project) => project.projectId === intentProjectId)?.projectId ??
      intentProjectId
    );
  }

  // Keep the remembered destination when it is itself working. Otherwise a
  // ranked active project is the most useful place to land on a fresh open.
  if (lastProjectId && workingProjectIds?.has(lastProjectId)) return lastProjectId;
  const workingProject = projects.find((project) => workingProjectIds?.has(project.projectId));
  if (workingProject) return workingProject.projectId;

  if (
    lastProjectId === ALL_PROJECTS ||
    projects.some((project) => project.projectId === lastProjectId)
  ) {
    return lastProjectId;
  }
  return projects[0]?.projectId;
}

function rankedWorkingProjectId(
  projects: ProjectForGezel[],
  workingProjectIds: ReadonlySet<string> | undefined,
): string | undefined {
  return projects.find((project) => workingProjectIds?.has(project.projectId))?.projectId;
}

/**
 * Per-gezel chat surface inside the Gezels screen. The user picks a
 * project from the dropdown — the list is the same ranked set that
 * decides where a Meester-chat `@mention` re-anchors — and the inner
 * body is the same SessionSwitcher + ProjectTimeline + ChatComposer
 * trio Project Chat already uses.
 *
 * Fetches the project list once per gezel; default selection is the
 * first ranked project (voorman > assignment > recent session > the
 * `default` fallback). Switching gezels reshuffles the list.
 */
export function GezelChatTab({
  gezel,
  engineLabel,
  workingProjectIds,
  activeTurnsReady = true,
}: {
  gezel: GezelDetail;
  engineLabel: string | null;
  workingProjectIds?: ReadonlySet<string>;
  activeTurnsReady?: boolean;
}) {
  const [projects, setProjects] = useState<ProjectForGezel[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [focusSessionId, setFocusSessionId] = useState<string>('');
  // Timeline-scroll companion to focusSessionId: carries the transcript-search
  // hit's message index so the viewport lands on the match, not just the
  // session. requestKey makes re-focusing the same session re-fire.
  const [sessionFocusRequest, setSessionFocusRequest] = useState<{
    sessionId: string;
    requestKey: number;
    messageIndex?: number;
  } | null>(null);
  const focusRequestKeyRef = useRef(0);
  const requestSessionFocus = useCallback((sessionId: string, messageIndex?: number) => {
    focusRequestKeyRef.current += 1;
    setSessionFocusRequest({
      sessionId,
      requestKey: focusRequestKeyRef.current,
      ...(messageIndex !== undefined ? { messageIndex } : {}),
    });
  }, []);
  const workingProjectIdsRef = useRef(workingProjectIds);
  const activeTurnsReadyRef = useRef(activeTurnsReady);
  const activityDefaultAppliedRef = useRef(false);
  const projectChoiceWasManualRef = useRef(false);
  workingProjectIdsRef.current = workingProjectIds;
  activeTurnsReadyRef.current = activeTurnsReady;

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setSelectedProjectId('');
    activityDefaultAppliedRef.current = false;
    projectChoiceWasManualRef.current = false;
    // A queued "focus this session" intent (titlebar search result) wins the
    // initial project selection so the target session's timeline mounts.
    const intent = consumeOpenSession(gezel.id);
    if (intent) {
      activityDefaultAppliedRef.current = true;
      projectChoiceWasManualRef.current = true;
      setFocusSessionId(intent.sessionId);
      requestSessionFocus(intent.sessionId, intent.messageIndex);
    }
    api
      .listProjectsForGezel(gezel.id)
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects);
        const first = initialProjectId({
          projects: res.projects,
          intentProjectId: intent?.projectId,
          lastProjectId: readLastProjectId(gezel.id),
          workingProjectIds: activeTurnsReadyRef.current ? workingProjectIdsRef.current : undefined,
        });
        if (first) setSelectedProjectId(first);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gezel.id, requestSessionFocus]);

  // The project roster and the daemon's in-flight snapshot load in parallel.
  // Apply the working-project preference exactly once after both are ready;
  // otherwise a restored All Projects view can win a race by a few
  // milliseconds and remain stuck there for the whole external turn.
  useEffect(() => {
    if (!activeTurnsReady || projects === null || !selectedProjectId) return;
    if (activityDefaultAppliedRef.current || projectChoiceWasManualRef.current) return;
    activityDefaultAppliedRef.current = true;
    if (workingProjectIds?.has(selectedProjectId)) return;
    const workingProjectId = rankedWorkingProjectId(projects, workingProjectIds);
    if (workingProjectId) setSelectedProjectId(workingProjectId);
  }, [activeTurnsReady, projects, selectedProjectId, workingProjectIds]);

  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      window.localStorage.setItem(`${LAST_PROJECT_KEY_PREFIX}${gezel.id}`, selectedProjectId);
    } catch {
      /* private mode / quota — the current selection still lives in memory */
    }
  }, [gezel.id, selectedProjectId]);

  // Live path — the gezel view is already mounted when a search result asks
  // to focus one of this gezel's sessions.
  useEffect(() => {
    const onOpenSession = (e: Event) => {
      const detail = (e as CustomEvent).detail as OpenSessionIntent | undefined;
      if (!detail || detail.gezelId !== gezel.id) return;
      activityDefaultAppliedRef.current = true;
      projectChoiceWasManualRef.current = true;
      if (detail.projectId) setSelectedProjectId(detail.projectId);
      setFocusSessionId(detail.sessionId);
      requestSessionFocus(detail.sessionId, detail.messageIndex);
    };
    window.addEventListener('gezel:open-session', onOpenSession);
    return () => window.removeEventListener('gezel:open-session', onOpenSession);
  }, [gezel.id, requestSessionFocus]);

  // Clicking an already-open working gezel does not remount this component.
  // Treat that click as an explicit request to return to their active project.
  useEffect(() => {
    const onPreferWorkingProject = (event: Event) => {
      const detail = (event as CustomEvent<{ gezelId?: string }>).detail;
      if (detail?.gezelId !== gezel.id || projects === null) return;
      const workingProjectId = rankedWorkingProjectId(projects, workingProjectIds);
      if (!workingProjectId) return;
      activityDefaultAppliedRef.current = true;
      projectChoiceWasManualRef.current = false;
      setSelectedProjectId(workingProjectId);
    };
    window.addEventListener('gezel:prefer-working-project', onPreferWorkingProject);
    return () => window.removeEventListener('gezel:prefer-working-project', onPreferWorkingProject);
  }, [gezel.id, projects, workingProjectIds]);

  // The project the user is chatting about belongs in the tab bar so it
  // mirrors "where work is happening" — but we don't yank focus, since
  // the user is mid-conversation in this gezel tab. The skip-on-default
  // guard avoids tabbing the synthetic "default" fallback project that
  // every install carries; the all-projects sentinel never tabs.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (selectedProjectId === 'default') return;
    if (selectedProjectId === ALL_PROJECTS) return;
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { kind: 'project', id: selectedProjectId, activate: false },
      }),
    );
  }, [selectedProjectId]);

  if (projects === null) {
    return <p className="muted small">Loading projects…</p>;
  }
  if (projects.length === 0) {
    return (
      <p className="muted small">No projects available yet — create one from the Projects tab.</p>
    );
  }

  return (
    <div className="gezel-chat-tab">
      <div className="gezel-chat-project-row">
        <span className="muted small">Project:</span>
        <Select.Root
          value={selectedProjectId}
          onValueChange={(value) => {
            projectChoiceWasManualRef.current = true;
            activityDefaultAppliedRef.current = true;
            setSelectedProjectId(value);
          }}
        >
          <Select.Trigger className="gezel-chat-project-select">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={ALL_PROJECTS}>All projects</Select.Item>
            {projects.map((p) => (
              <Select.Item key={p.projectId} value={p.projectId}>
                {projectLabel(p)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      {selectedProjectId === ALL_PROJECTS ? (
        <GezelChatAllProjectsBody key={`${gezel.id}:__ALL__`} gezel={gezel} />
      ) : (
        selectedProjectId && (
          <GezelChatBody
            key={`${gezel.id}:${selectedProjectId}`}
            gezel={gezel}
            engineLabel={engineLabel}
            project={
              projects.find((p) => p.projectId === selectedProjectId) ?? {
                projectId: selectedProjectId,
                projectName: selectedProjectId,
                precedence: 'session',
              }
            }
            focusSessionId={focusSessionId || undefined}
            sessionFocusRequest={sessionFocusRequest ?? undefined}
          />
        )
      )}
    </div>
  );
}

function projectLabel(p: ProjectForGezel): string {
  switch (p.precedence) {
    case 'voorman':
      return `${p.projectName} — voorman`;
    case 'assignment':
      return `${p.projectName} — assigned`;
    case 'session':
      return `${p.projectName}`;
    case 'fallback':
      return `${p.projectName} (default)`;
  }
}

/**
 * Inner body — owns the per-(gezel, project) session state. Keyed on
 * the parent so changing the project resets the session selection
 * cleanly (same pattern as `ProjectChatBody`).
 */
function GezelChatBody({
  gezel,
  engineLabel,
  project,
  focusSessionId,
  sessionFocusRequest,
}: {
  gezel: GezelDetail;
  engineLabel: string | null;
  project: ProjectForGezel;
  focusSessionId?: string;
  sessionFocusRequest?: { sessionId: string; requestKey: number; messageIndex?: number };
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const gezelDisplayName = displayName(gezel, roleBasedNameOnlyMode);
  const [sessionId, setSessionId] = useState<string>(focusSessionId ?? '');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [composerFocusRequestKey, setComposerFocusRequestKey] = useState(0);
  const [activeSource, setActiveSource] = useState<ChatSessionSource | null>(null);

  // Search-driven focus while already mounted (same gezel + project).
  useEffect(() => {
    if (focusSessionId) setSessionId(focusSessionId);
  }, [focusSessionId]);

  // Note: the parent keys us on `${gezel.id}:${selectedProjectId}` so we
  // always remount when either changes — no in-component reset effect
  // needed.

  // Empty-state copy shown above the timeline when the pair has no
  // messages yet. Keeps the per-gezel-tab framing ("what they're up to
  // in this project") since the composer pill already surfaces who the
  // user is talking to.
  const emptyPlaceholder = useMemo(() => {
    const pronouns = pronounFormsForGender(gezel.gender);
    return `Talk to ${gezelDisplayName} about what ${pronouns.subject} ${pronouns.presentBe} working on in this project.`;
  }, [gezelDisplayName, gezel.gender]);

  // Composer placeholder picks from the role-aware pool so the copy
  // nudges the user toward the right kind of conversation. Voorman
  // picks get the project-scoped variants; everyone else gets the
  // generic worker prompt.
  const composerPlaceholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: project.precedence === 'voorman' ? 'voorman' : 'other',
        gezelName: gezelDisplayName,
        gezelGender: gezel.gender,
        projectName: project.projectName,
        fixedFunctionTool: gezel.fixedFunction?.tool,
      }),
    [
      project.precedence,
      project.projectName,
      gezelDisplayName,
      gezel.gender,
      gezel.fixedFunction?.tool,
    ],
  );

  return (
    <ChatReferences
      projectId={project.projectId}
      skillsProjectId={project.projectId === 'default' ? undefined : project.projectId}
      chatKey={`${project.projectId}:${gezel.id}`}
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
          <ProjectTimeline
            projectId={project.projectId}
            gezelId={gezel.id}
            activeSessionId={sessionId || undefined}
            onFocusSession={(sid, gid) => {
              // Stay on this gezel — only swap the session if it belongs
              // to them. Cross-gezel focus from this surface would mean
              // navigating off the current Gezel screen, which we don't
              // do from here.
              if (gid === gezel.id) setSessionId(sid);
            }}
            onToolActivity={onToolActivity}
            onArtifactReference={onArtifactReference}
            onArtifactSeen={onArtifactSeen}
            onWorkspaceReference={onWorkspaceReference}
            onWorkspaceSeen={onWorkspaceSeen}
            onOpenReference={onOpenReference}
            onTaskReference={onTaskReference}
            emptyPlaceholder={emptyPlaceholder}
            sessionFocusRequest={sessionFocusRequest}
          />
          {activeSource ? (
            <ExternalConversationPanel source={activeSource}>
              <SessionSwitcher
                gezelId={gezel.id}
                projectId={project.projectId}
                sessionId={sessionId || undefined}
                onSessionIdChange={(next) => setSessionId(next ?? '')}
                onActiveSessionChange={(session) => setActiveSource(session?.source ?? null)}
                onNewSessionCreated={() => setComposerFocusRequestKey((key) => key + 1)}
                refreshKey={sessionRefreshKey}
                engineLabel={engineLabel}
              />
            </ExternalConversationPanel>
          ) : (
            <ChatComposer
              gezelId={gezel.id}
              gezelName={gezel.name}
              gezelRoleBasedName={gezel.roleBasedName}
              gezelRole={gezel.role}
              gezelIcon={gezel.icon ?? null}
              gezelPoppetje={gezel.poppetje}
              gezelIconOverride={gezel.iconOverride}
              projectId={project.projectId}
              sessionId={sessionId || undefined}
              focusRequestKey={composerFocusRequestKey}
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
                  gezelId={gezel.id}
                  projectId={project.projectId}
                  sessionId={sessionId || undefined}
                  onSessionIdChange={(next) => setSessionId(next ?? '')}
                  onActiveSessionChange={(session) => setActiveSource(session?.source ?? null)}
                  onNewSessionCreated={() => setComposerFocusRequestKey((key) => key + 1)}
                  refreshKey={sessionRefreshKey}
                  engineLabel={engineLabel}
                />
              }
            />
          )}
        </>
      )}
    </ChatReferences>
  );
}

/**
 * "All projects" mode — read-mostly cross-project DM view of every chat
 * this gezel has had. Clicking a bubble focuses that session so the
 * composer posts back into it. New chats with no focused session fall
 * back to the `default` project (the implicit bucket every install has).
 */
function GezelChatAllProjectsBody({ gezel }: { gezel: GezelDetail }) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const gezelDisplayName = displayName(gezel, roleBasedNameOnlyMode);
  const [focused, setFocused] = useState<{
    sessionId: string;
    projectId: string;
    source?: ChatSessionSource;
  } | null>(null);

  const emptyPlaceholder = useMemo(
    () => `No chats with ${gezelDisplayName} yet — start one below.`,
    [gezelDisplayName],
  );

  const composerPlaceholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: 'other',
        gezelName: gezelDisplayName,
        gezelGender: gezel.gender,
        projectName: focused ? undefined : 'default',
        fixedFunctionTool: gezel.fixedFunction?.tool,
      }),
    [gezelDisplayName, gezel.gender, focused, gezel.fixedFunction?.tool],
  );

  const composerProjectId = focused?.projectId ?? 'default';

  return (
    <ChatReferences
      projectId={composerProjectId}
      skillsProjectId={composerProjectId === 'default' ? undefined : composerProjectId}
      chatKey={`all:${gezel.id}`}
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
          <GezelTimeline
            gezelId={gezel.id}
            activeSessionId={focused?.sessionId}
            onFocusSession={(sid, _gid, pid) => {
              setFocused({ sessionId: sid, projectId: pid });
              void api
                .getChatSession(sid)
                .then((session) => {
                  setFocused((current) =>
                    current?.sessionId === sid
                      ? {
                          sessionId: sid,
                          projectId: pid,
                          ...(session.source ? { source: session.source } : {}),
                        }
                      : current,
                  );
                })
                .catch(() => {});
            }}
            onToolActivity={onToolActivity}
            onArtifactReference={onArtifactReference}
            onArtifactSeen={onArtifactSeen}
            onWorkspaceReference={onWorkspaceReference}
            onWorkspaceSeen={onWorkspaceSeen}
            onOpenReference={onOpenReference}
            onTaskReference={onTaskReference}
            emptyPlaceholder={emptyPlaceholder}
          />
          {focused?.source ? (
            <ExternalConversationPanel source={focused.source} />
          ) : (
            <ChatComposer
              gezelId={gezel.id}
              gezelName={gezel.name}
              gezelRoleBasedName={gezel.roleBasedName}
              gezelRole={gezel.role}
              gezelIcon={gezel.icon ?? null}
              gezelPoppetje={gezel.poppetje}
              gezelIconOverride={gezel.iconOverride}
              projectId={composerProjectId}
              sessionId={focused?.sessionId}
              onSessionCreated={(sid) =>
                setFocused({ sessionId: sid, projectId: composerProjectId })
              }
              onToolActivity={onToolActivity}
              recentReferences={recentReferences}
              onOpenReference={onOpenReference}
              placeholder={composerPlaceholder}
            />
          )}
        </>
      )}
    </ChatReferences>
  );
}

function ExternalConversationPanel({
  source,
  children,
}: {
  source: ChatSessionSource;
  children?: ReactNode;
}) {
  return (
    <div className="external-conversation-panel" aria-live="polite">
      {children}
      <div className="external-conversation-notice">
        <span className="external-conversation-label">From {source.appName} · read-only</span>
        <span>
          This conversation updates live here. Replies and tool controls stay in {source.appName}.
        </span>
      </div>
    </div>
  );
}
