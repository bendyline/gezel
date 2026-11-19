import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { listEnvOAuthClients, oauthClientSecretKey } from '../../connectors/oauth.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Bring-your-own OAuth apps. Gezel has read-only apps of its own for Google
 * and Microsoft (`connectors/builtin-oauth-clients.ts`); everything else (X,
 * Meta, LinkedIn, whose quotas bill the app owner), anything those apps may
 * not ask for, and anyone who prefers their own, uses an app registered here.
 * A saved app wins over Gezel's. Keys are the connector manifest's
 * `clientIdEnv` name, which shares one entry across types that name the same
 * provider app.
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

  // An environment-supplied client wins over a saved one at connect time, so
  // the listing reports that one, marked `environment`, in the saved one's place.
  app.get('/', requireFirstParty(), async (c) => {
    const config = await ctx.store.readConfig();
    const fromEnv = listEnvOAuthClients();
    const envKeys = new Set(fromEnv.map((client) => client.key));
    const saved = await Promise.all(
      Object.entries(config.oauthClients ?? {})
        .filter(([key]) => !envKeys.has(key))
        .map(async ([key, value]) => ({
          key,
          clientId: value.clientId,
          hasSecret: (await ctx.secrets.get(oauthClientSecretKey(key)).catch(() => null)) !== null,
          source: 'settings' as const,
        })),
    );
    const clients = [
      ...saved,
      ...fromEnv.map((client) => ({ ...client, source: 'environment' as const })),
    ].sort((a, b) => a.key.localeCompare(b.key));
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
