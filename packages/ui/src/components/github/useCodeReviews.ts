import type { CodeReview, CodeReviewKind } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { GIT_COPY } from './gitCopy.js';
import { GIT_CHANGED_EVENT } from './useGitSync.js';

/**
 * Owns the review list for one project: fetch + poll (fast while a
 * review is running, slow otherwise), kickoff, and cancel. Server error
 * codes map to the warm copy in gitCopy so callers just toast `message`.
 */

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

function errorCopy(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('REVIEW_IN_PROGRESS')) return GIT_COPY.reviewAlreadyRunning;
  if (message.includes('NO_DEFAULT_BRANCH')) return GIT_COPY.reviewNoDefaultBranch;
  if (message.includes('DETACHED_HEAD')) return GIT_COPY.reviewDetachedHead;
  return message;
}

export function useCodeReviews(
  projectId: string,
  showToast: (kind: 'ok' | 'err', text: string) => void,
) {
  const [reviews, setReviews] = useState<CodeReview[]>([]);
  const [busy, setBusy] = useState<'' | 'start-commit' | 'start-pr' | 'cancel'>('');
  const reviewsRef = useRef(reviews);
  reviewsRef.current = reviews;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listProjectCodeReviews(projectId);
      setReviews(res.reviews);
    } catch {
      // Best-effort: the list keeps its last good state.
    }
  }, [projectId]);

  // Mount + adaptive cadence + cross-surface invalidation events. The
  // interval re-arms whenever the running set flips between empty and not.
  const anyRunning = reviews.some((r) => r.status === 'running');
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      anyRunning ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) void refresh();
    };
    window.addEventListener(GIT_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(GIT_CHANGED_EVENT, onChanged);
    };
  }, [refresh, projectId, anyRunning]);

  const start = useCallback(
    async (kind: CodeReviewKind): Promise<boolean> => {
      setBusy(kind === 'commit' ? 'start-commit' : 'start-pr');
      try {
        const res = await api.startProjectCodeReview(projectId, { kind });
        setReviews((prev) => [res.review, ...prev.filter((r) => r.id !== res.review.id)]);
        showToast('ok', GIT_COPY.reviewStartedToast);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NOTHING_TO_REVIEW')) {
          showToast(
            'err',
            kind === 'commit' ? GIT_COPY.reviewNothingCommit : GIT_COPY.reviewNothingPr,
          );
        } else {
          showToast('err', errorCopy(err));
        }
        return false;
      } finally {
        setBusy('');
      }
    },
    [projectId, showToast],
  );

  const cancel = useCallback(
    async (reviewId: string) => {
      setBusy('cancel');
      try {
        const res = await api.cancelProjectCodeReview(projectId, reviewId);
        setReviews((prev) => prev.map((r) => (r.id === res.review.id ? res.review : r)));
        showToast('ok', GIT_COPY.reviewCanceledToast);
      } catch (err) {
        showToast('err', errorCopy(err));
      } finally {
        setBusy('');
      }
    },
    [projectId, showToast],
  );

  return {
    reviews,
    running: reviews.filter((r) => r.status === 'running'),
    start,
    cancel,
    busy,
    refresh,
  };
}
