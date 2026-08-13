import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { oauthClientSecretKey } from '../../connectors/oauth.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Bring-your-own OAuth apps. Gezel ships no OAuth client of its own (open
 * source — an embedded secret would be public, and X's quotas bill the app
 * owner), so each install registers its own developer app per provider and
 * records it here. Keys are the connector manifest's `clientIdEnv` name,
 * which shares one entry across types that name the same provider app.
 *
 * The client ID is public and lives in config.json; the client secret
 * (only where the provider requires one — PKCE public clients don't) goes
 * to the SecretStore and is never reflected back, only `hasSecret`.
 */

const KeySchema = z.string().regex(/^GEZEL_[A-Z0-9_]{1,120}$/);

const PutOAuthClientSchema = z.object({
  clientId: z.string().min(1).max(512),
  /** Provide to set/replace; explicit null clears; omit to leave unchanged. */
  clientSecret: z.string().min(1).max(2048).nullable().optional(),
});

export function oauthClientRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', requireFirstParty(), async (c) => {
    const config = await ctx.store.readConfig();
    const entries = Object.entries(config.oauthClients ?? {});
    const clients = await Promise.all(
      entries.map(async ([key, value]) => ({
        key,
        clientId: value.clientId,
        hasSecret: (await ctx.secrets.get(oauthClientSecretKey(key)).catch(() => null)) !== null,
      })),
    );
    return c.json({ clients });
  });

  app.put('/:key', requireFirstParty(), async (c) => {
    const key = KeySchema.parse(c.req.param('key'));
    const body = PutOAuthClientSchema.parse(await c.req.json());
    const config = await ctx.store.readConfig();
    await ctx.store.writeConfig({
      oauthClients: {
        ...(config.oauthClients ?? {}),
        [key]: { clientId: body.clientId.trim() },
      },
    });
    if (typeof body.clientSecret === 'string') {
      await ctx.secrets.set(oauthClientSecretKey(key), body.clientSecret);
    } else if (body.clientSecret === null) {
      await ctx.secrets.delete(oauthClientSecretKey(key)).catch(() => {});
    }
    await ctx.history
      ?.log({
        kind: 'config.credential.updated',
        summary: `OAuth app registered for ${key}`,
        details: { key },
      })
      .catch((err) => log.warn('[oauth-clients] history log failed:', err));
    return c.json({ ok: true });
  });

  app.delete('/:key', requireFirstParty(), async (c) => {
    const key = KeySchema.parse(c.req.param('key'));
    const config = await ctx.store.readConfig();
    if (config.oauthClients && key in config.oauthClients) {
      const { [key]: _removed, ...rest } = config.oauthClients;
      await ctx.store.writeConfig({ oauthClients: rest });
    }
    await ctx.secrets.delete(oauthClientSecretKey(key)).catch(() => {});
    return c.json({ ok: true });
  });

  return app;
}
