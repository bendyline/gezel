import type { ChatMessage } from '../schemas/gezel.js';
import type { ChatSession } from '../schemas/session.js';
import { type Task, parseTaskRef } from '../schemas/task.js';

/**
 * Which person message a piece of work answers. A request is keyed by its
 * thread and the message's timestamp, which every message has, old or new;
 * the message id is carried when the host stamped one.
 */
export type TaskRequestRef = NonNullable<Task['requestRef']>;

/** The stable key for a request: `<sessionId>@<at>`. */
export function requestKey(ref: Pick<TaskRequestRef, 'sessionId' | 'at'>): string {
  return `${ref.sessionId}@${ref.at}`;
}

type MessageLike = Pick<
  ChatMessage,
  'role' | 'at' | 'id' | 'from' | 'hidden' | 'nudge' | 'origin' | 'synthetic'
>;

/**
 * Whether `message` is something the person said that can start a request:
 * not another gezel's message, not a machinery seed, not a mid-turn nudge
 * (which adds to the request already running). A task session written before
 * seeds were marked opens with its dispatch seed, the same rule the timeline
 * applies.
 */
export function isPersonMessage(
  message: MessageLike,
  session?: { taskRef?: string | undefined; messages: readonly MessageLike[] },
): boolean {
  if (message.role !== 'user') return false;
  if (message.from || message.hidden || message.nudge || message.synthetic) return false;
  if (message.origin === 'system') return false;
  if (session?.taskRef && !session.messages.some((m) => m.origin)) {
    const seed = session.messages.find((m) => m.role === 'user');
    if (seed?.at === message.at) return false;
  }
  return true;
}

/** The newest person message in `session` at or before `at` (any time when omitted). */
export function latestPersonMessage<M extends MessageLike>(
  session: { taskRef?: string | undefined; messages: readonly M[] },
  at?: string,
): M | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (at !== undefined && message.at > at) continue;
    if (isPersonMessage(message, session)) return message;
  }
  return undefined;
}

/** What {@link deriveTaskRequestRef} reads; both hosts' stores fit it. */
export interface RequestLineageReader {
  task(ref: string): Promise<RequestLineageTask | null>;
  session(id: string): Promise<RequestLineageSession | null>;
}

export type RequestLineageTask = Pick<
  Task,
  'ref' | 'requestRef' | 'parentTaskRef' | 'launchSessionId' | 'createdAt'
>;

export type RequestLineageSession = Pick<ChatSession, 'id' | 'taskRef' | 'parentSession'> & {
  messages: readonly MessageLike[];
};

/** Most edges walked before giving up: lineage is shallow, and a cycle must end. */
const MAX_HOPS = 8;

/**
 * The person message `task` is working on. Walks the lineage a task can have:
 * a fanout child's host, the session that launched it, a step session's own
 * task, a delegated session's parent, and a gezel's message back to the
 * thread it came from. Used when a task is created and, for tasks created
 * before the ref was stamped, when a request is read.
 */
export async function deriveTaskRequestRef(
  task: Pick<RequestLineageTask, 'requestRef' | 'parentTaskRef' | 'launchSessionId' | 'createdAt'>,
  reader: RequestLineageReader,
): Promise<TaskRequestRef | undefined> {
  type Lineage = Pick<
    RequestLineageTask,
    'requestRef' | 'parentTaskRef' | 'launchSessionId' | 'createdAt'
  >;
  const seen = new Set<string>();
  let current: { kind: 'task'; task: Lineage } | { kind: 'session'; id: string; at: string } = {
    kind: 'task',
    task,
  };
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current.kind === 'task') {
      const t: Lineage = current.task;
      if (t.requestRef) return t.requestRef;
      if (t.parentTaskRef && parseTaskRef(t.parentTaskRef)) {
        if (seen.has(`task:${t.parentTaskRef}`)) return undefined;
        seen.add(`task:${t.parentTaskRef}`);
        const parent = await reader.task(t.parentTaskRef);
        if (!parent) return undefined;
        current = { kind: 'task', task: parent };
        continue;
      }
      if (!t.launchSessionId) return undefined;
      current = { kind: 'session', id: t.launchSessionId, at: t.createdAt };
      continue;
    }
    if (seen.has(`session:${current.id}`)) return undefined;
    seen.add(`session:${current.id}`);
    const session = await reader.session(current.id);
    if (!session) return undefined;
    if (session.taskRef) {
      if (seen.has(`task:${session.taskRef}`)) return undefined;
      seen.add(`task:${session.taskRef}`);
      const owner = await reader.task(session.taskRef);
      if (!owner) return undefined;
      current = { kind: 'task', task: owner };
      continue;
    }
    const message = latestUserTurn(session, current.at);
    if (message?.from?.sessionId) {
      current = { kind: 'session', id: message.from.sessionId, at: message.at };
      continue;
    }
    if (message && isPersonMessage(message, session)) {
      return {
        sessionId: session.id,
        at: message.at,
        ...(message.id ? { messageId: message.id } : {}),
      };
    }
    if (session.parentSession) {
      current = { kind: 'session', id: session.parentSession.sessionId, at: current.at };
      continue;
    }
    const person = latestPersonMessage(session, current.at);
    return person
      ? { sessionId: session.id, at: person.at, ...(person.id ? { messageId: person.id } : {}) }
      : undefined;
  }
  return undefined;
}

/** The user-role turn that was running at `at`: the person's, a gezel's, or a seed. */
function latestUserTurn(session: RequestLineageSession, at: string): MessageLike | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role !== 'user' || message.at > at) continue;
    if (message.hidden || message.nudge) continue;
    return message;
  }
  return undefined;
}
