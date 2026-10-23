/**
 * Withdraw the questions a task step asked during a pass that is over.
 *
 * A step session serves one activation of its step. When the task moves on,
 * loops back to the same step through a gate, or finishes, that session's
 * pending `ask_user_question` card is history: the runtime already refuses
 * its task moves (stale-step-session.ts), and answering the card would start
 * a turn that can change nothing while it holds the engine. On week-plan
 * (qwen3.8-27b, 2026-10-21) four answers to an earlier report pass's
 * questions kept dead turns on the only engine slot for most of an hour.
 *
 * Only plain questions are withdrawn. Service cards (`intent`) carry their
 * own lifecycle, and a question without a `stepId` was not asked by a step.
 * Withdrawing is the same silent close the night-review card uses: the card
 * collapses everywhere and no turn starts.
 */
import { type ChatSession, type Question, type Task, createLogger } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import { servesEarlierActivation } from '../chat/session-step-activation.js';
import type { Store } from '../fs/store.js';

const log = createLogger('tasks');

/** Whether `question`, asked by a step of `task`, belongs to a pass that has ended. */
export function questionPassIsOver(
  question: Pick<Question, 'stepId' | 'createdAt'>,
  task: Pick<Task, 'ref' | 'status' | 'activeStepId' | 'craftbook'>,
  asker: Pick<ChatSession, 'taskRef' | 'stepId' | 'stepActivationId'> | null,
): boolean {
  if (!question.stepId) return false;
  if (task.status !== 'active' && task.status !== 'paused') return true;
  if (task.activeStepId !== question.stepId) return true;
  const step = task.craftbook?.steps?.find((s) => s.id === question.stepId);
  if (!step?.lastActivatedAt) return false;
  if (asker?.stepId === question.stepId && asker.stepActivationId) {
    return servesEarlierActivation(asker, task.ref, step);
  }
  return question.createdAt < step.lastActivatedAt;
}

export async function withdrawFinishedPassQuestions(
  deps: {
    store: Pick<Store, 'listProjectQuestions' | 'writeQuestion' | 'getSession'>;
    chatEvents: Pick<ChatEventBus, 'publishProjectEvent'>;
  },
  task: Task,
): Promise<number> {
  const questions = await deps.store.listProjectQuestions(task.projectId).catch(() => []);
  let withdrawn = 0;
  for (const question of questions) {
    if (question.answer || question.intent || question.taskRef !== task.ref) continue;
    if (!question.stepId) continue;
    const asker = await deps.store
      .getSession(question.gezelId, question.sessionId)
      .catch(() => null);
    if (!questionPassIsOver(question, task, asker)) continue;
    const closed: Question = {
      ...question,
      answer: { silentSkip: true, withdrawn: true, at: new Date().toISOString() },
    };
    try {
      await deps.store.writeQuestion(closed);
    } catch (err) {
      log.warn(`[tasks] could not withdraw question ${question.id}: ${String(err)}`);
      continue;
    }
    deps.chatEvents.publishProjectEvent(task.projectId, {
      type: 'question_answered',
      question: closed,
    });
    withdrawn += 1;
  }
  if (withdrawn > 0) {
    log.info(
      `[tasks] ${task.ref}: withdrew ${withdrawn} question(s) from step passes that are over`,
    );
  }
  return withdrawn;
}
