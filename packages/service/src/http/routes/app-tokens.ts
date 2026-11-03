import { Hono } from 'hono';
import { z } from 'zod';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { APP_GRANTABLE_SCOPES, isReservedPublicGrantAppId } from '../token-store.js';

/**
 * Mint an app's key directly, for a person who already decided: `gezel
 * integrations token create my-app` in a container's shell, where nobody is
 * watching Integrations to click Approve. It still goes through the grant
 * manager, so the key appears in Integrations and is revoked there like any
 * other. First-party callers only; paired-device grants keep their own flow.
 */
const CreateAppTokenSchema = z.object({
  appId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Use letters, digits, dots, dashes or colons.'),
  appName: z.string().min(1).max(128).optional(),
  scopes: z
    .array(
      z.enum(APP_GRANTABLE_SCOPES.filter((s) => s !== 'remote-inference') as [string, ...string[]]),
    )
    .min(1)
    .default(['openai']),
});

export function appTokenRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', requireFirstParty());

  app.post('/', async (c) => {
    const body = CreateAppTokenSchema.parse(await c.req.json());
    if (isReservedPublicGrantAppId(body.appId)) {
      return c.json(
        { error: 'reserved_app_id', message: 'That app id belongs to Gezel itself.' },
        400,
      );
    }
    if (ctx.tokenStore.list().some((r) => r.appId === body.appId)) {
      return c.json(
        {
          error: 'already_connected',
          message: `${body.appId} already has a key. Revoke it first to make a new one.`,
        },
        409,
      );
    }
    const { grant, verificationCode } = await ctx.grants.request({
      appId: body.appId,
      appName: body.appName ?? body.appId,
      scopes: body.scopes,
    });
    await ctx.grants.approve(grant.id, verificationCode);
    const token = await ctx.grants.consumeToken(grant.id);
    if (!token) return c.json({ error: 'not_issued', message: 'The key was not issued.' }, 500);
    c.header('cache-control', 'no-store');
    return c.json({ appId: body.appId, scopes: body.scopes, token }, 201);
  });

  app.delete('/:appId', async (c) => {
    const appId = c.req.param('appId');
    if (isReservedPublicGrantAppId(appId)) return c.json({ error: 'reserved_app_id' }, 400);
    return c.json({ revoked: await ctx.tokenStore.revoke(appId) });
  });

  return app;
}
