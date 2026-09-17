import {
  APP_TOOL_MAX_RESULT_CHARS,
  AppToolCallResultRequestSchema,
  OpenAppToolRelayRequestSchema,
  RegisterAppToolsRequestSchema,
  createLogger,
} from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AppToolRelayError } from '../../app-tools/relay-registry.js';
import type { ServiceContext } from '../context.js';
import { serializeSseWrites } from './chat-events.js';

const log = createLogger('app-tools');

/**
 * `/api/app-tools` — tools a connected app runs on the daemon's behalf.
 *
 * The shape is: open a relay, hold its event stream, declare tools against a
 * project, answer the calls that arrive. Everything is scoped to the calling
 * app's identity, so one app can neither see nor answer another's calls.
 *
 * A **session-scoped** token is refused outright. Those belong to a gezel's
 * own MCP subprocess, and a gezel that could register tools could hand itself
 * any capability it liked, with the user's approval attached to something else
 * entirely.
 */
export function appToolRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const relays = ctx.appToolRelays;

  app.use('*', async (c, next) => {
    const auth = c.get('auth');
    if (auth?.scopes.includes('session')) {
      return c.json(
        { error: 'session tokens cannot register app tools', code: 'session_scope_not_allowed' },
        403,
      );
    }
    await next();
  });

  /**
   * Resolve a relay this caller owns, or the response that explains why not.
   * A relay belonging to another app reports `relay_not_found`: whether some
   * other app holds that id is not this caller's business.
   */
  const ownRelay = (c: Context): string | null => {
    const relayId = c.req.param('relayId');
    const auth = c.get('auth');
    if (!relayId || !relays.has(relayId)) return null;
    const owner = relays.ownerOf(relayId);
    const privileged = auth?.scopes.includes('root') || auth?.scopes.includes('ui');
    if (owner !== auth?.appId && !privileged) return null;
    return relayId;
  };

  const notFound = { error: 'tool relay not found', code: 'relay_not_found' } as const;

  app.post('/relays', async (c) => {
    const auth = c.get('auth');
    const body = OpenAppToolRelayRequestSchema.parse(await c.req.json().catch(() => ({})));
    try {
      const { relayId } = relays.open({
        appId: auth?.appId ?? 'unknown',
        ...(auth?.appName ? { appName: auth.appName } : {}),
        ...(body.label ? { label: body.label } : {}),
      });
      const limits = relays.limits;
      return c.json(
        {
          relayId,
          appId: auth?.appId ?? 'unknown',
          graceMs: limits.graceMs,
          heartbeatMs: limits.heartbeatMs,
          maxPendingCalls: limits.maxPendingCalls,
        },
        201,
      );
    } catch (err) {
      if (err instanceof AppToolRelayError) {
        return c.json({ error: err.message, code: err.code }, 429);
      }
      throw err;
    }
  });

  app.get('/relays', (c) => {
    const auth = c.get('auth');
    const privileged = auth?.scopes.includes('root') || auth?.scopes.includes('ui');
    return c.json({
      relays: relays.listRelays(privileged ? undefined : { appId: auth?.appId ?? 'unknown' }),
    });
  });

  app.get('/relays/:relayId/events', (c) => {
    const relayId = ownRelay(c);
    if (!relayId) return c.json(notFound, 404);
    const heartbeatMs = relays.limits.heartbeatMs;
    return streamSSE(c, async (stream) => {
      let closed = false;
      let releaseClose: (() => void) | undefined;
      const closeSignal = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const write = serializeSseWrites((frame: { event?: string; data: string }) =>
        stream.writeSSE(frame),
      );
      const attachment = relays.attachStream(relayId, {
        write: async (event) => {
          await write({ data: JSON.stringify(event) });
          if (event.type === 'closed') close();
        },
      });
      function close(): void {
        if (closed) return;
        closed = true;
        attachment.detach();
        releaseClose?.();
      }
      stream.onAbort(close);

      while (!closed) {
        await Promise.race([stream.sleep(heartbeatMs), closeSignal]);
        if (closed) break;
        try {
          await write({ event: 'ping', data: '' });
        } catch {
          // The app's process went away without closing the stream. Its
          // registration now runs on the grace window like any other drop.
          if (!closed) log.info(`relay=${relayId} stream ping failed (app connection lost)`);
          close();
        }
      }
      close();
    });
  });

  app.put('/relays/:relayId/tools', async (c) => {
    const relayId = ownRelay(c);
    if (!relayId) return c.json(notFound, 404);
    const body = RegisterAppToolsRequestSchema.parse(await c.req.json());
    const project = await ctx.store.getProject(body.projectId);
    if (!project) {
      return c.json(
        { error: `project ${body.projectId} not found`, code: 'project_not_found' },
        404,
      );
    }
    for (const gezelId of body.gezelIds ?? []) {
      if (!(await ctx.store.getGezel(gezelId))) {
        return c.json({ error: `gezel ${gezelId} not found`, code: 'gezel_not_found' }, 404);
      }
    }
    try {
      const result = relays.register(relayId, body);
      return c.json({ ok: true as const, ...result });
    } catch (err) {
      if (err instanceof AppToolRelayError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });

  app.delete('/relays/:relayId/tools', (c) => {
    const relayId = ownRelay(c);
    if (!relayId) return c.json(notFound, 404);
    const projectId = c.req.query('projectId');
    relays.unregister(relayId, projectId);
    return c.json({ ok: true as const });
  });

  app.post('/relays/:relayId/calls/:callId/result', async (c) => {
    const relayId = ownRelay(c);
    if (!relayId) return c.json(notFound, 404);
    const body = AppToolCallResultRequestSchema.parse(await c.req.json());
    if (body.ok && resultLength(body.content) > APP_TOOL_MAX_RESULT_CHARS) {
      // Tell the app rather than truncating silently: a result the model sees
      // half of is worse than one the app knows it has to summarize.
      return c.json(
        {
          error: `tool result exceeds ${APP_TOOL_MAX_RESULT_CHARS} characters`,
          code: 'result_too_large',
        },
        413,
      );
    }
    const outcome = relays.resolveCall(relayId, c.req.param('callId') ?? '', body);
    if (outcome === 'unknown') {
      return c.json(
        { error: 'no tool call is waiting for this result', code: 'unknown_call' },
        404,
      );
    }
    return c.json({ ok: true as const });
  });

  app.delete('/relays/:relayId', (c) => {
    const relayId = ownRelay(c);
    if (!relayId) return c.json(notFound, 404);
    relays.close(relayId, 'app_closed');
    return c.json({ ok: true as const });
  });

  return app;
}

function resultLength(
  content: string | Array<{ type: string; text?: string; data?: string }>,
): number {
  if (typeof content === 'string') return content.length;
  return content.reduce(
    (total, block) => total + (block.text?.length ?? block.data?.length ?? 0),
    0,
  );
}
