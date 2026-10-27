/**
 * Withdraw the runtime's own task cards once their task has moved past them.
 *
 * Two cards are filed with no live session: `task-paused` (a task paused for
 * help) and `step-awaits-owner` (an owner step is waiting). Answering either
 * acts on the task, so each means something only while that state holds.
 * Neither was closed when the task moved on another way (the task page, a
 * driver's API call, a retry). One media collection kept 4,624 pending cards,
 * 3,946 of them for finished tasks, and every CLI observer polling for
 * blockers downloaded all of them each second (2026-10-26).
 *
 * A pause card stays while its task is paused. An owner card stays while its
 * task is active or paused on that step, unless the task is driven by a CLI
 * workflow: the module that launched it completes its steps itself, so the
 * card was never the person's (`fileOwnerStepCard` no longer files one).
 * Withdrawal is the silent close `finished-pass-questions.ts` uses: the card
 * reads "No longer needed" and no turn starts.
 */
import { type Question, type Task, createLogger, parseTaskRef } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';

const log = createLogger('tasks');

type CardTask = Pick<Task, 'ref' | 'status' | 'activeStepId' | 'craftbook'>;

interface WithdrawalDeps {
  store: Pick<Store, 'listProjectQuestions' | 'updateProjectQuestions'>;
  chatEvents: Pick<ChatEventBus, 'publishProjectEvent'>;
}

/** Whether `question` is a pending runtime card that `task` has moved past. */
export function serviceCardIsStale(question: Question, task: CardTask): boolean {
  if (question.answer || question.sessionId !== '') return false;
  const intent = question.intent;
  if (intent?.kind === 'task-paused') {
    return intent.taskRef === task.ref && task.status !== 'paused';
  }
  if (intent?.kind === 'step-awaits-owner') {
    if (intent.taskRef !== task.ref) return false;
    if (task.craftbook.cliWorkflow) return true;
    if (task.status !== 'active' && task.status !== 'paused') return true;
    return task.activeStepId !== intent.stepId;
  }
  return false;
}

/** The task a runtime card is about, when it is one. */
export function serviceCardTaskRef(question: Question): string | undefined {
  const intent = question.intent;
  if (question.answer || question.sessionId !== '') return undefined;
  return intent?.kind === 'task-paused' || intent?.kind === 'step-awaits-owner'
    ? intent.taskRef
    : undefined;
}

async function withdrawWhere(
  deps: WithdrawalDeps,
  projectId: string,
  stale: (question: Question) => boolean,
  read?: readonly Question[],
): Promise<number> {
  // Most calls find nothing: read without the write lock and only take it,
  // and rewrite the file, when there is a card to close.
  const current = read ?? (await deps.store.listProjectQuestions(projectId).catch(() => []));
  if (!current.some(stale)) return 0;
  const at = new Date().toISOString();
  const closed: Question[] = [];
  await deps.store.updateProjectQuestions(projectId, (questions) => {
    for (const [index, question] of questions.entries()) {
      if (!stale(question)) continue;
      const withdrawn: Question = {
        ...question,
        answer: { silentSkip: true, withdrawn: true, at },
      };
      questions[index] = withdrawn;
      closed.push(withdrawn);
    }
    return closed.length > 0;
  });
  for (const question of closed) {
    deps.chatEvents.publishProjectEvent(projectId, { type: 'question_answered', question });
  }
  return closed.length;
}

/** Close `task`'s runtime cards that no longer describe it. */
export async function withdrawStaleServiceCards(
  deps: WithdrawalDeps,
  task: Task,
  /** The project's questions, when the caller already read them. */
  read?: readonly Question[],
): Promise<number> {
  const count = await withdrawWhere(
    deps,
    task.projectId,
    (question) => serviceCardIsStale(question, task),
    read,
  );
  if (count > 0) log.info(`[tasks] ${task.ref}: withdrew ${count} card(s) it has moved past`);
  return count;
}

/**
 * Close every stale runtime card in every project, once at boot. Cards filed
 * before this lifecycle existed, or left by a crash between a task settling
 * and its hook running, would otherwise stay pending forever. A card whose
 * task cannot be read is kept.
 */
export async function withdrawStaleServiceCardsEverywhere(
  deps: WithdrawalDeps & {
    listProjectIds: () => Promise<string[]>;
    readTask: (projectId: string, num: number) => Promise<CardTask | null>;
  },
): Promise<number> {
  let total = 0;
  for (const projectId of await deps.listProjectIds()) {
    const questions = await deps.store.listProjectQuestions(projectId).catch(() => []);
    const tasks = new Map<string, CardTask>();
    for (const ref of new Set(questions.map(serviceCardTaskRef))) {
      const parsed = ref ? parseTaskRef(ref) : null;
      if (!ref || !parsed) continue;
      const task = await deps.readTask(parsed.projectId, parsed.num).catch(() => null);
      if (task) tasks.set(ref, task);
    }
    if (tasks.size === 0) continue;
    total += await withdrawWhere(deps, projectId, (question) => {
      const ref = serviceCardTaskRef(question);
      const task = ref ? tasks.get(ref) : undefined;
      return task !== undefined && serviceCardIsStale(question, task);
    });
  }
  if (total > 0) log.info(`[tasks] withdrew ${total} stale task card(s) at startup`);
  return total;
}
