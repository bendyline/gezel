import { stepDurationEstimates } from '../request-track/eta.js';
import { assembleRequestTracks } from '../request-track/resolve.js';
import type { ListRequestsResponse } from '../schemas/request-track.js';
import type { ChatSession } from '../schemas/session.js';
import type { PortableStore } from './store.js';

/** What the phone's `/api/requests` reads from its host. */
export interface PortableRequestHost {
  store: Pick<PortableStore, 'listTasks' | 'listQuestions' | 'readConfig' | 'getProject'>;
  session(id: string): Promise<ChatSession>;
  /** The turns the host is running or holding for the engine. */
  turns(): Iterable<{ session: ChatSession; text: string; startedAt: number }>;
}

/**
 * The phone's `/api/requests`, from the same resolver as the desktop's. It
 * has no wrap-ups, fanout or task runner waits, so a finished request takes
 * its deliverable from the book's promised file and a queued one says only
 * that it is about to start.
 */
export async function portableRequestTracks(
  host: PortableRequestHost,
  query: URLSearchParams,
): Promise<ListRequestsResponse> {
  const now = Date.now();
  const [tasks, questions, config] = await Promise.all([
    host.store.listTasks(),
    host.store.listQuestions({ pending: true }),
    host.store.readConfig(),
  ]);
  const sessions = (query.get('sessions') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const inflight = [...host.turns()].map((turn) => ({
    sessionId: turn.session.id,
    gezelId: turn.session.gezelId,
    projectId: turn.session.projectId,
    ...(turn.session.taskRef ? { taskRef: turn.session.taskRef } : {}),
    providerName: turn.session.providerName,
    userText: turn.text,
    startedAt: turn.startedAt,
  }));
  const requests = await assembleRequestTracks(
    {
      tasks,
      session: (id) => host.session(id).catch(() => null),
      project: (id) => host.store.getProject(id).catch(() => null),
      ...(config.meesterGezelId ? { meesterGezelId: config.meesterGezelId } : {}),
      inflight,
      waiting: [],
      questions,
      estimates: stepDurationEstimates(tasks),
      now,
    },
    {
      ...(sessions.length > 0 ? { sessions } : {}),
      ...(query.get('live') === '1' ? { live: true } : {}),
    },
  );
  return { requests, at: new Date(now).toISOString() };
}
