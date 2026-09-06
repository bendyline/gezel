import { SendChatRequestSchema, getEngagementMode, isEngagementAllowed } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const DEFAULT_PROJECT = 'default';

/**
 * Legacy per-(gezel, project) chat routes. Each call resolves to the
 * most-recent non-archived session for that pair (auto-creating one on
 * first send), so pre-existing clients keep working while the UI migrates
 * to the session-scoped API under `/api/sessions`.
 */
export function chatRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/chat', async (c) => {
    const id = c.req.param('id');
    const projectId = c.req.query('project') ?? DEFAULT_PROJECT;
    const sessions = await ctx.chat.listSessions({ gezelId: id, projectId });
    const active = sessions.find((s) => !s.archived && !s.taskRef);
    if (!active) return c.json({ gezelId: id, projectId, messages: [] });
    const messages = await ctx.chat.history(active.id);
    return c.json({ gezelId: id, projectId, messages });
  });

  app.post('/:id/chat/send', async (c) => {
    const id = c.req.param('id');
    const body = SendChatRequestSchema.parse(await c.req.json());
    const cfg = await ctx.store.readConfig();
    if (!isEngagementAllowed(cfg)) {
      return c.json({ error: `engagement mode is ${getEngagementMode(cfg)}; AI is disabled` }, 403);
    }
    const projectId =
      ((body as Record<string, unknown>).projectId as string | undefined) ?? DEFAULT_PROJECT;
    const session = await ctx.chat.ensureOrCreateSession({
      gezelId: id,
      projectId,
      ...(body.expectedDeliverable ? { expectedDeliverable: body.expectedDeliverable } : {}),
    });
    ctx.chat.trackBackground(
      ctx.chat
        .send(session.id, body.message, { fileTurnIntent: body.fileTurnIntent })
        .catch(() => {}),
    );
    return c.json({ accepted: true, gezelId: id, projectId, sessionId: session.id }, 202);
  });

  app.post('/:id/chat/reset', async (c) => {
    const id = c.req.param('id');
    const projectId = c.req.query('project') ?? DEFAULT_PROJECT;
    const sessions = await ctx.chat.listSessions({ gezelId: id, projectId });
    for (const s of sessions) await ctx.chat.reset(s.id);
    return c.json({ ok: true });
  });

  return app;
}
