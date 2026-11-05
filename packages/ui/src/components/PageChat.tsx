import {
  type GezelSummary,
  type PageChatOptions,
  displayName,
  roleForMatching,
} from '@bendyline/gezel';
import { memo, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/** Host-owned UI: neither draft text nor transcript crosses into the page. */
export const PageChat = memo(function PageChat({
  projectId,
  options,
}: { projectId: string; options: PageChatOptions }) {
  const [crew, setCrew] = useState<GezelSummary[] | null>(null);
  const [defaultId, setDefaultId] = useState('');
  const [picked, setPicked] = useState<{ scope: string; id: string }>();
  const selectionScope = JSON.stringify([projectId, options.gezelId, options.gezelRole]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getProject(projectId), api.listGezels()])
      .then(([project, roster]) => {
        if (cancelled) return;
        const members = new Set([project.voormanGezelId, ...(project.gezelIds ?? [])]);
        const available = roster.gezels.filter((gezel) => members.has(gezel.id));
        setCrew(available);
        setDefaultId(project.voormanGezelId ?? available[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this project’s crew. Reopen chat to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  if (error) return <output>{error}</output>;
  if (!crew) return <output>Loading chat…</output>;
  const configured = options.gezelId
    ? crew.find((gezel) => gezel.id === options.gezelId)
    : options.gezelRole
      ? crew.find(
          (gezel) => roleForMatching(gezel.role ?? '') === roleForMatching(options.gezelRole ?? ''),
        )
      : crew.find((gezel) => gezel.id === defaultId);
  const locked = options.lockRecipient !== false;
  const recipient =
    (!locked && picked?.scope === selectionScope && crew.find((gezel) => gezel.id === picked.id)) ||
    configured;
  if (!recipient) return <output>The requested gezel is not in this project’s crew.</output>;
  return (
    <PageConversation
      key={`${projectId}:${recipient.id}`}
      projectId={projectId}
      gezel={recipient}
      crew={crew}
      options={options}
      locked={locked}
      onPick={(id) => setPicked({ scope: selectionScope, id })}
    />
  );
});

function PageConversation({
  projectId,
  gezel,
  crew,
  options,
  locked,
  onPick,
}: {
  projectId: string;
  gezel: GezelSummary;
  crew: GezelSummary[];
  options: PageChatOptions;
  locked: boolean;
  onPick: (id: string) => void;
}) {
  const [sessionId, setSessionId] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const [revision, setRevision] = useState(0);
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const name = displayName(gezel, roleBasedNameOnlyMode);
  return (
    <section className="page-chat task-detail-chat" aria-label={`Chat with ${name}`}>
      {options.variant !== 'composer' && (
        <ProjectTimeline
          projectId={projectId}
          gezelId={gezel.id}
          activeSessionId={sessionId}
          onFocusSession={(id, recipient) => {
            if (recipient === gezel.id) {
              setFresh(false);
              setSessionId(id);
            }
          }}
          emptyPlaceholder={`Talk with ${name}.`}
        />
      )}
      <ChatComposer
        gezelId={gezel.id}
        gezelName={gezel.name}
        gezelRole={gezel.role}
        gezelRoleBasedName={gezel.roleBasedName}
        gezelIcon={gezel.icon}
        gezelPoppetje={gezel.poppetje}
        gezelIconOverride={gezel.iconOverride}
        projectId={projectId}
        sessionId={sessionId}
        freshThread={fresh}
        onSessionCreated={(id) => {
          setFresh(false);
          setSessionId(id);
          setRevision((r) => r + 1);
        }}
        placeholder={options.placeholder}
        draftScope="page-chat"
        showAddress={options.showAddress !== false}
        features={{
          attachments: options.attachments === true,
          dictation: options.dictation === true,
          promptAssist: options.promptAssist === true,
          expand: options.expand === true,
          mentions: !locked,
        }}
        recipientGezels={locked ? undefined : crew}
        onPrimaryRecipientChange={locked ? undefined : onPick}
        belowAddressLine={
          options.showThreads !== false ? (
            <SessionSwitcher
              gezelId={gezel.id}
              projectId={projectId}
              sessionId={sessionId}
              onSessionIdChange={setSessionId}
              onFreshThread={() => setFresh(true)}
              refreshKey={revision}
              autoPickNewest={!fresh}
            />
          ) : undefined
        }
      />
    </section>
  );
}
