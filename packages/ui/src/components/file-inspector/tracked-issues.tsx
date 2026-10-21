import type {
  BoekwachterIssue,
  BoekwachterIssueDismissalReason,
  BoekwachterIssueStatus,
} from '@bendyline/gezel';
import { useCallback, useState } from 'react';

export interface BoekwachterIssuePatch {
  status?: BoekwachterIssueStatus;
  seen?: boolean;
  dismissalReason?: BoekwachterIssueDismissalReason;
}

export type UpdateBoekwachterIssue = (
  issue: BoekwachterIssue,
  patch: BoekwachterIssuePatch,
) => void | Promise<void>;

/**
 * Fired on `window` after a Boekwachter issue changes from any surface (an
 * issue row, the Fix dialog), so every open pane showing that file's review
 * refetches instead of showing the old status.
 */
export const BOEKWACHTER_ISSUES_CHANGED_EVENT = 'gezel:boekwachter-issues-changed';

export function announceBoekwachterIssuesChanged(projectId: string): void {
  window.dispatchEvent(
    new CustomEvent(BOEKWACHTER_ISSUES_CHANGED_EVENT, { detail: { projectId } }),
  );
}

/** One action at a time across a review's issue rows, with its error kept for display. */
export function useIssueActions(onUpdateIssue?: UpdateBoekwachterIssue) {
  const [issueAction, setIssueAction] = useState<string | null>(null);
  const [issueActionError, setIssueActionError] = useState<string | null>(null);
  const runIssueAction = useCallback(
    async (issue: BoekwachterIssue, action: string, patch: BoekwachterIssuePatch) => {
      if (!onUpdateIssue || issueAction) return;
      setIssueAction(`${issue.ref}:${action}`);
      setIssueActionError(null);
      try {
        await onUpdateIssue(issue, patch);
      } catch (reason) {
        setIssueActionError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setIssueAction(null);
      }
    },
    [issueAction, onUpdateIssue],
  );
  return { issueAction, issueActionError, runIssueAction };
}

/**
 * A durable Boekwachter issue row (`BW-12`): what it says, where it was, and
 * its lifecycle keys — read/unread, not an issue, resolve, reopen, Fix. A row
 * whose file changed since the review reads "Previously line N" and "Needs
 * recheck" rather than pretending the location is still exact.
 */
export function TrackedIssueItem({
  issue,
  fileName,
  busy,
  onSelectLine,
  onUpdateIssue,
  onFixIssue,
  onOpenTask,
  runIssueAction,
}: {
  issue: BoekwachterIssue;
  fileName: string | null;
  busy: boolean;
  onSelectLine?: (line: number) => void;
  onUpdateIssue?: UpdateBoekwachterIssue;
  onFixIssue?: (issue: BoekwachterIssue) => void;
  onOpenTask?: (taskRef: string) => void;
  runIssueAction: (
    issue: BoekwachterIssue,
    action: string,
    patch: BoekwachterIssuePatch,
  ) => Promise<void>;
}) {
  const line = issue.line;
  const location = line == null ? null : issue.stale ? `Previously line ${line}` : `Line ${line}`;
  const content = (
    <>
      <div className="workspace-index-issue-meta">
        {!issue.seen && (
          <span className="workspace-index-issue-unread" title="Unread issue">
            New
          </span>
        )}
        <span className="workspace-index-issue-ref">{issue.ref}</span>
        <span>{issue.severity}</span>
        <span>{issue.category}</span>
        {location && <span>{location}</span>}
        {issue.stale && <span>Needs recheck</span>}
        {issue.status !== 'open' && <span>{issueStatusLabel(issue.status)}</span>}
      </div>
      <p>{issue.message}</p>
    </>
  );
  return (
    <li data-status={issue.status}>
      {line != null && onSelectLine ? (
        <button
          type="button"
          className="workspace-index-issue-content workspace-index-issue-selectable"
          onClick={() => {
            onSelectLine(line);
            if (!issue.seen) void runIssueAction(issue, 'read', { seen: true });
          }}
          title={`${issue.stale ? 'Reveal the previous line' : 'Select line'} ${line} in ${fileName ?? 'the source file'}`}
        >
          {content}
        </button>
      ) : (
        <div className="workspace-index-issue-content">{content}</div>
      )}
      <div className="workspace-index-issue-actions">
        {issue.taskRef && issue.status === 'in_progress' && (
          <button
            type="button"
            className="link-button workspace-index-issue-task"
            onClick={() => onOpenTask?.(issue.taskRef!)}
          >
            Working · {issue.taskRef}
          </button>
        )}
        {/* The toolbar carries the issue's ref so a screen reader can
            tell one row's icon keys from the next one's, which lets
            the keys themselves keep short action labels. */}
        <div
          className="gz-tray workspace-index-issue-tray"
          role="toolbar"
          aria-label={`Actions for ${issue.ref}`}
        >
          {onUpdateIssue && (
            <IssueActionKey
              icon={issue.seen ? 'fa-envelope' : 'fa-envelope-open'}
              label={issue.seen ? 'Mark unread' : 'Mark read'}
              disabled={busy}
              onClick={() =>
                void runIssueAction(issue, issue.seen ? 'unread' : 'read', {
                  seen: !issue.seen,
                })
              }
            />
          )}
          {onUpdateIssue && issue.status === 'open' && (
            <>
              <IssueActionKey
                icon="fa-ban"
                label="Not an issue"
                disabled={busy}
                onClick={() =>
                  void runIssueAction(issue, 'dismiss', {
                    status: 'dismissed',
                    seen: true,
                    dismissalReason: 'not_an_issue',
                  })
                }
              />
              <IssueActionKey
                icon="fa-check"
                label="Mark resolved"
                disabled={busy}
                onClick={() =>
                  void runIssueAction(issue, 'resolve', {
                    status: 'resolved',
                    seen: true,
                  })
                }
              />
            </>
          )}
          {onUpdateIssue && (issue.status === 'resolved' || issue.status === 'dismissed') && (
            <IssueActionKey
              icon="fa-rotate-left"
              label="Reopen"
              disabled={busy}
              onClick={() =>
                void runIssueAction(issue, 'reopen', {
                  status: 'open',
                  seen: true,
                })
              }
            />
          )}
          {onFixIssue && issue.status === 'open' && (
            <IssueActionKey
              icon="fa-wrench"
              label="Fix"
              title={`Create a tracked task for ${issue.ref}`}
              className="workspace-index-issue-fix"
              onClick={() => onFixIssue(issue)}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * One key in an issue row's action toolbar. Icon-only, so the label is the
 * accessible name and — unless the action needs a longer explanation — the
 * tooltip too (docs/ux.md → "Controls: keys in trays").
 */
function IssueActionKey({
  icon,
  label,
  title,
  className,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`gz-key gz-key--icon workspace-index-issue-key${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
      <i className={`fa-solid ${icon}`} aria-hidden="true" />
    </button>
  );
}

export function issueStatusLabel(status: BoekwachterIssueStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'resolved':
      return 'Resolved';
    case 'dismissed':
      return 'Not an issue';
    default:
      return 'Open';
  }
}

/** Whether a tracked issue still asks for attention (shown unless "Show closed"). */
export function isOpenIssue(issue: BoekwachterIssue): boolean {
  return issue.status === 'open' || issue.status === 'in_progress';
}
