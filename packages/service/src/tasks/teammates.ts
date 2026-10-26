import {
  OUTCOME_TEAMMATE_JOB_TITLES,
  type RequestAskResponse,
  type TaskTeammateRequest,
  outcomeTaskHasSubagents,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { ensureGezel } from '../gezels/ensure.js';

/**
 * Hand a piece of an outcome task to a teammate and wait for the answer.
 *
 * Only the task's own owner session may ask, and only on an outcome task
 * with teammates on. The teammate gets a fresh consultation session that
 * works FOR the task (`subagentFor`): what it reads and runs counts toward
 * the task's evidence, but it carries no task context, no task tools and no
 * step binding, so it cannot advance, pause or close the task.
 */
export async function askTaskTeammate(
  deps: { store: Store; catalog: CatalogService; chat: ChatManager },
  args: TaskTeammateRequest & { projectId: string; num: number },
): Promise<RequestAskResponse> {
  const refuse = (message: string): RequestAskResponse => ({
    outcome: 'error',
    reason: 'delivery-failed',
    message,
  });
  const task = await deps.store.readTask(args.projectId, args.num);
  if (!task) return { outcome: 'error', reason: 'not-found', message: 'No such task.' };
  if (!outcomeTaskHasSubagents(task)) {
    return refuse(`Task ${task.ref} does not hand work to teammates. Do this part yourself.`);
  }
  const owner = await deps.chat.getSessionRecord(args.fromSessionId).catch(() => null);
  if (
    !owner ||
    owner.taskRef !== task.ref ||
    owner.gezelId !== args.fromGezelId ||
    owner.consultationMode ||
    owner.subagentFor
  ) {
    return refuse(`Only the session working ${task.ref} can hand its work to a teammate.`);
  }
  const ensured = await ensureGezel({
    opts: { jobTitle: OUTCOME_TEAMMATE_JOB_TITLES[args.role] },
    store: deps.store,
    catalog: deps.catalog,
    chat: deps.chat,
    bespokeMode: 'static',
  });
  if (ensured.gezelId === args.fromGezelId) {
    return {
      outcome: 'error',
      reason: 'self',
      message: `You are the ${args.role} on this task: do this part yourself. Do not retry consult_${args.role}.`,
    };
  }
  await deps.store
    .addGezelToProject(args.projectId, ensured.gezelId, { source: 'task' })
    .catch(() => {
      /* roster add is best-effort */
    });
  const result = await deps.chat.askGezelAndWait({
    fromGezelId: args.fromGezelId,
    fromSessionId: args.fromSessionId,
    toGezelIdOrName: ensured.gezelId,
    projectId: args.projectId,
    text: args.question,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    subagentFor: { taskRef: task.ref, ownerSessionId: owner.id },
  });
  if (result.outcome === 'reply') {
    return {
      outcome: 'reply',
      text: result.text,
      toGezelId: result.toGezelId,
      toGezelName: result.toGezelName,
      sessionId: result.sessionId,
    };
  }
  return { outcome: 'error', reason: result.reason, message: result.message };
}
