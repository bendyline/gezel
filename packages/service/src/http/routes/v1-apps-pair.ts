/**
 * `/v1/apps/pair/*` — pairing a device with a connect code, on the LAN
 * listener. The code is shown on this device (Settings → Remote Servers →
 * Add a device); the client proves it typed it with SPAKE2 (see
 * remotes/spake2.ts) instead of anyone clicking Approve here.
 *
 *   POST /v1/apps/pair/start   (unauth)  pA in, pB + session id out. Spends
 *                                        one of the code's attempts.
 *   POST /v1/apps/pair/finish  (unauth)  cA in; if it checks, cB and a
 *                                        `remote-inference` device token out.
 *
 * Unauthenticated like `/v1/apps/register`, and guarded the same way: no
 * browser requests, JSON only, rate-limited. The approval flow through
 * `/register` stays for clients that predate connect codes.
 */

import { fingerprintOfPublicKeyPem } from '@bendyline/gezel-inference/internal/remotes/identity';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { displayHostname } from '../../remotes/lan-discovery.js';
import {
  PairingAttemptsExhaustedError,
  PairingClosedError,
  PairingRejectedError,
  PairingShareInvalidError,
} from '../../remotes/pairing-code.js';
import type { EngineContext } from '../engine-context.js';
import { isReservedPublicGrantAppId } from '../token-store.js';

const StartRequestSchema = z.object({
  appId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  appName: z.string().min(1).max(120),
  deviceIdentityPubKey: z.string().max(4096),
  /** SPAKE2 pA, base64 SEC1. */
  share: z.string().max(200),
});

const FinishRequestSchema = z.object({
  sessionId: z.string().max(64),
  /** SPAKE2 cA, base64. */
  confirm: z.string().max(200),
});

export function v1AppsPairRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  const attempts: number[] = [];

  app.use(
    '*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  );
  app.use('*', async (c, next) => {
    if (c.req.header('origin') || c.req.header('sec-fetch-site')) {
      return c.json({ error: 'browser_pairing_not_allowed' }, 403);
    }
    const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return c.json({ error: 'content_type_must_be_application_json' }, 415);
    }
    const now = Date.now();
    while (attempts.length > 0 && attempts[0]! <= now - 60_000) attempts.shift();
    if (attempts.length >= 30) {
      return c.json({ error: 'pairing_rate_limited', retryAfterSeconds: 60 }, 429, {
        'Retry-After': '60',
      });
    }
    attempts.push(now);
    return next();
  });

  app.post('/start', async (c) => {
    const body = StartRequestSchema.parse(await c.req.json());
    if (isReservedPublicGrantAppId(body.appId)) {
      return c.json({ error: 'reserved_app_id' }, 400);
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintOfPublicKeyPem(body.deviceIdentityPubKey);
    } catch {
      return c.json({ error: 'invalid_device_identity' }, 400);
    }
    try {
      const run = ctx.pairingCodes.begin({
        share: Buffer.from(body.share, 'base64'),
        client: { appId: body.appId, appName: body.appName, fingerprint },
      });
      return c.json({ sessionId: run.sessionId, share: run.share.toString('base64') });
    } catch (err) {
      if (err instanceof PairingClosedError) return c.json({ error: 'pairing_closed' }, 409);
      if (err instanceof PairingAttemptsExhaustedError) {
        return c.json({ error: 'pairing_attempts_exhausted' }, 429);
      }
      if (err instanceof PairingShareInvalidError) return c.json({ error: 'invalid_share' }, 400);
      throw err;
    }
  });

  app.post('/finish', async (c) => {
    const body = FinishRequestSchema.parse(await c.req.json());
    let result: ReturnType<EngineContext['pairingCodes']['confirm']>;
    try {
      result = ctx.pairingCodes.confirm(body.sessionId, Buffer.from(body.confirm, 'base64'));
    } catch (err) {
      if (err instanceof PairingRejectedError) return c.json({ error: 'pairing_rejected' }, 403);
      throw err;
    }
    const { appId, appName } = result.client;
    const existing = ctx.tokenStore.list().find((record) => record.appId === appId);
    if (existing && existing.kind !== 'device') {
      return c.json({ error: 'app_id_in_use' }, 409);
    }
    // The code proves the person is at both devices, so it supersedes an
    // earlier pairing of the same device (one the client forgot) and any
    // approval request it left waiting.
    if (existing) await ctx.tokenStore.revoke(appId);
    for (const grant of ctx.grants.list()) {
      if (grant.appId === appId && grant.status === 'pending') {
        await ctx.grants.deny(grant.id).catch(() => undefined);
      }
    }
    const record = await ctx.tokenStore.issue({
      appId,
      appName,
      scopes: ['remote-inference'],
      kind: 'device',
      deviceId: appId,
    });
    return c.json({
      confirm: result.confirmB.toString('base64'),
      token: record.token,
      name: displayHostname(),
    });
  });

  return app;
}
