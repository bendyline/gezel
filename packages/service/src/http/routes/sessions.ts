import {
  CreateChatSessionRequestSchema,
  InterruptSessionRequestSchema,
  SearchSessionsRequestSchema,
  SendToSessionRequestSchema,
  UpdateQueuedMessageRequestSchema,
  createLogger,
  getEngagementMode,
  isEngagementAllowed,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

export function sessionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const gezelId = c.req.query('gezel') || undefined;
    const projectId = c.req.query('project') || undefined;
    const sessions = await ctx.chat.listSessions({ gezelId, projectId });
    return c.json({ sessions });
  });

  app.post('/', async (c) => {
    const body = CreateChatSessionRequestSchema.parse(await c.req.json());
    const session = await ctx.chat.createSession(body);
    return c.json(session, 201);
  });

  // Register before `/:id` — Hono matches in insertion order, and
  // /:id would otherwise swallow `/search` as `id = 'search'`.
  app.get('/search', async (c) => {
    const params = SearchSessionsRequestSchema.parse({
      q: c.req.query('q'),
      gezel: c.req.query('gezel') || undefined,
      project: c.req.query('project') || undefined,
      maxResults: c.req.query('maxResults')
        ? Number.parseInt(c.req.query('maxResults')!, 10)
        : undefined,
    });
    const results = await ctx.globalIndex.searchSessions(params.q, {
      ...(params.gezel ? { gezelId: params.gezel } : {}),
      ...(params.project ? { projectId: params.project } : {}),
      ...(params.maxResults ? { maxResults: params.maxResults } : {}),
    });
    const status = await ctx.globalIndex.status();
    return c.json({ results, engine: status.available ? 'fts' : 'unavailable' });
  });

  // Register before `/:id` — Hono matches in insertion order, and
  // /:id would otherwise swallow `/inflight` as `id = 'inflight'`
  // and return 404. Surfaced as spurious console errors in the UI
  // ("Failed to load /api/sessions/inflight: 404").
  app.get('/inflight', async (c) => {
    const projectId = c.req.query('project') || undefined;
    const gezelId = c.req.query('gezel') || undefined;
    const all = ctx.chat.listInflight();
    const filtered = all.filter(
      (e) =>
        (projectId === undefined || e.projectId === projectId) &&
        (gezelId === undefined || e.gezelId === gezelId),
    );
    return c.json({ inflight: filtered });
  });

  // Register before `/:id` for the same insertion-order reason as
  // `/inflight` above. Live per-session progress counters — in-memory,
  // reset on daemon restart. Consumed by the eval harness (instead of
  // scraping daemon logs) and by stall diagnostics.
  app.get('/telemetry', (c) => {
    const projectId = c.req.query('project') || undefined;
    const gezelId = c.req.query('gezel') || undefined;
    const sessions = ctx.chat.listSessionTelemetry({
      ...(projectId ? { projectId } : {}),
      ...(gezelId ? { gezelId } : {}),
    });
    return c.json({ version: 1, capturedAt: Date.now(), sessions });
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const record = await ctx.chat.getSessionRecord(id);
    if (!record) return c.json({ error: 'not found' }, 404);
    return c.json(record);
  });

  // Debug snapshot — returns the freshly-computed system prompt + the
  // metadata that drove how it was built. Audience is engineers
  // debugging prompt issues from the UI's debug-mode "copy debug
  // bundle" button. Optional `at=<ISO timestamp>` slices messages
  // with `at <= that` (the assistant message's `at` from
  // ChatMessage); `limit=N` caps the message context window.
  app.get('/:id/debug', async (c) => {
    const id = c.req.param('id');
    const at = c.req.query('at') || undefined;
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
    try {
      const snapshot = await ctx.chat.getSessionDebug(id, {
        ...(at ? { atMessageTimestamp: at } : {}),
        ...(limit && Number.isFinite(limit) && limit > 0 ? { messageContextLimit: limit } : {}),
      });
      return c.json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) return c.json({ error: message }, 404);
      throw err;
    }
  });

  app.post('/:id/send', async (c) => {
    const id = c.req.param('id');
    const body = SendToSessionRequestSchema.parse(await c.req.json());
    const cfg = await ctx.store.readConfig();
    if (!isEngagementAllowed(cfg)) {
      return c.json({ error: `engagement mode is ${getEngagementMode(cfg)}; AI is disabled` }, 403);
    }
    // Accept immediately; the live reply streams over /events/chat.
    // Mentioned gezels (if any) get the same verbatim user text in their
    // own session via the fan-out helper — no `from` metadata, so their
    // bubble renders as an ordinary user message. Nudge sends always
    // take the plain branch: the composer never combines a mid-turn
    // nudge with mention fan-out, and fanning out a nudge would engage
    // gezels on a message written to steer a turn they never ran.
    if (body.mentions && body.mentions.length > 0 && body.nudge !== true) {
      ctx.chat.trackBackground(
        ctx.chat
          .sendWithMentions({
            primarySessionId: id,
            text: body.message,
            mentionGezelIds: body.mentions,
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`[sessions] send-with-mentions failed for ${id}: ${message}`);
          }),
      );
    } else {
      ctx.chat.trackBackground(
        ctx.chat.send(id, body.message, body.nudge ? { nudge: true } : undefined).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`[sessions] send failed for ${id}: ${message}`);
        }),
      );
    }
    // Passive CC fan-out — drops a transcript-only ghost on each
    // listed gezel's session in the primary's project. No provider
    // call (the recipient sees a user-role bubble in their timeline
    // and that's it). Drives the project-chat voorman-CC pattern:
    // when the user @-mention-pivots into a non-voorman gezel, the
    // composer passes the voorman's id here so they still see the
    // message land in their queue without being engaged. Resolved
    // best-effort and fire-and-forget — if a CC target has been
    // deleted between client and server, log it and move on.
    if (body.passiveCcGezelIds && body.passiveCcGezelIds.length > 0) {
      ctx.chat.trackBackground(
        (async () => {
          const primary = await ctx.chat.getSessionRecord(id).catch(() => null);
          if (!primary) return;
          for (const ccId of body.passiveCcGezelIds!) {
            try {
              const ccSession = await ctx.chat.ensureOrCreateSession({
                gezelId: ccId,
                projectId: primary.projectId,
              });
              if (ccSession.id === id) continue;
              await ctx.chat.notifyUserMessage(ccSession.id, body.message);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.warn(`[sessions] passive CC to ${ccId} failed: ${message}`);
            }
          }
        })(),
      );
    }
    return c.json({ accepted: true, sessionId: id }, 202);
  });

  app.post('/:id/reset', async (c) => {
    await ctx.chat.reset(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/:id/inflight', async (c) => {
    const info = ctx.chat.inflightInfo(c.req.param('id'));
    return c.json({ inflight: info });
  });

  app.get('/:id/telemetry', (c) => {
    const telemetry = ctx.chat.sessionTelemetry(c.req.param('id'));
    return c.json({ telemetry });
  });

  app.post('/:id/cancel', async (c) => {
    const res = await ctx.chat.cancelInflight(c.req.param('id'));
    return c.json(res);
  });

  // Interrupt: cancel the in-flight turn (salvaged exactly like
  // /cancel) and run `message` immediately, ahead of any queued
  // entries. Same fire-and-forget 202 shape as /send — the reply
  // streams over /events/chat. On an idle session this degrades to a
  // plain send.
  app.post('/:id/interrupt', async (c) => {
    const id = c.req.param('id');
    const body = InterruptSessionRequestSchema.parse(await c.req.json());
    const cfg = await ctx.store.readConfig();
    if (!isEngagementAllowed(cfg)) {
      return c.json({ error: `engagement mode is ${getEngagementMode(cfg)}; AI is disabled` }, 403);
    }
    ctx.chat.trackBackground(
      ctx.chat.interruptWithMessage(id, body.message).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[sessions] interrupt failed for ${id}: ${message}`);
      }),
    );
    return c.json({ accepted: true, sessionId: id }, 202);
  });

  // Full-text snapshot of the session's pending queue — the ghost
  // bubbles' edit affordance loads from here (the SSE event only
  // carries a truncated preview). Lenient like the DELETE below:
  // an idle or unknown session returns an empty list.
  app.get('/:id/queue', (c) => {
    const sessionId = c.req.param('id');
    return c.json({ sessionId, entries: ctx.chat.listSessionQueue(sessionId) });
  });

  // Edit a queued entry in place (FIFO position preserved). 404 when
  // the entry already started or was discarded — the UI treats that
  // as "the moment passed" and drops its editor.
  app.patch('/:id/queue/:queueId', async (c) => {
    const sessionId = c.req.param('id');
    const queueId = c.req.param('queueId');
    const body = UpdateQueuedMessageRequestSchema.parse(await c.req.json());
    const entry = ctx.chat.updateQueuedMessage(sessionId, queueId, body.message);
    if (!entry) {
      return c.json({ error: 'queued message not found (already started or removed)' }, 404);
    }
    return c.json({ updated: true, entry });
  });

  // Drop a specific queued entry without running it. Used by the
  // in-bubble "Discard" action on ghost queue bubbles. Returns
  // `{cancelled: true}` when found + removed, `{cancelled: false}`
  // when the id didn't match (e.g. the entry already started).
  app.delete('/:id/queue/:queueId', async (c) => {
    const sessionId = c.req.param('id');
    const queueId = c.req.param('queueId');
    const cancelled = ctx.chat.cancelQueuedMessage(sessionId, queueId);
    return c.json({ cancelled });
  });

  app.post('/:id/archive', async (c) => {
    const id = c.req.param('id');
    const record = await ctx.chat.archiveSession(id);
    return c.json(record);
  });

  app.delete('/:id', async (c) => {
    await ctx.chat.deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
