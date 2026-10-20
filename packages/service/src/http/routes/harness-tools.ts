import {
  HarnessBlockSchema,
  HarnessClientIdSchema,
  HarnessToolsConfigUpdateSchema,
  HarnessToolsSetupRequestSchema,
} from '@bendyline/gezel';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/**
 * Settings → Integrations for Gezel's tools in other AI apps. Editing other
 * apps' configuration and revoking their tokens is the person's act, so every
 * route but the launch command is first-party only. The VS Code extension's
 * own `product` grant may read the launch command, which it hands to VS Code
 * as the tools server for the workspace it has open.
 */
export function harnessToolsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const firstParty = requireFirstParty();
  const limit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  });

  const launcherAccess: MiddlewareHandler = async (c, next) => {
    const auth = c.get('auth');
    if (auth && ['root', 'ui', 'product'].some((scope) => auth.scopes.includes(scope))) {
      return next();
    }
    return c.json({ error: 'missing_scope:first-party' }, 403);
  };

  app.get('/launcher', launcherAccess, async (c) => {
    const client = HarnessClientIdSchema.safeParse(c.req.query('client'));
    if (!client.success) return c.json({ error: 'invalid_client' }, 400);
    const projectId = c.req.query('projectId') || undefined;
    const spec = await ctx.harnessTools.launchSpec(client.data, projectId);
    if (!spec) {
      return c.json(
        { error: 'no_node', message: 'Gezel could not find Node.js to run its tools.' },
        503,
      );
    }
    return c.json(spec);
  });

  app.get('/', firstParty, async (c) => c.json(await ctx.harnessTools.status()));

  app.put('/config', firstParty, limit, async (c) => {
    const body = await parseBody(c, HarnessToolsConfigUpdateSchema);
    if ('error' in body) return body.error;
    return c.json(await ctx.harnessTools.updateConfig(body.data));
  });

  app.put('/clients/:client', firstParty, limit, async (c) => {
    const client = HarnessClientIdSchema.safeParse(c.req.param('client'));
    if (!client.success) return c.json({ error: 'invalid_client' }, 400);
    const body = await parseBody(c, HarnessToolsSetupRequestSchema);
    if ('error' in body) return body.error;
    try {
      return c.json(await ctx.harnessTools.configure(client.data, body.data));
    } catch (error) {
      return setupError(c, error);
    }
  });

  app.delete('/clients/:client', firstParty, async (c) => {
    const client = HarnessClientIdSchema.safeParse(c.req.param('client'));
    if (!client.success) return c.json({ error: 'invalid_client' }, 400);
    try {
      return c.json(await ctx.harnessTools.remove(client.data));
    } catch (error) {
      return setupError(c, error);
    }
  });

  app.post('/connections/:appId/stop', firstParty, async (c) => {
    try {
      return c.json(await ctx.harnessTools.stopConnection(c.req.param('appId')));
    } catch (error) {
      return setupError(c, error);
    }
  });

  app.post('/blocked/remove', firstParty, limit, async (c) => {
    const body = await parseBody(c, HarnessBlockSchema);
    if ('error' in body) return body.error;
    return c.json(await ctx.harnessTools.unblock(body.data));
  });

  return app;
}

async function parseBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<{ data: z.infer<T> } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      error: c.json({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, 400),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: c.json(
        {
          error: 'invalid_request',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
        400,
      ),
    };
  }
  return { data: parsed.data };
}

function setupError(c: Context, error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    candidate.status === 400 || candidate.status === 404 || candidate.status === 409
      ? candidate.status
      : 500;
  const code = typeof candidate.code === 'string' ? candidate.code : 'harness_tools_failed';
  const message =
    status < 500 && typeof candidate.message === 'string'
      ? candidate.message
      : 'Gezel could not change this app.';
  return c.json({ error: code, message }, status);
}
