import type { NightShiftReviewResponse } from '@bendyline/gezel';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { gezelChatTheme } from '../../components/chat-theme.js';
import { makeReportActionFenceRenderers } from '../../components/report-actions/ReportActionFence.js';
import { timeAgo } from './utils.js';

/**
 * The Home "Last night" tab — what the most recent night window
 * accomplished. The primary report (most actionable first, per the
 * review's sort) renders inline with live gezel-action cards; the rest
 * are rows that open their project.
 */
export function NightReviewPanel({ review }: { review: NightShiftReviewResponse }) {
  const primary = review.reports[0];
  const rest = review.reports.slice(1);
  const [primaryContent, setPrimaryContent] = useState<string | null>(null);
  const [primaryError, setPrimaryError] = useState<string | null>(null);

  useEffect(() => {
    setPrimaryContent(null);
    setPrimaryError(null);
    if (!primary) return;
    let cancelled = false;
    api
      .readProjectArtifact(primary.projectId, primary.path)
      .then((res) => {
        if (!cancelled) setPrimaryContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setPrimaryError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [primary]);

  const primaryDoc = useMemo(() => {
    if (primaryContent === null) return null;
    try {
      return markdownToDoc(parseMarkdown(primaryContent), { articleId: 'night-review' });
    } catch {
      return null;
    }
  }, [primaryContent]);

  const fenceRenderers = useMemo(
    () =>
      primary
        ? makeReportActionFenceRenderers({
            projectId: primary.projectId,
            reportPath: primary.path,
          })
        : undefined,
    [primary],
  );

  const actionTotal = review.reports.reduce((n, r) => n + r.actionCounts.suggested, 0);

  return (
    <div className="home-workshop-status-report" role="tabpanel" data-testid="night-review-panel">
      <p className="home-workshop-night-summary">
        {review.tasksCompleted.length} task{review.tasksCompleted.length === 1 ? '' : 's'} finished
        overnight, {review.reports.length} report{review.reports.length === 1 ? '' : 's'} written
        {actionTotal > 0
          ? ` — ${actionTotal} suggested action${actionTotal === 1 ? '' : 's'} to review.`
          : '.'}
      </p>
      {primary && (
        <div className="home-workshop-status-body">
          {primaryDoc ? (
            <LinearDocView
              doc={primaryDoc}
              theme={gezelChatTheme}
              thinMargins
              imageDisplayMode="thumbnail"
              fenceRenderers={fenceRenderers}
            />
          ) : primaryError ? (
            <p className="error small">{primaryError}</p>
          ) : (
            <p className="muted small">Loading {primary.title}…</p>
          )}
        </div>
      )}
      {rest.length > 0 && (
        <div className="home-workshop-night-reports">
          {rest.map((r) => (
            <button
              key={`${r.projectId}:${r.path}`}
              type="button"
              className="home-workshop-night-report-row"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('gezel:open-tab', {
                    detail: { kind: 'project', id: r.projectId, activate: true },
                  }),
                )
              }
            >
              <span className="home-workshop-night-report-title">{r.title}</span>
              <span className="muted small">
                {r.projectName}
                {r.actionCounts.suggested > 0
                  ? ` · ${r.actionCounts.suggested} action${r.actionCounts.suggested === 1 ? '' : 's'} to review`
                  : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="home-workshop-status-foot">
        <span className="home-workshop-status-meta">
          Night window ended {timeAgo(review.windowEnd)}
        </span>
      </div>
    </div>
  );
}
