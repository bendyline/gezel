/**
 * `/api/remotes` — Device A's admin surface for the servers it has paired with
 * for remote model execution (first-party UI only; mounted under the `/api/*`
 * bearer-auth umbrella). Pair, list, and unpair. Tokens are never returned to
 * the client — only `hasToken`.
 */

import { HttpsOriginSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  IdentityChangedError,
  inspectRemoteIdentity,
  normalizeRemoteBaseUrl,
  pairRemote,
  remoteBaseUrlMatches,
} from '../../remotes/pairing.js';
import { closePairedRemoteFetches, getPairedRemoteFetch } from '../../remotes/pinned-fetch.js';
import type { PairedRemote } from '../../remotes/registry.js';
import type { ServiceContext } from '../context.js';

const PairRequestSchema = z.object({
  baseUrl: HttpsOriginSchema,
  displayName: z.string().max(120).optional(),
  expectedIdentityFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  acceptIdentityChange: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().positive().max(600).optional(),
});

function redact(r: PairedRemote): Omit<PairedRemote, 'token'> & { hasToken: boolean } {
  const { token, ...rest } = r;
  return { ...rest, hasToken: Boolean(token) };
}

export function remotesRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json({ remotes: ctx.remotes.list().map(redact) }));

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
    });
  });

  // Chat models a paired server offers, namespaced for A. Drives the picker.
  app.get('/:remoteId/models', async (c) => {
    const remoteId = c.req.param('remoteId');
    if (!ctx.remotes.get(remoteId)) return c.json({ error: 'not_found' }, 404);
    const models = await ctx.chat.listRemoteModels(remoteId);
    return c.json({ remoteId, models });
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
    try {
      const fetchImpl = getPairedRemoteFetch(remote, ctx.remotes);
      const response = await fetchImpl(
        `${remote.baseUrl}/v1/apps/${ctx.deviceIdentity.deviceId}/token`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(10_000),
        },
      ).catch(() => null);
      await response?.body?.cancel().catch(() => {});
    } catch {
      // ignore — local removal is the source of truth for A.
    }
    await ctx.remotes.remove(remoteId);
    await closePairedRemoteFetches(ctx.remotes, remoteId);
    return c.json({ ok: true });
  });

  return app;
}
