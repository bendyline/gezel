import { ConfigureVSCodeRequestSchema } from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/** First-party administration of VS Code's built-in custom-endpoint entry. */
export function vscodeSetupRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', requireFirstParty());
  app.get('/', async (c) => c.json(await ctx.vscodeSetup.status()));
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
      const parsed = ConfigureVSCodeRequestSchema.safeParse(raw);
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
        return c.json(await ctx.vscodeSetup.configure(parsed.data));
      } catch (error) {
        return vscodeSetupError(c, error);
      }
    },
  );
  app.delete('/', async (c) => {
    try {
      return c.json(await ctx.vscodeSetup.remove());
    } catch (error) {
      return vscodeSetupError(c, error);
    }
  });
  return app;
}

function vscodeSetupError(c: Context, error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    candidate.status === 400 || candidate.status === 404 || candidate.status === 409
      ? candidate.status
      : 500;
  const code = typeof candidate.code === 'string' ? candidate.code : 'vscode_setup_failed';
  const message =
    status < 500 && typeof candidate.message === 'string'
      ? candidate.message
      : 'VS Code setup could not be changed.';
  return c.json({ error: code, message }, status);
}
