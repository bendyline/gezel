import type { ChatSession, Task } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * The thread the owner reads for a task: the session that launched it, or,
 * for a launch from inside another task's session, the first ancestor that
 * is not task-scoped. Null when there is none or it was archived.
 */
export async function findOwnerThread(
  store: Pick<Store, 'findSessionById'>,
  task: Task,
): Promise<ChatSession | null> {
  if (!task.launchSessionId) return null;
  let thread = await store.findSessionById(task.launchSessionId).catch(() => null);
  const seen = new Set<string>();
  while (thread?.taskRef && thread.parentSession && !seen.has(thread.id)) {
    seen.add(thread.id);
    thread = await store.findSessionById(thread.parentSession.sessionId).catch(() => null);
  }
  if (!thread || thread.taskRef || thread.archived) return null;
  return thread;
}
