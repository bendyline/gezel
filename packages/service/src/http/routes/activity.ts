import { resolveActivity } from '@bendyline/gezel';
import { Hono } from 'hono';
import { normalizeNightShiftReportAttachment } from '../../tasks/night-review.js';
import type { ServiceContext } from '../context.js';
import { queueStatusSnapshot } from './queues.js';

/** Product activity stays in the user daemon, including when engines live in the broker. */
export function activityRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const [tasks, questions, projects, queues] = await Promise.all([
      ctx.tasks.list(),
      ctx.store.listAllPendingQuestions(),
      ctx.store.listProjects(),
      queueStatusSnapshot(ctx, c.req.raw, true),
    ]);
    const inflight = ctx.chat.listInflight();
    const knownSessions = new Set(inflight.map((turn) => turn.sessionId));
    const sessionIds = new Set([
      ...queues.sessions.map((queue) => queue.sessionId),
      ...Object.values(queues.providers).flatMap((provider) =>
        [...(provider?.active ?? []), ...(provider?.pending ?? [])].flatMap((row) =>
          row.sessionId ? [row.sessionId] : [],
        ),
      ),
    ]);
    const sessionOwners = (
      await Promise.all(
        [...sessionIds]
          .filter((id) => !knownSessions.has(id))
          .map(async (id) => {
            const session = await ctx.store.findSessionById(id);
            return session
              ? {
                  sessionId: session.id,
                  projectId: session.projectId,
                  gezelId: session.gezelId,
                  taskRef: session.taskRef,
                }
              : null;
          }),
      )
    ).filter((owner) => owner !== null);
    return c.json(
      resolveActivity({
        tasks,
        questions: questions.map(normalizeNightShiftReportAttachment),
        waiting: ctx.taskRunner.waitingStates(),
        inflight,
        inactiveProjectIds: new Set(
          projects
            .filter((p) => p.status === 'inactive' || p.status === 'readonly')
            .map((p) => p.id),
        ),
        queues,
        sessionOwners,
      }),
    );
  });
  return app;
}
