import type { Question, WorkspaceWritePermissionIntent } from '@bendyline/gezel';
import { MANAGED_WORKSPACE_WRITE_SETTING_LABEL } from '@bendyline/gezel';
import type { ReactNode } from 'react';
import { api } from '../api.js';
import { RenderedMarkdown } from './chat-bubbles.js';
import { useQuestionDraft } from './question-drafts.js';
import '../styles/workspace-permission.css';

export function PermissionIcon() {
  return (
    <svg
      className="workspace-permission-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M12 3 4.5 6v5.5c0 4.2 3.2 7.7 7.5 9.5 4.3-1.8 7.5-5.3 7.5-9.5V6L12 3Z" />
      <path d="m8.5 12 2.3 2.3 4.7-4.6" />
    </svg>
  );
}

export function WorkspacePermissionForm({
  question,
  intent,
  onAnswered,
  context,
  actions,
}: {
  question: Question;
  intent: WorkspaceWritePermissionIntent;
  onAnswered?: (question: Question) => void;
  context: ReactNode;
  actions: (busy: boolean, onError: (error: string | null) => void) => ReactNode;
}) {
  const [submitting, setSubmitting] = useQuestionDraft<number | null>(
    question.id,
    'submitting',
    () => null,
  );
  const [error, setError] = useQuestionDraft<string | null>(question.id, 'error', () => null);
  async function submit(choice: number) {
    if (submitting !== null) return;
    setSubmitting(choice);
    setError(null);
    try {
      const updated = await api.answerQuestion(question.id, { selectedChoices: [choice] });
      onAnswered?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update permissions.');
      setSubmitting(null);
    }
  }
  return (
    <div className="pending-question pending-question-pending workspace-permission">
      {context}
      <div className="workspace-permission-heading">
        <PermissionIcon />
        <strong>Permission request</strong>
      </div>
      <div className="pending-question-prompt">
        <RenderedMarkdown markdown={question.prompt} />
      </div>
      <dl className="workspace-permission-scope">
        <dt>Permission</dt>
        <dd>Create, edit, rename and delete project files</dd>
        <dt>Project</dt>
        <dd>{intent.projectName}</dd>
        <dt>Folder</dt>
        <dd>
          <code>{intent.workspaceDir}</code>
        </dd>
        {intent.realWorkspaceDir !== intent.workspaceDir && (
          <>
            <dt>Resolves to</dt>
            <dd>
              <code>{intent.realWorkspaceDir}</code>
            </dd>
          </>
        )}
        <dt>Applies to</dt>
        <dd>
          All gezels using built-in tools, scripts and background work, throughout this folder and
          its subfolders
        </dd>
        <dt>Duration</dt>
        <dd>Until revoked, including future tasks</dd>
        <dt>Revoke in</dt>
        <dd>Project → Settings → {MANAGED_WORKSPACE_WRITE_SETTING_LABEL}</dd>
      </dl>
      <p className="workspace-permission-note">
        This grants access to the whole project folder. It does not change operating-system, shell
        or external-tool permissions.
      </p>
      {error && (
        <p className="pending-question-error" role="alert">
          {error}
        </p>
      )}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          disabled={submitting !== null}
          onClick={() => void submit(0)}
        >
          <PermissionIcon />
          {submitting === 0 ? 'Allowing…' : 'Allow project file edits and continue'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          disabled={submitting !== null}
          onClick={() => void submit(1)}
        >
          {submitting === 1 ? 'Keeping permissions…' : 'Keep current permissions'}
        </button>
        {actions(submitting !== null, setError)}
      </div>
    </div>
  );
}
