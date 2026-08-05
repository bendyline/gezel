import { type GezelDetail, type ProjectForGezel, pronounFormsForGender } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Select } from '../primitives/index.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatReferences } from './ChatReferences.js';
import { GezelTimeline } from './GezelTimeline.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { pickChatPlaceholder } from './chat-placeholder.js';
import { type OpenSessionIntent, consumeOpenSession } from './pending-open-session.js';

const ALL_PROJECTS = '__ALL__';

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
}: {
  gezel: GezelDetail;
  engineLabel: string | null;
}) {
  const [projects, setProjects] = useState<ProjectForGezel[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [focusSessionId, setFocusSessionId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setSelectedProjectId('');
    // A queued "focus this session" intent (titlebar search result) wins the
    // initial project selection so the target session's timeline mounts.
    const intent = consumeOpenSession(gezel.id);
    if (intent) setFocusSessionId(intent.sessionId);
    api
      .listProjectsForGezel(gezel.id)
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects);
        const first =
          (intent?.projectId &&
            res.projects.find((p) => p.projectId === intent.projectId)?.projectId) ??
          intent?.projectId ??
          res.projects[0]?.projectId;
        if (first) setSelectedProjectId(first);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gezel.id]);

  // Live path — the gezel view is already mounted when a search result asks
  // to focus one of this gezel's sessions.
  useEffect(() => {
    const onOpenSession = (e: Event) => {
      const detail = (e as CustomEvent).detail as OpenSessionIntent | undefined;
      if (!detail || detail.gezelId !== gezel.id) return;
      if (detail.projectId) setSelectedProjectId(detail.projectId);
      setFocusSessionId(detail.sessionId);
    };
    window.addEventListener('gezel:open-session', onOpenSession);
    return () => window.removeEventListener('gezel:open-session', onOpenSession);
  }, [gezel.id]);

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
        <Select.Root value={selectedProjectId} onValueChange={(v) => setSelectedProjectId(v)}>
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
}: {
  gezel: GezelDetail;
  engineLabel: string | null;
  project: ProjectForGezel;
  focusSessionId?: string;
}) {
  const [sessionId, setSessionId] = useState<string>(focusSessionId ?? '');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

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
    return `Talk to ${gezel.name} about what ${pronouns.subject} ${pronouns.presentBe} working on in this project.`;
  }, [gezel.name, gezel.gender]);

  // Composer placeholder picks from the role-aware pool so the copy
  // nudges the user toward the right kind of conversation. Voorman
  // picks get the project-scoped variants; everyone else gets the
  // generic worker prompt.
  const composerPlaceholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: project.precedence === 'voorman' ? 'voorman' : 'other',
        gezelName: gezel.name,
        gezelGender: gezel.gender,
        projectName: project.projectName,
        fixedFunctionTool: gezel.fixedFunction?.tool,
      }),
    [project.precedence, project.projectName, gezel.name, gezel.gender, gezel.fixedFunction?.tool],
  );

  return (
    <ChatReferences
      projectId={project.projectId}
      commandsProjectId={project.projectId === 'default' ? undefined : project.projectId}
      chatKey={`${project.projectId}:${gezel.id}`}
    >
      {({ onToolActivity, onArtifactReference, onTaskReference }) => (
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
            onTaskReference={onTaskReference}
            emptyPlaceholder={emptyPlaceholder}
          />
          <ChatComposer
            gezelId={gezel.id}
            gezelName={gezel.name}
            gezelIcon={gezel.icon ?? null}
            gezelPoppetje={gezel.poppetje}
            gezelIconOverride={gezel.iconOverride}
            projectId={project.projectId}
            sessionId={sessionId || undefined}
            onSessionCreated={(sid) => {
              setSessionId(sid);
              setSessionRefreshKey((k) => k + 1);
            }}
            onToolActivity={onToolActivity}
            placeholder={composerPlaceholder}
            belowAddressLine={
              <SessionSwitcher
                gezelId={gezel.id}
                projectId={project.projectId}
                sessionId={sessionId || undefined}
                onSessionIdChange={(next) => setSessionId(next ?? '')}
                refreshKey={sessionRefreshKey}
                engineLabel={engineLabel}
              />
            }
          />
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
  const [focused, setFocused] = useState<{ sessionId: string; projectId: string } | null>(null);

  const emptyPlaceholder = useMemo(
    () => `No chats with ${gezel.name} yet — start one below.`,
    [gezel.name],
  );

  const composerPlaceholder = useMemo(
    () =>
      pickChatPlaceholder({
        role: 'other',
        gezelName: gezel.name,
        gezelGender: gezel.gender,
        projectName: focused ? undefined : 'default',
        fixedFunctionTool: gezel.fixedFunction?.tool,
      }),
    [gezel.name, gezel.gender, focused, gezel.fixedFunction?.tool],
  );

  const composerProjectId = focused?.projectId ?? 'default';

  return (
    <ChatReferences
      projectId={composerProjectId}
      commandsProjectId={composerProjectId === 'default' ? undefined : composerProjectId}
      chatKey={`all:${gezel.id}`}
    >
      {({ onToolActivity, onArtifactReference, onTaskReference }) => (
        <>
          <GezelTimeline
            gezelId={gezel.id}
            activeSessionId={focused?.sessionId}
            onFocusSession={(sid, _gid, pid) => {
              setFocused({ sessionId: sid, projectId: pid });
            }}
            onToolActivity={onToolActivity}
            onArtifactReference={onArtifactReference}
            onTaskReference={onTaskReference}
            emptyPlaceholder={emptyPlaceholder}
          />
          <ChatComposer
            gezelId={gezel.id}
            gezelName={gezel.name}
            gezelIcon={gezel.icon ?? null}
            gezelPoppetje={gezel.poppetje}
            gezelIconOverride={gezel.iconOverride}
            projectId={composerProjectId}
            sessionId={focused?.sessionId}
            onSessionCreated={(sid) => setFocused({ sessionId: sid, projectId: composerProjectId })}
            onToolActivity={onToolActivity}
            placeholder={composerPlaceholder}
          />
        </>
      )}
    </ChatReferences>
  );
}
