import {
  type GezelSummary,
  type SessionSubject,
  appSubjectNoun,
  displayName,
} from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ChatComposer } from '../components/ChatComposer.js';
import { ProjectChatPlaceholder } from '../components/ProjectChatPlaceholder.js';
import { ProjectTimeline } from '../components/ProjectTimeline.js';
import { SessionSwitcher } from '../components/SessionSwitcher.js';
import { useRoleBasedNameOnlyMode } from '../components/useRoleBasedNameOnlyMode.js';
import './DocumentChat.css';

/**
 * One conversation about one document — what the Office pane shows instead
 * of the whole project. The timeline, the thread picker and the composer are
 * all scoped to the document's threads (`subjectKeys`), so a chat beside a
 * Word file shows that file's conversations and nothing else from the
 * project: no task threads, no other gezels' chats, no project tabs. New
 * threads are stamped with the document as they are created. The project is
 * one key away, for when the person wants the rest of it.
 *
 * The gezel is chosen by the host (the pane's header), not here: this view
 * talks to exactly the one gezel the host offered its document tools to.
 */
export function DocumentChat({
  projectId,
  gezelId,
  subject,
  subjectKeys,
  onShowProject,
}: {
  projectId: string;
  gezelId: string;
  subject: SessionSubject;
  subjectKeys: readonly string[];
  onShowProject: () => void;
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [gezels, setGezels] = useState<GezelSummary[] | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [freshThreadChosen, setFreshThreadChosen] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [focusRequestKey, setFocusRequestKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listGezels()
      .then((r) => {
        if (!cancelled) setGezels(r.gezels);
      })
      .catch(() => {
        if (!cancelled) setGezels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Another gezel, or this document saved under a new name: a different
  // conversation, picked afresh from that scope's threads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: gezel and document key are the deliberate reset triggers.
  useEffect(() => {
    setSessionId('');
    setFreshThreadChosen(false);
    setDraftId('');
  }, [gezelId, subject.key]);

  if (gezels === null) return <ProjectChatPlaceholder />;
  const gezel = gezels.find((g) => g.id === gezelId);
  const noun = appSubjectNoun(subject.kind);
  if (!gezel) {
    return (
      <p className="muted document-chat-missing">
        The gezel this {noun} was talking to is no longer available. Choose another one above.
      </p>
    );
  }
  const name = displayName(gezel, roleBasedNameOnlyMode);

  return (
    <div className="document-chat">
      <header className="document-chat-header">
        <span className="document-chat-title">{subject.title}</span>
        <button type="button" className="secondary document-chat-project" onClick={onShowProject}>
          Show project
        </button>
      </header>
      <div className="task-detail-chat document-chat-body">
        <ProjectTimeline
          projectId={projectId}
          subjectKeys={subjectKeys}
          activeSessionId={sessionId || undefined}
          onFocusSession={(sid, gid) => {
            if (gid !== gezel.id) return;
            setFreshThreadChosen(false);
            setSessionId(sid);
          }}
          emptyPlaceholder={`Ask ${name} to write, rewrite, or explain something in this ${noun}.`}
        />
        <ChatComposer
          gezelId={gezel.id}
          gezelName={gezel.name}
          gezelRoleBasedName={gezel.roleBasedName}
          gezelRole={gezel.role}
          gezelIcon={gezel.icon ?? null}
          gezelPoppetje={gezel.poppetje}
          gezelIconOverride={gezel.iconOverride}
          projectId={projectId}
          sessionId={sessionId || undefined}
          freshThread={freshThreadChosen}
          focusRequestKey={focusRequestKey}
          subject={subject}
          subjectKeys={subjectKeys}
          onSessionCreated={(sid) => {
            setFreshThreadChosen(false);
            setSessionId(sid);
            setSessionRefreshKey((k) => k + 1);
          }}
          placeholder={`Talk with ${name} about this ${noun}.`}
          draftScope={`document:${subject.key}`}
          draftId={draftId || undefined}
          onDraftIdChange={(next) => setDraftId(next ?? '')}
          belowAddressLine={
            <SessionSwitcher
              gezelId={gezel.id}
              projectId={projectId}
              sessionId={sessionId || undefined}
              subjectKeys={subjectKeys}
              onSessionIdChange={(next) => {
                if (next) setFreshThreadChosen(false);
                setSessionId(next ?? '');
              }}
              onFreshThread={() => {
                setFreshThreadChosen(true);
                setFocusRequestKey((k) => k + 1);
              }}
              refreshKey={sessionRefreshKey}
              activeDraftId={draftId || undefined}
              onDraftSelect={(next) => setDraftId(next ?? '')}
              draftScope={`document:${subject.key}`}
              autoPickNewest={!freshThreadChosen}
            />
          }
        />
      </div>
    </div>
  );
}
