import type { CodeReview, CodeReviewKind } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { MarkdownField } from '../MarkdownField.js';
import { CodeReviewStatusCard } from './CodeReviewStatusCard.js';
import { GIT_COPY, friendlyDate, plural, reviewKindWord } from './gitCopy.js';

const noop = () => {};

interface Props {
  projectId: string;
  reviews: CodeReview[];
  busy: '' | 'start-commit' | 'start-pr' | 'cancel';
  changesCount: number;
  branch?: string;
  defaultBranch?: string;
  onStart: (kind: CodeReviewKind) => void;
  onCancel: (reviewId: string) => void;
}

/**
 * The Code review sub-tab: kickoff cards, running-review status, review
 * history, and the finished report rendered inline. Reports live in the
 * artifacts drawer (reviews/<id>/report.md) — this pane reads them via
 * the artifacts API and deep-links into the Artifacts tab for the full
 * editor.
 */
export function CodeReviewView({
  projectId,
  reviews,
  busy,
  changesCount,
  branch,
  defaultBranch,
  onStart,
  onCancel,
}: Props) {
  const running = reviews.filter((r) => r.status === 'running');
  const done = reviews.filter((r) => r.status !== 'running');
  const commitRunning = running.some((r) => r.kind === 'commit');
  const prRunning = running.some((r) => r.kind === 'pr');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => {
    const explicit = done.find((r) => r.id === selectedId);
    return explicit ?? done.find((r) => r.status === 'complete') ?? null;
  }, [done, selectedId]);

  const [report, setReport] = useState<{ id: string; content: string | null } | null>(null);
  useEffect(() => {
    if (!selected || selected.status !== 'complete') {
      setReport(null);
      return;
    }
    let cancelled = false;
    void api
      .readProjectArtifact(projectId, selected.reportPath)
      .then((res) => {
        if (!cancelled) setReport({ id: selected.id, content: res.content });
      })
      .catch(() => {
        if (!cancelled) setReport({ id: selected.id, content: null });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  const prHint = defaultBranch
    ? `Checks everything on ${branch ?? 'this branch'} against ${defaultBranch}.`
    : GIT_COPY.reviewPrHint;

  return (
    <div className="gh-review-layout">
      <div className="gh-review-rail">
        <div className="gh-review-kickoff-row">
          <div className="gh-review-card">
            <button
              type="button"
              onClick={() => onStart('commit')}
              disabled={busy !== '' || commitRunning || changesCount === 0}
            >
              {busy === 'start-commit' ? 'Starting…' : `✨ ${GIT_COPY.reviewCommitButton}`}
            </button>
            <p className="muted small">
              {changesCount === 0 ? GIT_COPY.reviewNothingCommit : GIT_COPY.reviewCommitHint}
            </p>
          </div>
          <div className="gh-review-card">
            <button type="button" onClick={() => onStart('pr')} disabled={busy !== '' || prRunning}>
              {busy === 'start-pr' ? 'Starting…' : `✨ ${GIT_COPY.reviewPrButton}`}
            </button>
            <p className="muted small">{prHint}</p>
          </div>
        </div>

        {running.map((r) => (
          <CodeReviewStatusCard key={r.id} review={r} onCancel={onCancel} disabled={busy !== ''} />
        ))}

        <div className="gh-review-history">
          {done.length === 0 && running.length === 0 && (
            <p className="muted">{GIT_COPY.reviewHistoryEmpty}</p>
          )}
          {done.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`gh-review-history-item${selected?.id === r.id ? ' is-selected' : ''}`}
              onClick={() => setSelectedId(r.id)}
            >
              <span className={`gh-review-outcome-chip gh-review-outcome-${r.status}`}>
                {r.status === 'complete'
                  ? 'Reviewed'
                  : r.status === 'canceled'
                    ? 'Stopped'
                    : 'Issue'}
              </span>
              <span className="gh-review-history-title">
                {reviewKindWord(r.kind)} · {r.branch}
              </span>
              <span className="muted small">
                {plural(r.filesChanged, 'file')} · {friendlyDate(r.settledAt ?? r.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="gh-review-report">
        {selected && selected.status === 'complete' ? (
          report?.id === selected.id ? (
            report.content !== null ? (
              <>
                <div className="gh-review-report-header">
                  <code className="gh-changes-diff-path" title={selected.reportPath}>
                    {selected.reportPath}
                  </code>
                  <button
                    type="button"
                    className="small"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('gezel:open-file', {
                          detail: { projectId, path: selected.reportPath, source: 'artifacts' },
                        }),
                      )
                    }
                  >
                    {GIT_COPY.reviewOpenInArtifacts}
                  </button>
                </div>
                <MarkdownField
                  key={`${selected.id}:${selected.reportPath}`}
                  value={report.content}
                  readOnly
                  onCommit={noop}
                />
              </>
            ) : (
              <p className="muted">{GIT_COPY.reviewReportMissing}</p>
            )
          ) : (
            <p className="muted">{GIT_COPY.reviewReportLoading}</p>
          )
        ) : (
          <p className="placeholder">
            {running.length > 0
              ? 'The report will appear here when the review finishes.'
              : 'Pick a finished review to read its report.'}
          </p>
        )}
      </div>
    </div>
  );
}
