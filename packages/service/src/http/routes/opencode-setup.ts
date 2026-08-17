import {
  ConfigureOpenCodeRequestSchema,
  InstallOpenCodePluginRequestSchema,
} from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/** First-party administration of Gezel's managed OpenCode config. */
export function opencodeSetupRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // Issuing a durable inference credential is an administrative action.
  // Ordinary product/CLI/session tokens admitted to `/api/*` must not reach it.
  app.use('*', requireFirstParty());

  app.get('/', async (c) => c.json(await ctx.opencodeSetup.status()));

  app.put(
    '/',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, 400);
      }
      const parsed = ConfigureOpenCodeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid_request',
            message: parsed.error.issues.map((issue) => issue.message).join('; '),
          },
          400,
        );
      }
      try {
        return c.json(await ctx.opencodeSetup.configure(parsed.data));
      } catch (error) {
        return opencodeSetupError(c, error);
      }
    },
  );

  app.delete('/', async (c) => {
    try {
      return c.json(await ctx.opencodeSetup.remove());
    } catch (error) {
      return opencodeSetupError(c, error);
    }
  });

  // Writing into OpenCode's own config directory is its own decision, never a
  // side effect of choosing a model, so it gets its own verb pair.
  app.put(
    '/plugin',
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
    async (c) => {
      let raw: unknown = {};
      if ((c.req.header('content-length') ?? '0') !== '0') {
        try {
          raw = await c.req.json();
        } catch {
          return c.json({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, 400);
        }
      }
      const parsed = InstallOpenCodePluginRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid_request',
            message: parsed.error.issues.map((issue) => issue.message).join('; '),
          },
          400,
        );
      }
      try {
        return c.json(await ctx.opencodeSetup.installPlugin(parsed.data));
      } catch (error) {
        return opencodeSetupError(c, error);
      }
    },
  );

  app.delete('/plugin', async (c) => {
    try {
      return c.json(await ctx.opencodeSetup.removePlugin());
    } catch (error) {
      return opencodeSetupError(c, error);
    }
  });

  return app;
}

function opencodeSetupError(c: Context, error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    candidate.status === 400 || candidate.status === 404 || candidate.status === 409
      ? candidate.status
      : 500;
  const code = typeof candidate.code === 'string' ? candidate.code : 'opencode_setup_failed';
  const message =
    status < 500 && typeof candidate.message === 'string'
      ? candidate.message
      : 'OpenCode setup could not be changed.';
  return c.json({ error: code, message }, status);
}
