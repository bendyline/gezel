/**
 * `/api/remotes` — Device A's admin surface for the servers it has paired with
 * for remote model execution (first-party UI only; mounted under the `/api/*`
 * bearer-auth umbrella). Pair, list, and unpair; find servers announcing
 * themselves on the network; list the addresses this device is reachable at.
 * Tokens are never returned to the client — only `hasToken`.
 */

import { HttpsOriginSchema } from '@bendyline/gezel';
import {
  closePairedRemoteFetches,
  getPairedRemoteFetch,
} from '@bendyline/gezel-inference/internal/remotes/pinned-fetch';
import { Hono } from 'hono';
import { z } from 'zod';
import { listLanAddresses } from '../../remotes/lan-addresses.js';
import {
  type LanBrowser,
  createLanBrowser,
  lanDiscoveryEnabled,
} from '../../remotes/lan-discovery.js';
import {
  IdentityChangedError,
  PairingCodeAttemptsError,
  PairingCodeClosedError,
  PairingCodeRejectedError,
  PairingCodeUnsupportedError,
  inspectRemoteIdentity,
  normalizeRemoteBaseUrl,
  pairRemote,
  pairRemoteWithCode,
  remoteBaseUrlMatches,
} from '../../remotes/pairing.js';
import type { PairedRemote } from '../../remotes/registry.js';
import type { ServiceContext } from '../context.js';

const PairRequestSchema = z.object({
  baseUrl: HttpsOriginSchema,
  displayName: z.string().max(120).optional(),
  expectedIdentityFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  acceptIdentityChange: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().positive().max(600).optional(),
});

const PairWithCodeRequestSchema = z.object({
  baseUrl: HttpsOriginSchema,
  code: z.string().max(32),
  displayName: z.string().max(120).optional(),
});

function redact(
  r: PairedRemote,
): Omit<PairedRemote, 'token' | 'knownModels'> & { hasToken: boolean } {
  const { token, knownModels: _knownModels, ...rest } = r;
  return { ...rest, hasToken: Boolean(token) };
}

export function remotesRoutes(
  ctx: ServiceContext,
  opts: { lanBrowser?: LanBrowser | null } = {},
): Hono {
  const app = new Hono();
  // Opens a socket only while the Remote Servers panel polls (or a paired
  // server needs finding), and closes it a minute after the last use.
  const lanBrowser =
    opts.lanBrowser !== undefined
      ? opts.lanBrowser
      : ctx.lanBrowser !== undefined
        ? ctx.lanBrowser
        : lanDiscoveryEnabled()
          ? createLanBrowser()
          : null;

  // Status is what this daemon last saw. `?check=1` brings it up to date
  // first — the Remote Servers panel asks while it is open; the tracker
  // throttles the probes, so polling it costs at most one per server per
  // REMOTE_OFFLINE_RECHECK_MS.
  app.get('/', async (c) => {
    const reach = ctx.remoteReachability;
    if (reach && c.req.query('check') === '1') {
      await Promise.all(
        ctx.remotes
          .list()
          .filter((r) => !r.managed)
          .map((r) => reach.check(r.remoteId).catch(() => 'offline' as const)),
      );
    }
    return c.json({
      remotes: ctx.remotes.list().map((r) => {
        const seen = reach?.snapshot(r.remoteId);
        return {
          ...redact(r),
          status: seen?.status ?? 'unknown',
          ...(seen?.lastFailAt ? { lastFailAt: seen.lastFailAt } : {}),
        };
      }),
    });
  });

  app.get('/discover', async (c) => {
    if (!lanBrowser) return c.json({ available: false, servers: [] });
    const own = ctx.deviceIdentity?.fingerprint;
    const paired = ctx.remotes.list();
    const servers = (await lanBrowser.browse())
      .filter((server) => server.fingerprint !== own)
      .map((server) => {
        const match = paired.find((r) => r.pinnedIdentityFingerprint === server.fingerprint);
        // A paired server announcing a new address (DHCP gave it another
        // lease) is followed there once it proves its pinned identity.
        if (match) ctx.remoteReachability?.noteSighting(server.fingerprint, server.baseUrl);
        return match ? { ...server, pairedRemoteId: match.remoteId } : server;
      });
    return c.json({ available: true, servers });
  });

  // Every paired server's chat models for a picker, checked in parallel. An
  // unreachable server answers at once with its last-known models.
  app.get('/models', async (c) => {
    const remotes = ctx.remotes.list().filter((r) => !r.managed);
    const servers = await Promise.all(
      remotes.map(async (r) => ({
        remoteId: r.remoteId,
        displayName: r.displayName,
        ...(await ctx.chat.remoteModelsWithStatus(r.remoteId)),
      })),
    );
    return c.json({ servers });
  });

  app.get('/lan-addresses', (c) => c.json({ addresses: listLanAddresses() }));

  app.post('/inspect', async (c) => {
    const body = z.object({ baseUrl: HttpsOriginSchema }).parse(await c.req.json());
    const baseUrl = normalizeRemoteBaseUrl(body.baseUrl);
    const identity = await inspectRemoteIdentity(baseUrl);
    const existing = ctx.remotes
      .list()
      .find((remote) => remoteBaseUrlMatches(remote.baseUrl, baseUrl));
    return c.json({
      deviceId: identity.deviceId,
      fingerprint: identity.fingerprint,
      ...(existing ? { existingFingerprint: existing.pinnedIdentityFingerprint } : {}),
      identityChanged: Boolean(
        existing && existing.pinnedIdentityFingerprint !== identity.fingerprint,
      ),
      pairingMethods: identity.pairingMethods ?? ['approval'],
    });
  });

  app.post('/pair-with-code', async (c) => {
    const body = PairWithCodeRequestSchema.parse(await c.req.json());
    try {
      const paired = await pairRemoteWithCode(ctx, body);
      await closePairedRemoteFetches(ctx.remotes, paired.remoteId);
      return c.json({ remote: redact(paired) }, 201);
    } catch (err) {
      const refusal =
        err instanceof PairingCodeClosedError
          ? ({ error: 'pairing_closed', status: 409 } as const)
          : err instanceof PairingCodeAttemptsError
            ? ({ error: 'pairing_attempts_exhausted', status: 429 } as const)
            : err instanceof PairingCodeRejectedError
              ? ({ error: 'pairing_code_rejected', status: 403 } as const)
              : err instanceof PairingCodeUnsupportedError
                ? ({ error: 'pairing_code_unsupported', status: 409 } as const)
                : null;
      if (!refusal) throw err;
      return c.json({ error: refusal.error, message: (err as Error).message }, refusal.status);
    }
  });

  // Chat models a paired server offers, namespaced for A. Drives the picker.
  app.get('/:remoteId/models', async (c) => {
    const remoteId = c.req.param('remoteId');
    if (!ctx.remotes.get(remoteId)) return c.json({ error: 'not_found' }, 404);
    const { status, models } = await ctx.chat.remoteModelsWithStatus(remoteId);
    return c.json({ remoteId, status, models });
  });

  app.post('/pair', async (c) => {
    const body = PairRequestSchema.parse(await c.req.json());
    try {
      const paired = await pairRemote(ctx, body);
      return c.json({ remote: redact(paired) }, 201);
    } catch (err) {
      if (err instanceof IdentityChangedError) {
        return c.json(
          {
            error: 'identity_changed',
            oldFingerprint: err.oldFingerprint,
            newFingerprint: err.newFingerprint,
            hint: 'Re-POST with acceptIdentityChange:true to re-pin if you trust the change.',
          },
          409,
        );
      }
      throw err;
    }
  });

  app.delete('/:remoteId', async (c) => {
    const remoteId = c.req.param('remoteId');
    const remote = ctx.remotes.get(remoteId);
    if (!remote) return c.json({ error: 'not_found' }, 404);
    if (remote.managed) {
      return c.json(
        { error: 'managed_remote', hint: 'This connection is managed by the local service host.' },
        409,
      );
    }
    // Best-effort: ask B to revoke the token it issued us, so unpairing is
    // mutual. Failure (B offline) is non-fatal — we forget it locally anyway.
    // A service with no device identity never paired, so B holds no grant.
    const identity = ctx.deviceIdentity;
    if (identity) {
      try {
        const fetchImpl = getPairedRemoteFetch(remote, ctx.remotes);
        const response = await fetchImpl(`${remote.baseUrl}/v1/apps/${identity.deviceId}/token`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        await response?.body?.cancel().catch(() => {});
      } catch {
        // ignore — local removal is the source of truth for A.
      }
    }
    await ctx.remotes.remove(remoteId);
    await closePairedRemoteFetches(ctx.remotes, remoteId);
    return c.json({ ok: true });
  });

  return app;
}
