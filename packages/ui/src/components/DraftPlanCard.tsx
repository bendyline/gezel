import {
  type Task,
  planGuardrails,
  renderPlanDocument,
  summarizePlanDocument,
} from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { RenderedMarkdown } from './chat-bubbles.js';

/**
 * Inline plan card. Rendered under an assistant bubble for any referenced
 * task that turns out to be a DRAFT (a plan being authored). Shows the plan
 * as a rendered markdown document (about → outcomes → gated steps →
 * verification) with actions to fire it, open for editing, or discard.
 * Self-hides when the referenced task isn't a draft, so non-plan refs fall
 * back to the plain chip rendered alongside it.
 */
export function DraftPlanCard({
  taskRef,
  onOpenTask,
}: {
  taskRef: string;
  /** Open the task tab for deep editing (dispatches gezel:open-tab kind:task). */
  onOpenTask?: (ref: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<'activate' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [outcome, setOutcome] = useState<'activated' | 'discarded' | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    api
      .getTaskByRef(taskRef)
      .then((t) => {
        if (!cancelled) {
          setTask(t);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskRef]);

  useEffect(() => refresh(), [refresh]);

  const activate = useCallback(
    async (force: boolean) => {
      if (!task || busy) return;
      setBusy('activate');
      setError(null);
      try {
        await api.activateTask(task.projectId, task.num, force);
        setOutcome('activated');
      } catch (err) {
        // A guardrail rejection (not forced) → offer "Fire anyway".
        const msg = (err as Error).message ?? 'Failed to activate.';
        if (!force && /not ready to activate/i.test(msg)) {
          setConfirmForce(true);
          setError(msg.replace(/^.*not ready to activate:\s*/i, 'Heads up: '));
        } else {
          setError(msg);
        }
        setBusy(null);
      }
    },
    [task, busy],
  );

  const discard = useCallback(async () => {
    if (!task || busy) return;
    setBusy('discard');
    setError(null);
    try {
      await api.setTaskStatus(task.projectId, task.num, 'canceled');
      setOutcome('discarded');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to discard.');
      setBusy(null);
    }
  }, [task, busy]);

  // Not a draft (or still loading / gone) → render nothing; the plain chip
  // alongside this card carries non-plan refs.
  if (!loaded || !task || (task.status !== 'draft' && !outcome)) return null;

  if (outcome) {
    return (
      <div className="pending-question pending-question-answered draft-plan-card">
        <span className="pending-question-label muted">Plan</span>
        <span className="pending-question-summary">
          {outcome === 'activated' ? (
            <>
              Plan fired — task started.{' '}
              <button
                type="button"
                className="pending-question-context-link linklike"
                onClick={() => onOpenTask?.(taskRef)}
              >
                Open task
              </button>
            </>
          ) : (
            'Plan discarded.'
          )}
        </span>
      </div>
    );
  }

  const summary = summarizePlanDocument(task);
  const guards = planGuardrails(summary);

  return (
    <div className="pending-question pending-question-pending draft-plan-card">
      <div className="pending-question-context-row">
        <span className="muted">Plan · draft</span>
        <span className="pending-question-context-title">{task.title}</span>
        <span className="pending-question-context-status status-draft">draft</span>
      </div>
      <div className="pending-question-document-preview">
        <RenderedMarkdown markdown={renderPlanDocument(task)} />
      </div>
      {guards.length > 0 && (
        <p className="pending-question-error">
          {confirmForce ? 'Fire anyway?' : `Before running: ${guards.join('; ')}.`}
        </p>
      )}
      {error && <p className="pending-question-error">{error}</p>}
      <div className="pending-question-actions">
        <button
          type="button"
          className="pending-question-submit"
          onClick={() => void activate(confirmForce)}
          disabled={busy !== null}
        >
          {busy === 'activate' ? 'Firing…' : confirmForce ? 'Fire anyway' : 'Fire task'}
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => onOpenTask?.(taskRef)}
          disabled={busy !== null}
        >
          Open to edit
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => refresh()}
          disabled={busy !== null}
          title="Re-fetch after the gezel edits the plan."
        >
          Refresh
        </button>
        <button
          type="button"
          className="pending-question-skip subtle"
          onClick={() => void discard()}
          disabled={busy !== null}
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
      </div>
    </div>
  );
}
