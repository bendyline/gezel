import {
  type Task,
  type TaskCraftbookStep,
  taskActiveAssignee,
  taskEffectiveStatus,
} from '@bendyline/gezel';
import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { RenderedMarkdown } from './chat-bubbles.js';
import { useQuestionDraft } from './question-drafts.js';

/** Older tasks can reach a human step without having a persisted question card. */
export function ActivityTaskStep({
  taskRef,
  snapshotAt,
  onContinued,
}: {
  taskRef: string;
  snapshotAt: string;
  onContinued: () => void;
}) {
  const statusId = useId();
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Snapshot updates and retries reload the current step without discarding its draft.
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api.getTaskByRef(taskRef, controller.signal).then(
      (current) => {
        if (!controller.signal.aborted) setTask(current);
      },
      (err: unknown) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : 'Could not load the current step.');
      },
    );
    return () => controller.abort();
  }, [taskRef, snapshotAt, retry]);
  if (error)
    return (
      <div>
        <p role="alert">{error}</p>
        <button
          type="button"
          className="btn secondary"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  if (!task) return <p>Loading the current step…</p>;
  if (task.status === 'paused' || task.status === 'canceled')
    return (
      <output id={statusId} tabIndex={-1}>
        {task.status === 'paused'
          ? 'Task paused. You can resume it later.'
          : 'Task canceled. Its notes and files are kept.'}
      </output>
    );
  const step = task.craftbook.steps.find((candidate) => candidate.id === task.activeStepId);
  if (!step || taskEffectiveStatus(task) !== 'active' || taskActiveAssignee(task).kind !== 'user')
    return (
      <div>
        <p>This task has changed. Refresh to see its current step.</p>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setRetry((value) => value + 1);
            onContinued();
          }}
        >
          Refresh activity
        </button>
      </div>
    );
  const draftId = `task-step:${task.ref}:${step.id}:${step.lastActivatedAt ?? step.attemptCount ?? ''}`;
  return (
    <DirectionForm
      key={draftId}
      draftId={draftId}
      task={task}
      step={step}
      onContinued={onContinued}
      onStopped={(updated) => {
        setTask(updated);
        onContinued();
        requestAnimationFrame(() => document.getElementById(statusId)?.focus());
      }}
      onReload={() => {
        setRetry((value) => value + 1);
        onContinued();
      }}
    />
  );
}

function DirectionForm({
  task,
  step,
  draftId,
  onContinued,
  onStopped,
  onReload,
}: {
  task: Task;
  step: TaskCraftbookStep;
  draftId: string;
  onContinued: () => void;
  onStopped: (updated: Task) => void;
  onReload: () => void;
}) {
  const inputId = useId();
  const receiptId = useId();
  const [direction, setDirection] = useQuestionDraft(draftId, 'direction', () => '');
  const [busy, setBusy] = useQuestionDraft(draftId, 'busy', () => false);
  const [stopping, setStopping] = useQuestionDraft<'paused' | 'canceled' | null>(
    draftId,
    'stopping',
    () => null,
  );
  const [error, setError] = useQuestionDraft<string | null>(draftId, 'error', () => null);
  const [receipt, setReceipt] = useQuestionDraft<string | null>(draftId, 'receipt', () => null);
  // Completion can fail after the note is saved; retry without duplicating it.
  const [saved, setSaved] = useQuestionDraft<{ id: string; text: string } | null>(
    draftId,
    'saved',
    () => null,
  );
  const stop = async (status: 'paused' | 'canceled') => {
    if (busy || receipt) return;
    setBusy(true);
    setStopping(status);
    setError(null);
    try {
      const updated = await api.setTaskStatus(task.projectId, task.num, status);
      onStopped(updated);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not ${status === 'paused' ? 'pause' : 'cancel'} the task. Please try again.`,
      );
    } finally {
      setBusy(false);
      setStopping(null);
    }
  };
  const submit = async () => {
    const text = direction.trim();
    if (!text || busy || receipt) return;
    setBusy(true);
    setError(null);
    try {
      const current = await api.getTaskByRef(task.ref);
      const active = current.craftbook.steps.find(
        (candidate) => candidate.id === current.activeStepId,
      );
      if (
        taskEffectiveStatus(current) !== 'active' ||
        taskActiveAssignee(current).kind !== 'user' ||
        active?.id !== step.id ||
        active.lastActivatedAt !== step.lastActivatedAt ||
        active.attemptCount !== step.attemptCount
      ) {
        throw new Error(
          'This step has changed. Refresh activity before continuing. Your direction is still saved here.',
        );
      }
      if (!saved) {
        const { note } = await api.appendTaskNote(task.projectId, task.num, {
          text,
          stepId: step.id,
        });
        setSaved({ id: note.id, text });
      } else if (saved.text !== text) {
        await api.updateTaskNote(task.projectId, task.num, saved.id, { text });
        setSaved({ id: saved.id, text });
      }
      const result = await api.completeTaskStep(task.projectId, task.num, step.id);
      if (result.gate) throw new Error(result.gate.message);
      const next = result.task.craftbook.steps.find(
        (candidate) => candidate.id === result.task.activeStepId,
      );
      setReceipt(
        result.task.status === 'complete'
          ? 'Your direction was saved. This task is complete.'
          : next
            ? `Your direction was saved. Next step: ${next.name}.`
            : 'Your direction was saved. The task can continue.',
      );
      onContinued();
      requestAnimationFrame(() => document.getElementById(receiptId)?.focus());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not continue the task. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (receipt)
    return (
      <output id={receiptId} tabIndex={-1}>
        {receipt}
      </output>
    );
  const assignee = taskActiveAssignee(task);
  const instructions =
    (assignee.kind === 'user' ? assignee.instructions : undefined) ||
    step.description?.trim() ||
    step.prompt?.trim() ||
    task.description?.trim();
  return (
    <form
      className="activity-task-step"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>
        <strong>Current step: {step.name}</strong>
      </p>
      {instructions && (
        <div className="activity-step-instructions">
          <RenderedMarkdown markdown={instructions} />
        </div>
      )}
      <div className="activity-step-actions">
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          title="Keep the task's progress and resume it later."
          onClick={() => void stop('paused')}
        >
          {stopping === 'paused' ? 'Pausing…' : 'Pause task'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          title="End the task. Its notes and files are kept."
          onClick={() => void stop('canceled')}
        >
          {stopping === 'canceled' ? 'Canceling…' : 'Cancel task'}
        </button>
      </div>
      <label htmlFor={inputId}>What should happen next?</label>
      <textarea
        id={inputId}
        value={direction}
        onChange={(event) => setDirection(event.target.value)}
        rows={3}
        placeholder="Give direction for the next step…"
        disabled={busy}
        required
      />
      <p className="activity-context">
        Your direction will be saved with this step before the task continues.
      </p>
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="submit" className="btn" disabled={busy || !direction.trim()}>
          {busy && !stopping ? 'Continuing…' : 'Continue task'}
        </button>
        {error && (
          <button type="button" className="btn secondary" disabled={busy} onClick={onReload}>
            Refresh step
          </button>
        )}
      </div>
    </form>
  );
}
