/**
 * A task the runner is holding, rendered in the transcript so work that
 * has been accepted but hasn't spoken yet is still visible.
 *
 * Without it, starting a task while the machine is busy looks like
 * nothing happened: the task strip gains a pill reading "No chat yet"
 * and the conversation below is unchanged, so the honest reading is
 * "my request was dropped". The card is the missing half of that
 * exchange — the chat equivalent of a receipt.
 *
 * It says only what the daemon actually knows. `reason` comes from the
 * TaskRunner's live queue, so a task the runner has never seen (no entry
 * gezel, a dispatch that threw) never gets a card promising it is about
 * to start.
 */

import type { GezelSummary, Task, TaskWaitReason, TaskWaitState } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { AreaIcon } from './AreaIcon.js';
import { GezelIcon } from './GezelIcon.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/** Uppercase eyebrow — the state, at a glance. */
export function queuedTaskKindLabel(reason: TaskWaitReason): string {
  if (reason === 'dispatching') return 'Starting';
  if (reason === 'night-shift' || reason === 'night-quota') return 'Scheduled';
  if (reason === 'engagement-off' || reason === 'engagement-paused') return 'On hold';
  return 'In the queue';
}

/**
 * Why it hasn't started, in the user's terms. Wording tracks the
 * QueueMeter's panel so the two surfaces explain one hold the same way.
 */
export function queuedTaskReasonCopy(reason: TaskWaitReason, assignee: string): string {
  switch (reason) {
    case 'dispatching':
      return `${assignee} is picking it up now.`;
    case 'provider-busy':
      return 'Waiting for a free slot — other work is using the model right now.';
    case 'night-shift':
      return "Parked for Night Shift — it starts when tonight's window opens.";
    case 'night-quota':
      return 'Held back by the cloud quota reserve — it starts once the quota frees up.';
    case 'engagement-off':
      return 'Held because AI engagement is off. Turn it back on in Settings to let it start.';
    case 'engagement-paused':
      return 'Held because AI work is paused. Resume to let it start.';
    // A daemon newer than this bundle can name a reason we have no copy
    // for. Say the true, unconditional part rather than nothing.
    default:
      return `Waiting its turn — it starts as soon as ${assignee} is free.`;
  }
}

export function QueuedTaskBubble({
  task,
  wait,
  gezel,
  onTaskReference,
}: {
  task: Task;
  wait: TaskWaitState;
  /** The gezel named in `wait.gezelId`, when the caller's roster has them. */
  gezel?: GezelSummary | undefined;
  onTaskReference?: (ref: string) => void;
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const assignee = gezel
    ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
    : 'the assigned gezel';
  const since = formatRelativeTime(wait.since, { style: 'long', fallback: wait.since });

  return (
    <div className="msg msg-user msg-system msg-queued-task" data-task-ref={task.ref}>
      <div className="msg-queued-task-card">
        <div className="msg-queued-task-head">
          <AreaIcon area="tasks" size={12} className="msg-queued-task-icon" />
          <span className="msg-queued-task-kind">{queuedTaskKindLabel(wait.reason)}</span>
          <span className="msg-role-time" title={formatAbsoluteTime(wait.since)}>
            · {since}
          </span>
        </div>
        <p className="msg-queued-task-headline">
          <span className="msg-queued-task-number">#{task.num}</span> {task.title}
        </p>
        <p className="msg-queued-task-context">
          {gezel && (
            <GezelIcon
              svg={gezel.icon ?? null}
              poppetje={gezel.poppetje}
              iconOverride={gezel.iconOverride}
              name={assignee}
              size={14}
            />
          )}
          {queuedTaskReasonCopy(wait.reason, assignee)}
        </p>
        <div className="msg-queued-task-actions">
          {onTaskReference ? (
            <button
              type="button"
              className="msg-ref-chip"
              onClick={() => onTaskReference(task.ref)}
              title="Open this task"
            >
              Task {task.ref}
            </button>
          ) : (
            <span className="msg-queued-task-ref">Task {task.ref}</span>
          )}
        </div>
      </div>
    </div>
  );
}
