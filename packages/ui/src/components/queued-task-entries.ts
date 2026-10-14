import type { Task, TaskWaitState } from '@bendyline/gezel';

/** One held task paired with the runner state explaining the hold. */
export interface QueuedTaskEntry {
  task: Task;
  wait: TaskWaitState;
}

/**
 * Pair the project's active tasks with the TaskRunner's live queue, and
 * narrow the result to whatever the calling timeline is scoped to.
 *
 * Only tasks the runner is actually holding earn an entry. An active
 * task the runner has never seen — no entry gezel resolved, a dispatch
 * that threw — is deliberately absent: a card saying "waiting its turn"
 * for work that will never start is worse than no card, because it
 * reads as progress and buys the stuck task another hour of patience.
 *
 * Recurring work earns no card either. The Meester's nightly oversight
 * review (`nightShift.onceADay`) and cron tasks re-arm themselves and sit
 * held through the day by design; nobody in this conversation launched
 * them, so a receipt would be a fixture in every Default chat. The task
 * strip still lists them.
 *
 * Ordered oldest-first, the FIFO order the runner dispatches in and the
 * order the timeline places them by `wait.since`.
 */
export function selectQueuedTaskEntries(input: {
  tasks: Task[];
  waiting: TaskWaitState[];
  /** Per-gezel chat tab: only work held for this gezel. */
  gezelId?: string | undefined;
  /** Task detail chat: only this task. */
  taskRef?: string | undefined;
}): QueuedTaskEntry[] {
  const { tasks, waiting, gezelId, taskRef } = input;
  if (waiting.length === 0) return [];
  const byRef = new Map(tasks.map((task) => [task.ref, task]));
  const entries: QueuedTaskEntry[] = [];
  for (const wait of waiting) {
    if (taskRef && wait.ref !== taskRef) continue;
    if (gezelId && wait.gezelId !== gezelId) continue;
    const task = byRef.get(wait.ref);
    // The list and the queue are read at slightly different moments; a
    // ref with no task in hand is a task that just left `active`.
    if (!task) continue;
    if (task.cron || task.nightShift?.onceADay) continue;
    entries.push({ task, wait });
  }
  entries.sort((a, b) => Date.parse(a.wait.since) - Date.parse(b.wait.since));
  return entries;
}
