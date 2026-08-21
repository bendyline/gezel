import type { CodeReview } from '@bendyline/gezel';
import { useState } from 'react';
import { formatAbsoluteTime } from '../../relative-time.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { GIT_COPY, friendlyDate, plural, reviewKindWord } from './gitCopy.js';

interface Props {
  review: CodeReview;
  onCancel: (reviewId: string) => void;
  disabled: boolean;
}

/**
 * One running review: who is on it, how far along the steps are, and a
 * stop affordance. A paused task (gate attempts exhausted) renders as the
 * amber needs-attention state — the Tasks tab carries the deeper detail.
 */
export function CodeReviewStatusCard({ review, onCancel, disabled }: Props) {
  const [confirmStop, setConfirmStop] = useState(false);
  const attention = review.needsAttention === true;
  const who = review.assigneeName ?? 'A reviewer';
  const progress =
    review.stepsTotal && review.stepsTotal > 0
      ? `step ${Math.min((review.stepsComplete ?? 0) + 1, review.stepsTotal)} of ${review.stepsTotal}`
      : undefined;

  return (
    <div
      className={`gh-review-status-card ${attention ? 'gh-review-status-attention' : 'gh-review-status-running'}`}
    >
      <div className="gh-review-status-main">
        <strong>
          {reviewKindWord(review.kind)} · {review.branch}
        </strong>
        <span>
          {attention ? (
            GIT_COPY.reviewNeedsAttention
          ) : (
            <>
              {who} {GIT_COPY.reviewRunning}
            </>
          )}
        </span>
        <span className="muted small" title={formatAbsoluteTime(review.createdAt)}>
          {plural(review.filesChanged, 'file')}
          {progress ? ` · ${progress}` : ''}
          {review.activeStepName ? ` · ${review.activeStepName}` : ''}
          {` · started ${friendlyDate(review.createdAt)}`}
        </span>
      </div>
      <button
        type="button"
        className="gh-review-stop small"
        onClick={() => setConfirmStop(true)}
        disabled={disabled}
      >
        {GIT_COPY.reviewStop}
      </button>
      <ConfirmDialog
        open={confirmStop}
        title={GIT_COPY.reviewStopTitle}
        message={GIT_COPY.reviewStopBody}
        confirmLabel={GIT_COPY.reviewStopConfirm}
        danger
        onConfirm={() => {
          setConfirmStop(false);
          onCancel(review.id);
        }}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
