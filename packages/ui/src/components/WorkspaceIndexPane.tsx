import {
  type FileReviewResponse,
  type ListFileIssuesResponse,
  type WorkspaceIndexStatus,
  formatReviewProvenance,
} from '@bendyline/gezel';
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
}: WorkspaceIndexPaneProps) {
  const fileName = path ? (path.split('/').pop() ?? path) : null;
  const fileIssueCount = path
    ? (issues?.issues.filter((issue) => issue.path === path).length ?? 0)
    : 0;
  const result = review?.review;
  const provenance = result ? formatReviewProvenance(result) : null;
  const indexLabel = workspaceIndexLabel(status);
  const coverage = issues
    ? `${issues.reviewedFiles} of ${issues.eligibleFiles} eligible files reviewed`
    : null;

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
        ) : result ? (
          <>
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

            {result.notesMd && (
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
                Issues <span>{result.issues.length}</span>
              </h3>
              {result.issues.length > 0 ? (
                <ul>
                  {result.issues.map((issue, index) => (
                    <li key={`${issue.category}:${issue.message}:${index}`}>
                      <div className="workspace-index-issue-meta">
                        <span>{issue.severity}</span>
                        <span>{issue.category}</span>
                        {issue.line != null && <span>Line {issue.line}</span>}
                      </div>
                      <p>{issue.message}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workspace-index-clean-result">No issues found in this file.</p>
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
