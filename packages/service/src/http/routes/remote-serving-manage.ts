/**
 * `/v1/remote/manage/serving` — LAN-serving administration for the daemon
 * that owns the listener. Its reason to exist is the machine-engine broker:
 * the broker has no UI and no `/api/config`, so this surface is the ONLY
 * reader/writer of the broker's own `remoteServing` key, reached from a user
 * daemon through the machine-engine proxy (`/api/machine-serving/*`).
 *
 * Mounted exclusively on the loopback app under the `machine-models` scope
 * umbrella (see server.ts) and never added to `isRemoteServingRoute`: LAN
 * peers must not reach their own admission policy, the pairing grant queue,
 * or the device roster.
 *
 * Authority note (deliberate, documented in security-architecture.md §14):
 * on system installs the `machine-models` credential is the runtime
 * discovery token every local account can read, so any local account can
 * enable serving, approve or deny LAN pairings, and revoke devices. That
 * matches the install's membership model — every local account is a trusted
 * first-party client — and narrows automatically when installer-managed
 * membership arrives. The scope stays never-grantable via /v1/apps/register.
 */

import { RemoteServingConfigSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { GrantExpiredError } from '../../grants/manager.js';
import type { ServiceContext } from '../context.js';

export function remoteServingManageRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // Serialize config read-modify-write + reconfigure so two managing user
  // daemons can't interleave a torn write. Semantics stay last-writer-wins,
  // consistent with the machine-shared metadata stance.
  let mutateChain: Promise<unknown> = Promise.resolve();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = mutateChain.then(fn, fn);
    mutateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const describe = async () => {
    const config = (await ctx.store.readConfig().catch(() => null))?.remoteServing;
    const status = ctx.remoteServing.status();
    return {
      // `enabled` reflects the actual listener, mirroring GET /api/config's
      // truth-over-config merge; the persisted flag can lag a failed bind.
      config: { ...(config ?? {}), enabled: status.listening },
      status,
      identity: {
        deviceId: ctx.deviceIdentity.deviceId,
        fingerprint: ctx.deviceIdentity.fingerprint,
      },
    };
  };

  app.get('/', async (c) => c.json(await describe()));

  app.put('/', async (c) => {
    const parsed = RemoteServingConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_remote_serving_config' }, 400);
    }
    const failure = await mutate(async (): Promise<string | null> => {
      const previous = (await ctx.store.readConfig().catch(() => null))?.remoteServing;
      const updated = await ctx.store.writeConfig({ remoteServing: parsed.data });
      try {
        await ctx.remoteServing.reconfigure(updated.remoteServing);
      } catch (err) {
        await ctx.store.writeConfig({ remoteServing: previous });
        await ctx.remoteServing.reconfigure(previous).catch(() => undefined);
        return err instanceof Error ? err.message : String(err);
      }
      ctx.remoteTenantLimits.setLimits(updated.remoteServing?.limits);
      return null;
    });
    if (failure !== null) {
      return c.json({ error: 'remote-serving-failed', message: failure }, 409);
    }
    return c.json(await describe());
  });

  app.get('/grants', async (c) => {
    await ctx.grants.sweepExpired();
    const grants = ctx.grants.list().filter((g) => g.kind === 'device');
    return c.json({
      grants: grants.map((g) => ({
        id: g.id,
        appId: g.appId,
        appName: g.appName,
        scopes: g.scopes,
        status: g.status,
        createdAt: g.createdAt,
        ...(g.decidedAt ? { decidedAt: g.decidedAt } : {}),
      })),
    });
  });

  // Device grants request only inference scopes, so no verification code is
  // in play; the richer /v1/apps error vocabulary collapses to three cases.
  app.post('/grants/:id/approve', async (c) => {
    const id = c.req.param('id');
    const pending = ctx.grants.list().find((g) => g.id === id);
    if (pending && pending.kind !== 'device') {
      return c.json({ error: 'grant_not_found' }, 404);
    }
    try {
      const grant = await ctx.grants.approve(id);
      return c.json({ ok: true, status: grant.status });
    } catch (err) {
      if (err instanceof GrantExpiredError) return c.json({ error: 'grant_expired' }, 410);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: 'grant_not_found' }, 404);
      return c.json({ error: msg }, 409);
    }
  });

  app.post('/grants/:id/deny', async (c) => {
    const id = c.req.param('id');
    const pending = ctx.grants.list().find((g) => g.id === id);
    if (pending && pending.kind !== 'device') {
      return c.json({ error: 'grant_not_found' }, 404);
    }
    try {
      const grant = await ctx.grants.deny(id);
      return c.json({ ok: true, status: grant.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: 'grant_not_found' }, 404);
      return c.json({ error: msg }, 409);
    }
  });

  app.get('/devices', async (c) => {
    const devices = ctx.tokenStore
      .list()
      .filter((r) => r.kind === 'device')
      .map((r) => ({
        appId: r.appId,
        appName: r.appName,
        scopes: r.scopes,
        createdAt: r.createdAt,
        ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
        ...(r.deviceId ? { deviceId: r.deviceId } : {}),
      }));
    return c.json({ devices });
  });

  app.delete('/devices/:appId', async (c) => {
    const appId = c.req.param('appId');
    // The kind check is load-bearing: an unguarded revoke of the ephemeral
    // `machine-engine-client` bridge credential would 401 every user
    // daemon's bridge until the broker restarts.
    const record = ctx.tokenStore.list().find((r) => r.appId === appId);
    if (!record || record.kind !== 'device') {
      return c.json({ error: 'device_not_found' }, 404);
    }
    await ctx.tokenStore.revoke(appId);
    return c.json({ ok: true });
  });

  return app;
}
