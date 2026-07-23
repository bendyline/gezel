/**
 * The single-channel kickoff: enqueue a task's ENTRY step for handoff
 * dispatch right after create, so the worker starts in a task-scoped
 * session with the step prompt + gate contract in-prompt (the
 * `kind:'entry'` seed) instead of a plain chat notification.
 *
 * Shared by the two kickoff surfaces so they cannot drift:
 * - the command launcher (`craftbookInvoker` in service.ts), and
 * - `POST /api/projects/:id/tasks` with `dispatchEntry: true` (the
 *   meester macros' path).
 *
 * NOTE: `TaskManager.create` fires only `onTaskCreated` (never
 * `onStepActivated`), so this explicit enqueue IS the single kickoff —
 * see the double-start comment at the craftbookInvoker in service.ts.
 * Durability comes from the runner: if the daemon dies between enqueue
 * and dispatch, `TaskRunner.rehydrateFromStore` backfills on next boot
 * (recovery the old chat-notify never had).
 */

import type { Task } from '@bendyline/gezel';
import { createLogger, projectAllowsAmbientWork } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { stepOwnerGezelId } from './manager.js';
import type { TaskRunner } from './runner.js';

const log = createLogger('tasks');

export interface EntryDispatchDeps {
  store: Pick<Store, 'getProject' | 'getGezel'>;
  taskRunner: Pick<TaskRunner, 'enqueueHandoff'>;
  history?: Pick<HistoryManager, 'log'>;
}

export interface EntryDispatchResult {
  enqueued: boolean;
  gezelId?: string;
  assigneeName?: string;
  reason?: 'not-active' | 'no-active-step' | 'spawn-host' | 'no-entry-gezel' | 'project-inactive';
}

/**
 * Best-effort by design: a guard tripping means the task was created
 * fine but nothing auto-starts — the reason is logged and returned,
 * never thrown. Callers surface `assigneeName`/`enqueued` in their
 * result text.
 */
export async function dispatchTaskEntry(
  deps: EntryDispatchDeps,
  task: Task,
): Promise<EntryDispatchResult> {
  if (task.status !== 'active') {
    return { enqueued: false, reason: 'not-active' };
  }
  if (task.cron || task.fanout) {
    // Spawn hosts never run their own steps — children dispatch via
    // their own activation hooks; kicking the host would double-engage.
    return { enqueued: false, reason: 'spawn-host' };
  }
  const stepId = task.activeStepId;
  if (!stepId) {
    return { enqueued: false, reason: 'no-active-step' };
  }
  const step = task.craftbook.steps.find((s) => s.id === stepId);
  const gezelId = step ? stepOwnerGezelId(task, step) : undefined;
  if (!gezelId) {
    return { enqueued: false, reason: 'no-entry-gezel' };
  }

  const assigneeName = (await deps.store.getGezel(gezelId).catch(() => null))?.name;

  const project = await deps.store.getProject(task.projectId).catch(() => null);
  if (project && !projectAllowsAmbientWork(project)) {
    log.info(`[tasks] entry dispatch skipped for ${task.ref}: project not active`);
    return {
      enqueued: false,
      gezelId,
      ...(assigneeName ? { assigneeName } : {}),
      reason: 'project-inactive',
    };
  }

  deps.taskRunner.enqueueHandoff({
    gezelId,
    projectId: task.projectId,
    taskRef: task.ref,
    stepId,
    ...(step?.lastActivatedAt ? { activationAt: step.lastActivatedAt } : {}),
    kind: 'entry',
  });
  log.info(`[tasks] entry dispatched: ${task.ref} step ${stepId} → ${assigneeName ?? gezelId}`);
  deps.history
    ?.log({
      kind: 'task.entry.dispatched',
      projectId: task.projectId,
      gezelId,
      summary: `Task ${task.ref} entry step "${stepId}" handed to ${assigneeName ?? gezelId}`,
      details: { ref: task.ref, stepId, gezelId },
    })
    .catch(() => {});

  return { enqueued: true, gezelId, ...(assigneeName ? { assigneeName } : {}) };
}
