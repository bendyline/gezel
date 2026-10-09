import { setTimeout as wait } from 'node:timers/promises';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { digest } from './boundary.ts';

export interface LifecycleObservation {
  status: 'complete' | 'incomplete' | 'unobservable' | 'interrupted';
  waitedMs: number;
  tasks: Array<{ ref: string; status: string }>;
  /** Tasks already present before scenario setup, such as perpetual service jobs. */
  ignoredTasks?: Array<{ ref: string; status: string }>;
  inflightSessions: string[];
  pendingQuestions: string[];
  replies: Array<{ sessionId: string; hash: string; present: boolean }>;
  /** Only completion is checked against gates; other prose claims need a scenario-specific grader. */
  completionClaim: 'supported' | 'unverified';
}

export async function readLifecycle(
  client: GezelClient,
  baselineTaskRefs: readonly string[] = [],
): Promise<LifecycleObservation> {
  const [taskList, turns, questions, sessionList] = await Promise.all([
    client.listTasks(),
    client.listInflightTurns(),
    client.listQuestions({ pending: true }),
    client.listChatSessions(),
  ]);
  const replies: LifecycleObservation['replies'] = [];
  const inlineQuestions: string[] = [];
  for (const summary of sessionList.sessions) {
    const session = await client.getChatSession(summary.id);
    if (!session.messages.some((m) => m.role === 'user')) continue;
    const last = session.messages.at(-1);
    if (last?.role === 'assistant' && last.content.trim().endsWith('?'))
      inlineQuestions.push(`${summary.id}:${last.at}`);
    replies.push({
      sessionId: summary.id,
      hash: digest(last?.content),
      present:
        last?.role === 'assistant' &&
        typeof last.content === 'string' &&
        last.content.trim().length > 0,
    });
  }
  const allTasks = taskList.tasks.map((t) => ({ ref: t.ref, status: t.status }));
  const tasks = allTasks.filter((t) => !baselineTaskRefs.includes(t.ref));
  const ignoredTasks = allTasks.filter((t) => baselineTaskRefs.includes(t.ref));
  const complete =
    tasks.every((t) => t.status === 'complete') &&
    turns.inflight.length === 0 &&
    inlineQuestions.length === 0 &&
    questions.questions.filter((q) => q.intent?.kind !== 'task-finished').length === 0 &&
    replies.length > 0 &&
    replies.every((r) => r.present);
  return {
    status: complete ? 'complete' : 'incomplete',
    waitedMs: 0,
    tasks,
    ignoredTasks,
    inflightSessions: turns.inflight.map((t) => t.sessionId),
    pendingQuestions: [
      ...inlineQuestions,
      ...questions.questions.filter((q) => q.intent?.kind !== 'task-finished').map((q) => q.id),
    ],
    replies,
    completionClaim: complete ? 'supported' : 'unverified',
  };
}

/** Two settled observations avoid declaring completion in a handoff's quiet gap. */
export async function observeLifecycle(args: {
  client: GezelClient;
  timeoutMs: number;
  signal?: AbortSignal;
  intervalMs?: number;
  baselineTaskRefs?: readonly string[];
}): Promise<LifecycleObservation> {
  const start = Date.now();
  let prior: string | null = null;
  let settled = false;
  let result: LifecycleObservation = {
    status: 'unobservable',
    waitedMs: 0,
    tasks: [],
    inflightSessions: [],
    pendingQuestions: [],
    replies: [],
    completionClaim: 'unverified',
  };
  while (Date.now() - start < args.timeoutMs && !args.signal?.aborted) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        result = await Promise.race([
          readLifecycle(args.client, args.baselineTaskRefs),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('lifecycle read deadline')),
              Math.max(1, args.timeoutMs - (Date.now() - start)),
            );
            onAbort = () => reject(new Error('lifecycle interrupted'));
            args.signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (onAbort) args.signal?.removeEventListener('abort', onAbort);
      }
      const signature = digest({ ...result, ignoredTasks: undefined });
      if (result.status === 'complete' && prior === signature) {
        settled = true;
        break;
      }
      prior = result.status === 'complete' ? signature : null;
    } catch {
      result.status = 'unobservable';
      prior = null;
    }
    if (args.signal?.aborted) break;
    await wait(
      Math.min(args.intervalMs ?? 1000, Math.max(1, args.timeoutMs - (Date.now() - start))),
    );
  }
  if (args.signal?.aborted) result.status = 'interrupted';
  else if (result.status === 'complete' && !settled) result.status = 'incomplete';
  if (result.status !== 'complete') result.completionClaim = 'unverified';
  result.waitedMs = Date.now() - start;
  return result;
}
