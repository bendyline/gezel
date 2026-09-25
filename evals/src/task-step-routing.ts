/**
 * Route harness feedback about a craftbook task INTO the active step's bound
 * session, or hold it.
 *
 * `messageGezel` addresses a `{gezelId, projectId}` pair and nothing finer, so
 * a nudge about craftbook work used to open (or reuse) a chat with no
 * `taskRef` and no `stepId`. That session cannot see the step procedure, and
 * since the MCP server refuses writes from task-less sessions into a live
 * task's folder (`task_scoped_write_denied`) it cannot write the step's
 * outputs either. Wild-caught on the 2026-09-23 smoke run:
 * craftbook-codemod-sweep's runner did its step work in an unbound session,
 * had every `write_artifact tasks/1/*.md` denied, and flailed on
 * `assign_task`; craftbook-powerpoint-deck's nudges took the only engine slot
 * while the runner was holding the next step's handoff.
 *
 * The rule: a nudge about an active craftbook task is delivered with
 * `sendToChatSession` into the session bound to `(task.ref, activeStepId)`,
 * and is not sent at all while no such session exists or the runner still
 * holds the step's handoff. Holding is safe — the step will start and the
 * next poll re-evaluates; a stray unbound session is not.
 */

export interface TaskStepRoute {
  projectId: string;
  taskRef: string;
  stepId: string;
  /**
   * Set when the task runner is holding or dispatching this task's handoff
   * (its `waiting` entry reason: queued, provider-busy, dispatching, …).
   */
  runnerHold?: string;
}

export interface TaskStepRouteTask {
  ref: string;
  projectId?: string;
  status?: string;
  activeStepId?: string | null;
}

export interface TaskStepRouteWaiting {
  ref: string;
  reason: string;
  stepId?: string;
}

export interface TaskStepRouteSession {
  id?: string;
  gezelId: string;
  projectId?: string;
  taskRef?: string | null;
  stepId?: string | null;
  archived?: boolean;
  lastActivityAt?: string;
}

export type TaskStepDelivery =
  | { kind: 'deliver'; gezelId: string; sessionId: string; projectId: string }
  | { kind: 'hold'; reason: string };

/**
 * The route for a craftbook task, or `undefined` when the task is not one a
 * step session can act on (finished, canceled, or never activated) — callers
 * then keep their ordinary routing.
 */
export function taskStepRouteFor(
  task: TaskStepRouteTask,
  projectId: string,
  waiting: readonly TaskStepRouteWaiting[] = [],
): TaskStepRoute | undefined {
  if (task.status === 'complete' || task.status === 'canceled' || task.status === 'draft') {
    return undefined;
  }
  const stepId = task.activeStepId ?? undefined;
  if (!stepId) return undefined;
  const hold = waiting.find((entry) => entry.ref === task.ref);
  return {
    projectId: task.projectId ?? projectId,
    taskRef: task.ref,
    stepId,
    ...(hold ? { runnerHold: hold.reason } : {}),
  };
}

/**
 * Pure routing decision. Deliver into the most recently active, non-archived
 * session bound to exactly this task step — or, failing that, one bound to
 * the task with no step pinned yet (a continuing task session is re-pinned
 * only when its next handoff dispatches). A session pinned to a DIFFERENT
 * step is never chosen: it would steer the model back into finished work.
 * Otherwise hold.
 */
export function decideTaskStepDelivery(
  route: TaskStepRoute,
  sessions: readonly TaskStepRouteSession[],
): TaskStepDelivery {
  if (route.runnerHold) {
    return {
      kind: 'hold',
      reason: `the task runner still holds the \`${route.stepId}\` handoff (${route.runnerHold})`,
    };
  }
  const tsOf = (session: TaskStepRouteSession): number => {
    const parsed = Date.parse(session.lastActivityAt ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const onTask = sessions
    .filter(
      (session): session is TaskStepRouteSession & { id: string } =>
        !!session.id && !session.archived && session.taskRef === route.taskRef,
    )
    .sort((a, b) => tsOf(b) - tsOf(a));
  const chosen =
    onTask.find((session) => session.stepId === route.stepId) ??
    onTask.find((session) => !session.stepId);
  if (!chosen) {
    return {
      kind: 'hold',
      reason: `no session has started for active step \`${route.stepId}\` yet`,
    };
  }
  return {
    kind: 'deliver',
    gezelId: chosen.gezelId,
    sessionId: chosen.id,
    projectId: chosen.projectId ?? route.projectId,
  };
}

/** Fetch the project's sessions and decide. A failed listing holds. */
export async function resolveTaskStepDelivery(
  client: {
    listChatSessions: (filter?: { gezelId?: string; projectId?: string }) => Promise<{
      sessions: TaskStepRouteSession[];
    }>;
  },
  route: TaskStepRoute,
): Promise<TaskStepDelivery> {
  if (route.runnerHold) return decideTaskStepDelivery(route, []);
  try {
    const { sessions } = await client.listChatSessions({ projectId: route.projectId });
    return decideTaskStepDelivery(route, sessions ?? []);
  } catch (err) {
    return {
      kind: 'hold',
      reason: `session lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
