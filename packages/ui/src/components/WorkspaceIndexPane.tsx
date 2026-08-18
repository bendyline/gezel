import {
  type BoekwachterIssue,
  type BoekwachterIssueDismissalReason,
  type BoekwachterIssueStatus,
  type FileReviewIssue,
  type FileReviewResponse,
  type ListFileIssuesResponse,
  type WorkspaceIndexStatus,
  formatReviewProvenance,
} from '@bendyline/gezel';
import { useState } from 'react';
import { MarkdownField } from './MarkdownField.js';

const noop = () => undefined;

export interface WorkspaceIndexToggleProps {
  open: boolean;
  issueCount: number;
  onToggle: () => void;
}

/**
 * Squisq-toolbar toggle for the workspace's Boekwachter results pane. The
 * small count is scoped to the selected file; workspace-wide issue status
 * remains visible in the tree header even while this pane is closed.
 */
export function WorkspaceIndexToggle({ open, issueCount, onToggle }: WorkspaceIndexToggleProps) {
  const action = open ? 'Hide' : 'Show';
  const issuePhrase =
    issueCount > 0 ? `, ${issueCount} issue${issueCount === 1 ? '' : 's'} in this file` : '';
  const label = `${action} Boekwachter index pane${issuePhrase}`;
  return (
    <button
      type="button"
      className={`squisq-toolbar-button workspace-index-toggle${open ? ' squisq-toolbar-button--active' : ''}`}
      onClick={onToggle}
      aria-label={label}
      title={label}
      aria-pressed={open}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect
          x="2.5"
          y="2"
          width="11"
          height="12"
          rx="1.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2" />
        <line
          x1="8"
          y1="5.25"
          x2="11.5"
          y2="5.25"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="8"
          x2="11.5"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="10.75"
          x2="10.5"
          y2="10.75"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
      {issueCount > 0 && (
        <span className="workspace-index-toggle-count" aria-hidden="true">
          {issueCount}
        </span>
      )}
    </button>
  );
}

export interface WorkspaceIndexPaneProps {
  path: string | null;
  status: WorkspaceIndexStatus | null;
  issues: ListFileIssuesResponse | null;
  review: FileReviewResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectLine?: (line: number) => void;
  onFixIssue?: (issue: BoekwachterIssue) => void;
  onUpdateIssue?: (
    issue: BoekwachterIssue,
    patch: {
      status?: BoekwachterIssueStatus;
      seen?: boolean;
      dismissalReason?: BoekwachterIssueDismissalReason;
    },
  ) => void | Promise<void>;
  onOpenTask?: (taskRef: string) => void;
}

/** Selected-file results from the background Boekwachter review pass. */
export function WorkspaceIndexPane({
  path,
  status,
  issues,
  review,
  loading,
  error,
  onClose,
  onSelectLine,
  onFixIssue,
  onUpdateIssue,
  onOpenTask,
}: WorkspaceIndexPaneProps) {
  const [showClosed, setShowClosed] = useState(false);
  const [issueAction, setIssueAction] = useState<string | null>(null);
  const [issueActionError, setIssueActionError] = useState<string | null>(null);
  const fileName = path ? (path.split('/').pop() ?? path) : null;
  const fileIssueCount = path
    ? (issues?.issues.filter((issue) => issue.path === path).length ?? 0)
    : 0;
  const result = review?.review;
  const trackedIssues = review?.trackedIssues ?? [];
  const legacyIssues = trackedIssues.length === 0 ? (result?.issues ?? []) : [];
  const visibleTrackedIssues = trackedIssues.filter(
    (issue) => showClosed || issue.status === 'open' || issue.status === 'in_progress',
  );
  const provenance = result ? formatReviewProvenance(result) : null;
  const indexLabel = workspaceIndexLabel(status);
  const coverage = issues
    ? `${issues.reviewedFiles} of ${issues.eligibleFiles} eligible files reviewed`
    : null;
  const runIssueAction = async (
    issue: BoekwachterIssue,
    action: string,
    patch: Parameters<NonNullable<WorkspaceIndexPaneProps['onUpdateIssue']>>[1],
  ) => {
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
  };

  return (
    <aside className="workspace-index-pane" aria-label="Boekwachter index results">
      <header className="workspace-index-pane-header">
        <div className="workspace-index-pane-title">
          <span className="workspace-index-pane-eyebrow">Boekwachter</span>
          <h2 title={path ?? undefined}>{fileName ?? 'Index results'}</h2>
        </div>
        <button
          type="button"
          className="workspace-index-pane-close"
          onClick={onClose}
          aria-label="Close Boekwachter index pane"
          title="Close index pane"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
            <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
          </svg>
        </button>
      </header>

      <div className="workspace-index-pane-summary">
        <span className={`workspace-index-state workspace-index-state-${indexTone(status)}`}>
          <span aria-hidden="true" />
          {indexLabel}
        </span>
        {issues && issues.counts.total > 0 && (
          <span className="workspace-index-total-issues">
            {issues.counts.total} workspace issue{issues.counts.total === 1 ? '' : 's'}
          </span>
        )}
        {coverage && <span className="workspace-index-coverage">{coverage}</span>}
      </div>

      <div className="workspace-index-pane-body">
        {error ? (
          <p className="workspace-index-pane-message error" role="alert">
            Couldn’t load the Boekwachter results: {error}
          </p>
        ) : !path ? (
          <p className="workspace-index-pane-message">Select a workspace file to see its review.</p>
        ) : loading ? (
          <p className="workspace-index-pane-message">Opening the Boekwachter’s notes…</p>
        ) : result || trackedIssues.length > 0 ? (
          <>
            {result && (
              <section
                className="workspace-index-health"
                aria-label={`File health ${result.health} out of 10`}
              >
                <span className="workspace-index-health-score">
                  {result.health}
                  <small>/10</small>
                </span>
                <div>
                  <h3>File health</h3>
                  <p>{result.healthReason}</p>
                </div>
              </section>
            )}

            {result?.notesMd && (
              <section className="workspace-index-notes">
                <h3>Notes</h3>
                <MarkdownField
                  key={`${path}:boekwachter-notes`}
                  value={result.notesMd}
                  readOnly
                  minHeight="0"
                  maxHeight="none"
                  onCommit={noop}
                />
              </section>
            )}

            <section className="workspace-index-issues">
              <h3>
                Issues <span>{trackedIssues.length || legacyIssues.length}</span>
              </h3>
              {trackedIssues.some(
                (issue) => issue.status === 'resolved' || issue.status === 'dismissed',
              ) && (
                <button
                  type="button"
                  className="link-button workspace-index-show-closed"
                  onClick={() => setShowClosed((shown) => !shown)}
                >
                  {showClosed ? 'Hide closed' : 'Show closed'}
                </button>
              )}
              {visibleTrackedIssues.length > 0 || legacyIssues.length > 0 ? (
                <ul>
                  {visibleTrackedIssues.map((issue) => {
                    const line = issue.line;
                    const location =
                      line == null
                        ? null
                        : issue.stale
                          ? `Previously line ${line}`
                          : `Line ${line}`;
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
                      <li key={issue.id} data-status={issue.status}>
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
                                disabled={issueAction !== null}
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
                                  disabled={issueAction !== null}
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
                                  disabled={issueAction !== null}
                                  onClick={() =>
                                    void runIssueAction(issue, 'resolve', {
                                      status: 'resolved',
                                      seen: true,
                                    })
                                  }
                                />
                              </>
                            )}
                            {onUpdateIssue &&
                              (issue.status === 'resolved' || issue.status === 'dismissed') && (
                                <IssueActionKey
                                  icon="fa-rotate-left"
                                  label="Reopen"
                                  disabled={issueAction !== null}
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
                  })}
                  {legacyIssues.map((issue, index) => (
                    <LegacyReviewIssue
                      key={`${issue.category}:${issue.message}:${index}`}
                      issue={issue}
                      fileName={fileName}
                      onSelectLine={onSelectLine}
                    />
                  ))}
                </ul>
              ) : (
                <p className="workspace-index-clean-result">
                  {trackedIssues.length > 0
                    ? 'No open issues in this file.'
                    : 'No issues found in this file.'}
                </p>
              )}
              {issueActionError && (
                <p className="workspace-index-issue-error error" role="alert">
                  Couldn’t update the issue: {issueActionError}
                </p>
              )}
            </section>

            <footer className="workspace-index-pane-footer">
              <p>Leads from a background model pass — its opinion, not a verdict.</p>
              {provenance && <p>{provenance}</p>}
            </footer>
          </>
        ) : review?.pending ? (
          <p className="workspace-index-pane-message">
            Not reviewed yet. The Boekwachter studies files while the app is idle or during Night
            Shift.
          </p>
        ) : (
          <p className="workspace-index-pane-message">
            {fileIssueCount > 0
              ? `${fileIssueCount} indexed issue${fileIssueCount === 1 ? '' : 's'} found, but the full review is not available yet.`
              : 'No Boekwachter review is available for this file yet.'}
          </p>
        )}
      </div>
    </aside>
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

function issueStatusLabel(status: BoekwachterIssueStatus): string {
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

function LegacyReviewIssue({
  issue,
  fileName,
  onSelectLine,
}: {
  issue: FileReviewIssue;
  fileName: string | null;
  onSelectLine?: (line: number) => void;
}) {
  const content = (
    <>
      <div className="workspace-index-issue-meta">
        <span>{issue.severity}</span>
        <span>{issue.category}</span>
        {issue.line != null && <span>Line {issue.line}</span>}
      </div>
      <p>{issue.message}</p>
    </>
  );
  return (
    <li>
      {issue.line != null && onSelectLine ? (
        <button
          type="button"
          className="workspace-index-issue-content workspace-index-issue-selectable"
          onClick={() => onSelectLine(issue.line!)}
          title={`Select line ${issue.line} in ${fileName ?? 'the source file'}`}
        >
          {content}
        </button>
      ) : (
        <div className="workspace-index-issue-content">{content}</div>
      )}
    </li>
  );
}

export function workspaceIndexLabel(status: WorkspaceIndexStatus | null): string {
  if (!status) return 'Checking index';
  switch (status.state) {
    case 'fresh':
      return status.aiScanPending ? 'AI index in progress' : 'Index ready';
    case 'indexing':
      return 'Indexing workspace';
    case 'stale':
      return 'Index out of date';
    case 'never':
      return 'Not indexed';
    case 'disabled':
      return 'Indexing off';
  }
}

export function indexTone(
  status: WorkspaceIndexStatus | null,
): 'checking' | 'fresh' | 'indexing' | 'stale' | 'disabled' {
  if (!status) return 'checking';
  if (status.state === 'disabled') return 'disabled';
  if (status.state === 'indexing') return 'indexing';
  if (status.state === 'fresh') return status.aiScanPending ? 'indexing' : 'fresh';
  return 'stale';
}
