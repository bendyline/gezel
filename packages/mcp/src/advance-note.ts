/**
 * Handoff-note policy for `advance_task_step` — extracted from server.ts
 * for testability (pattern: kickoff-text.ts, solo-loop-policy.ts).
 *
 * The note is the model-facing truth about what happened AFTER the step
 * completed: whether a successor gezel was actually dispatched. It must
 * never claim a handoff that the runtime refused — wild-caught on
 * gezel/10, where the task paused at activation (the new step's
 * deliverable targeted a workspace file on a writes-off project) while
 * the tool text still said "Started esra on it", so neither the calling
 * gezel nor the user learned the task had stopped.
 */

export function advanceHandoffNote(opts: {
  status: string;
  assigneeId: string | undefined;
}): string {
  if (opts.status === 'paused') {
    return (
      ' The task is now PAUSED — the new step could not be dispatched, so NO handoff was' +
      ' started. Call `read_task_notes`: the newest note says why it stopped and how to fix' +
      ' it. Tell the user the task is paused and what it needs.'
    );
  }
  if (opts.assigneeId) {
    return ` Started ${opts.assigneeId} on it — they now have an open session with the task in context.`;
  }
  if (opts.status === 'complete') {
    return ' Task is now complete (terminal step).';
  }
  return ' (No gezel is assigned to the new step, so no handoff was started.)';
}
