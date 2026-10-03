import type { ActivityItem, ActivityStatusResponse } from './schemas/activity.js';
import type { Question } from './schemas/question.js';
import type { QueueStatusResponse } from './schemas/queue-status.js';
import { type Task, type TaskWaitState, taskEffectiveStatus } from './schemas/task.js';
import { taskActiveAssignee } from './task-execution.js';

export interface ActivityTurn {
  sessionId: string;
  gezelId: string;
  projectId: string;
  taskRef?: string;
  userText: string;
  startedAt: number;
  lastProgressAgoMs?: number;
}

export function isReadyQuestion(question: Question): boolean {
  return (
    question.intent?.kind === 'task-finished' || question.intent?.kind === 'night-shift-review'
  );
}

/** Runtime facts take precedence over durable lifecycle ("active" is not "running"). */
export function resolveActivity(input: {
  tasks: Task[];
  waiting: TaskWaitState[];
  questions: Question[];
  inflight: ActivityTurn[];
  queues: QueueStatusResponse;
  inactiveProjectIds?: Set<string>;
  sessionOwners?: Array<{
    sessionId: string;
    projectId: string;
    gezelId: string;
    taskRef?: string;
  }>;
}): ActivityStatusResponse {
  const { queues, tasks } = input;
  const questions = input.questions.filter((q) => !q.answer);
  const items = new Map<string, ActivityItem>();
  const taskByRef = new Map(tasks.map((t) => [t.ref, t]));
  const waits = new Map(input.waiting.map((w) => [w.ref, w]));
  const sessionOwners = new Map(input.sessionOwners?.map((owner) => [owner.sessionId, owner]));
  const taskBySession = new Map<string, string>();
  for (const w of input.waiting) if (w.sessionId) taskBySession.set(w.sessionId, w.ref);
  for (const t of input.inflight) if (t.taskRef) taskBySession.set(t.sessionId, t.taskRef);
  for (const s of input.sessionOwners ?? [])
    if (s.taskRef) taskBySession.set(s.sessionId, s.taskRef);
  for (const q of questions)
    if (q.taskRef && q.sessionId) taskBySession.set(q.sessionId, q.taskRef);
  const identity = (sessionId: string) => {
    const ref = taskBySession.get(sessionId);
    return ref ? `task:${ref}` : `session:${sessionId}`;
  };

  for (const task of tasks) {
    const status = taskEffectiveStatus(task);
    if (status !== 'active' && status !== 'paused') continue;
    if (task.origin?.kind === 'system-job') continue;
    // Fanout hosts coordinate their children; recurring hosts represent a
    // future run and belong under Next, never under Working by lifecycle alone.
    if (task.spawnsCraftbook && task.fanout && !task.cron) continue;
    const wait = waits.get(task.ref);
    const assignee = taskActiveAssignee(task);
    const item: ActivityItem = {
      id: `task:${task.ref}`,
      section: 'next',
      title: task.title,
      detail: 'Not running. Open the task to check its next step.',
      projectId: task.projectId,
      taskRef: task.ref,
      questionIds: [],
      ...(assignee.kind === 'gezel' ? { gezelId: assignee.gezelId } : {}),
      ...(wait ? { since: wait.since, sessionId: wait.sessionId } : {}),
    };
    if (status === 'paused') item.detail = 'Paused. Resume from the task when you are ready.';
    else if (input.inactiveProjectIds?.has(task.projectId)) item.detail = 'This project is paused.';
    else if (task.cron) {
      item.detail = task.cron.nextTickAt
        ? `Scheduled · ${task.cron.nextTickAt}`
        : 'Scheduled. Open the task for its schedule.';
    } else if (assignee.kind === 'user') {
      item.section = 'needs-you';
      item.detail = 'Your step is ready. Open the task to continue.';
    } else if (wait) {
      switch (wait.reason) {
        case 'dispatching':
          item.section = 'working';
          item.detail = 'Starting…';
          break;
        case 'engagement-off':
        case 'engagement-paused':
          item.detail =
            wait.reason === 'engagement-off'
              ? 'AI work is off. Change Activity in Settings to let this start.'
              : 'Automatic work is paused. Gezels still reply when you ask them.';
          item.heldByActivity = true;
          break;
        case 'night-shift':
          item.detail = queues.taskRunner.nightShift?.opensAt
            ? `Scheduled for Night Shift · ${queues.taskRunner.nightShift.opensAt}`
            : 'Scheduled for the next Night Shift.';
          break;
        case 'night-quota':
          item.detail = 'Waiting for the cloud quota reserve to free up.';
          break;
        case 'provider-busy':
          item.detail = 'Waiting for other work to finish using the model.';
          break;
        default:
          item.detail = 'Queued. Waiting for its gezel to be free.';
      }
    }
    items.set(item.id, item);
  }

  const pendingSessions = new Set(
    Object.values(queues.providers).flatMap(
      (p) => p?.pending.flatMap((q) => (q.sessionId ? [q.sessionId] : [])) ?? [],
    ),
  );
  const runningIds = new Set([
    ...input.inflight
      .filter((turn) => !pendingSessions.has(turn.sessionId))
      .map((turn) => identity(turn.sessionId)),
    ...Object.values(queues.providers).flatMap(
      (state) =>
        state?.active.flatMap((row) => (row.sessionId ? [identity(row.sessionId)] : [])) ?? [],
    ),
  ]);
  for (const turn of input.inflight) {
    const id = identity(turn.sessionId);
    const existing = items.get(id);
    const waiting = pendingSessions.has(turn.sessionId);
    items.set(id, {
      ...existing,
      id,
      section: waiting ? 'next' : 'working',
      title: existing?.title ?? (turn.userText.trim().slice(0, 180) || 'Conversation'),
      detail: waiting
        ? 'Waiting for a free model slot.'
        : turn.lastProgressAgoMs !== undefined
          ? turn.lastProgressAgoMs > 120_000
            ? 'Still active. No new progress reported in the last two minutes.'
            : 'Working on it.'
          : 'Starting the conversation…',
      projectId: turn.projectId,
      gezelId: turn.gezelId,
      sessionId: turn.sessionId,
      taskRef: turn.taskRef ?? existing?.taskRef,
      questionIds: [],
      since: new Date(turn.startedAt).toISOString(),
      heldByActivity: false,
    });
  }

  // Add provider-only work, but never count a task's handoff, turn, and queue
  // slot as three jobs. Anonymous housekeeping is a single background row.
  let backgroundRunning = 0;
  let backgroundWaiting = 0;
  for (const state of Object.values(queues.providers)) {
    if (!state) continue;
    backgroundRunning += Math.max(0, state.running - state.active.length);
    backgroundWaiting += Math.max(
      0,
      state.queuedInteractive + state.queuedBackground - state.pending.length,
    );
    for (const row of state.active) {
      if (!row.sessionId) {
        backgroundRunning++;
        continue;
      }
      const id = identity(row.sessionId);
      const existing = items.get(id);
      if (existing) {
        // Keep live-turn progress detail when we already know this job is
        // working; the provider slot is corroboration, not a newer phase.
        if (existing.section !== 'working') existing.detail = 'Working on it.';
        existing.section = 'working';
        existing.sessionId = row.sessionId;
        existing.heldByActivity = false;
        continue;
      }
      const owner = sessionOwners.get(row.sessionId);
      items.set(id, {
        ...owner,
        id,
        section: 'working',
        title: row.job ?? row.actorLabel ?? 'Conversation',
        detail: 'Working on it.',
        sessionId: row.sessionId,
        gezelId: row.gezelId ?? owner?.gezelId,
        projectId: row.projectId ?? owner?.projectId,
        questionIds: [],
        since: new Date(Date.parse(queues.at) - row.runningForMs).toISOString(),
      });
    }
    for (const row of state.pending) {
      if (!row.sessionId) {
        backgroundWaiting++;
        continue;
      }
      const id = identity(row.sessionId);
      const existing = items.get(id);
      if (existing) {
        if (!runningIds.has(id) && existing.section !== 'needs-you') {
          existing.section = 'next';
          existing.detail = 'Waiting for a free model slot.';
          existing.sessionId = row.sessionId;
          existing.heldByActivity = false;
        }
        continue;
      }
      const owner = sessionOwners.get(row.sessionId);
      items.set(id, {
        ...owner,
        id,
        section: 'next',
        title: row.job ?? row.actorLabel ?? 'Conversation',
        detail: 'Waiting for a free model slot.',
        sessionId: row.sessionId,
        gezelId: row.gezelId ?? owner?.gezelId,
        projectId: row.projectId ?? owner?.projectId,
        questionIds: [],
      });
    }
  }
  if (backgroundRunning)
    items.set('background:running', {
      id: 'background:running',
      section: 'working',
      title: 'Background work',
      detail: `${backgroundRunning} background operation${backgroundRunning === 1 ? '' : 's'} running.`,
      questionIds: [],
    });
  if (backgroundWaiting)
    items.set('background:waiting', {
      id: 'background:waiting',
      section: 'next',
      title: 'Background work',
      detail: `${backgroundWaiting} background operation${backgroundWaiting === 1 ? '' : 's'} waiting.`,
      questionIds: [],
    });

  for (const queue of queues.sessions) {
    if (!queue.depth) continue;
    const id = identity(queue.sessionId);
    const existing = items.get(id);
    const detail = `${queue.depth} message${queue.depth === 1 ? '' : 's'} waiting in this conversation.`;
    if (existing) existing.detail += ` ${detail}`;
    else {
      const owner = sessionOwners.get(queue.sessionId);
      items.set(id, {
        ...owner,
        id,
        section: 'next',
        title: queue.nextPreview || 'Queued conversation',
        detail,
        sessionId: queue.sessionId,
        questionIds: [],
      });
    }
  }

  for (const q of questions) {
    const ready = isReadyQuestion(q);
    const taskRef = q.taskRef ?? taskBySession.get(q.sessionId);
    // A ready receipt must not hide a newer live turn for the same task.
    const id = ready
      ? `question:${q.id}`
      : taskRef
        ? `task:${taskRef}`
        : q.sessionId
          ? identity(q.sessionId)
          : `question:${q.id}`;
    const existing = items.get(id);
    items.set(id, {
      ...existing,
      id,
      section: ready ? 'ready' : 'needs-you',
      title:
        (taskRef && taskByRef.get(taskRef)?.title) ||
        existing?.title ||
        (ready ? 'Ready to review' : 'A question for you'),
      detail: ready ? 'Finished work to review.' : 'Waiting for your response.',
      projectId: q.projectId,
      gezelId: q.gezelId,
      taskRef,
      sessionId: q.sessionId || undefined,
      questionIds: [...(existing?.questionIds ?? []), q.id],
      since: existing?.since ?? q.createdAt,
    });
  }
  return { items: [...items.values()], questions, queues, at: queues.at };
}
