import type { ChatSession, Task } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';

/**
 * Whether a task-step session serves a pass its task has already finished.
 *
 * A step session is bound to one activation (`stepActivationId` equals the
 * step's `lastActivatedAt` when the pass began). When a review gate loops the
 * task back to the same step, a new session takes the new pass and the old
 * one is history: the runtime refuses its task moves, but a turn it starts
 * still holds the engine. The harness woke such sessions twice over on
 * week-plan (qwen3.8-27b, 2026-10-21) — a recovery nudge into the pass-1
 * report session, then four auto-answers to the pass-2 one — and their dead
 * turns took the only engine slot for most of an hour.
 */
export function stepBindingIsStale(
  session: Pick<ChatSession, 'taskRef' | 'stepId' | 'stepActivationId'>,
  task: Pick<Task, 'status' | 'activeStepId' | 'craftbook'> | null,
): boolean {
  if (!session.taskRef || !session.stepId || !task) return false;
  if (task.status !== 'active' && task.status !== 'paused') return true;
  if (task.activeStepId !== session.stepId) return true;
  const step = task.craftbook?.steps?.find((s) => s.id === session.stepId);
  return (
    !!session.stepActivationId &&
    !!step?.lastActivatedAt &&
    session.stepActivationId !== step.lastActivatedAt
  );
}

/** {@link stepBindingIsStale} for a session id; unknown or unreadable reads as live. */
export async function sessionServesFinishedPass(
  client: GezelClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await client.getChatSession(sessionId);
    if (!session?.taskRef || !session.stepId) return false;
    const task = await client.getTaskByRef(session.taskRef).catch(() => null);
    return stepBindingIsStale(session, task);
  } catch {
    return false;
  }
}
