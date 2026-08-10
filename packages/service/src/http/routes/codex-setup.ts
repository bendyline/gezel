import { ConfigureCodexRequestSchema } from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/** First-party administration of Gezel's isolated Codex profile. */
export function codexSetupRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // Editing ~/.codex and issuing a durable inference credential is an
  // administrative action. Ordinary product/CLI/session tokens admitted to
  // `/api/*` must not reach it.
  app.use('*', requireFirstParty());

  app.get('/', async (c) => c.json(await ctx.codexSetup.status()));

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
      const parsed = ConfigureCodexRequestSchema.safeParse(raw);
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
        return c.json(await ctx.codexSetup.configure(parsed.data));
      } catch (error) {
        return codexSetupError(c, error);
      }
    },
  );

  app.delete('/', async (c) => {
    try {
      return c.json(await ctx.codexSetup.remove());
    } catch (error) {
      return codexSetupError(c, error);
    }
  });

  return app;
}

function codexSetupError(c: Context, error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    candidate.status === 400 || candidate.status === 404 || candidate.status === 409
      ? candidate.status
      : 500;
  const code = typeof candidate.code === 'string' ? candidate.code : 'codex_setup_failed';
  const message =
    status < 500 && typeof candidate.message === 'string'
      ? candidate.message
      : 'Codex setup could not be changed.';
  return c.json({ error: code, message }, status);
}
