import type { NightShiftReviewResponse } from '@bendyline/gezel';
import { ReportDocument } from '../../components/ReportDocument.js';
import { openProjectViewActions, runNavActions } from '../../components/nav-actions.js';
import { formatAbsoluteTime } from '../../relative-time.js';
import { NightReviewSummary } from './NightReviewSummary.js';
import { timeAgo } from './utils.js';

/**
 * The Home "Night shift" tab — what the most recent night window
 * accomplished. The primary report (most actionable first, per the
 * review's sort) renders inline with live gezel-action cards; the rest
 * are rows that open their project.
 */
/**
 * A night report read in place, with its suggested actions live. Shared by
 * the night summary and the unanswered morning review.
 */
export function NightPrimaryReport({
  primary,
}: {
  primary: NightShiftReviewResponse['reports'][number] | undefined;
}) {
  if (!primary) return null;
  return (
    <div className="home-workshop-status-body">
      <ReportDocument
        projectId={primary.projectId}
        path={primary.path}
        onOpenPath={(path) =>
          runNavActions(openProjectViewActions({ projectId: primary.projectId, path }))
        }
      />
    </div>
  );
}

export function NightReviewPanel({ review }: { review: NightShiftReviewResponse }) {
  const primary = review.reports[0];
  const rest = review.reports.slice(1);
  const actionTotal = review.reports.reduce((n, r) => n + r.actionCounts.suggested, 0);
  const proposals = review.diffpacks;

  return (
    <div className="home-workshop-status-report" data-testid="night-review-panel">
      <NightReviewSummary
        completed={review.tasksCompleted.length}
        reports={review.reports.length}
        proposals={proposals.length}
        actions={actionTotal}
      />
      {/* Proposals lead the panel: they are the part of the night that is
          waiting on a decision rather than on being read. */}
      {proposals.length > 0 && (
        <div className="home-workshop-night-reports">
          {proposals.map((pack) => (
            <button
              key={`${pack.projectId}:${pack.packId}`}
              type="button"
              className="home-workshop-night-report-row"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('gezel:open-tab', {
                    detail: { kind: 'project', id: pack.projectId, activate: true },
                  }),
                )
              }
            >
              <span className="home-workshop-night-report-title">{pack.title}</span>
              <span className="muted small">
                {pack.projectName} · {pack.fileCount} file{pack.fileCount === 1 ? '' : 's'} · +
                {pack.additions} −{pack.deletions}
                {pack.drifted ? ' · out of date' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <NightPrimaryReport primary={primary} />
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
        <span className="home-workshop-status-meta" title={formatAbsoluteTime(review.windowEnd)}>
          Night window ended {timeAgo(review.windowEnd)}
        </span>
      </div>
    </div>
  );
}
