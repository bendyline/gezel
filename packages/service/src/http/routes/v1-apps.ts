import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  GrantExpiredError,
  type GrantRequest,
  InvalidVerificationCodeError,
  PendingGrantExistsError,
  TooManyPendingGrantsError,
  VerificationAttemptsExceededError,
  VerificationCodeRequiredError,
} from '../../grants/manager.js';
import { bearerAuth, requireFirstParty } from '../auth.js';
import type { EngineContext } from '../engine-context.js';
import {
  APP_GRANTABLE_SCOPES,
  ReservedPublicGrantAppIdError,
  isReservedPublicGrantAppId,
} from '../token-store.js';

/**
 * `/v1/apps` — third-party app registration + consent flow.
 *
 * This router is intentionally NOT gated by a global `bearerAuth` mount.
 * Some endpoints must be reachable without a token (an app that doesn't
 * have one yet calls `register` and polls `grant/:id`), and others
 * require either the per-app token (self-revoke) or first-party root/UI scope (UI
 * listing + admin approve/deny). Auth is therefore declared per-route
 * using {@link bearerAuth} as inline middleware.
 *
 * Endpoint map:
 *
 *   POST /v1/apps/register              (unauth)  Open a new grant request.
 *   GET  /v1/apps/grant/:id             (unauth)  One-shot status check
 *                                                 (or long-poll with ?wait=).
 *   GET  /v1/apps/grant/:id/events      (unauth)  SSE: status updates.
 *   GET  /v1/apps                       (root/ui) List all known apps
 *                                                 (decided grants + live
 *                                                 tokens). Settings UI.
 *   POST /v1/apps/grant/:id/approve     (root/ui) User-driven approval.
 *   POST /v1/apps/grant/:id/deny        (root/ui) User-driven denial.
 *   DELETE /v1/apps/:appId/token        (root/ui  Revoke an issued token.
 *                                        own app) An app can revoke
 *                                                 itself; the UI can
 *                                                 revoke any app.
 */
const RegisterRequestSchema = z.object({
  appId: z
    .string()
    .min(1, 'appId must be non-empty')
    .max(64, 'appId must be 64 characters or fewer')
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'appId must be alphanumeric (plus . _ -)'),
  appName: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1)).min(1).max(16),
  /** Opt into requester-code verification for otherwise inference-only scopes. */
  requireVerificationCode: z.boolean().optional(),
  iconUrl: z.string().url().optional(),
  /** `'device'` for the remote-model-execution pairing flow. */
  kind: z.enum(['app', 'device']).optional(),
  /** Paired device's identity public key (SPKI PEM), pinned by the peer. */
  deviceIdentityPubKey: z.string().max(4096).optional(),
});

const ApproveRequestSchema = z.object({
  verificationCode: z.string().max(32).optional(),
});

/**
 * Public projection of a grant returned to the polling app. Mirrors the
 * internal {@link GrantRequest} except the `token` is only set on the
 * approved branch (which is the whole point of the poll for the app).
 */
interface GrantPollResponse {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  appId: string;
  appName: string;
  scopes: string[];
  /** Bearer token — present only when status === 'approved'. */
  token?: string;
}

function toPollResponse(grant: GrantRequest, token?: string | null): GrantPollResponse {
  const base: GrantPollResponse = {
    id: grant.id,
    status: grant.status,
    appId: grant.appId,
    appName: grant.appName,
    scopes: grant.scopes,
  };
  if (token) base.token = token;
  return base;
}

export function v1AppsRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  const auth = bearerAuth(ctx.tokenStore);
  const firstParty = requireFirstParty();
  const registerAttempts: number[] = [];

  /**
   * Open a new grant request. The app supplies its identity (`appId`,
   * `appName`) and the scope set it needs. If an app with the same
   * `appId` already has a token, returns 409 — the app must
   * explicitly call `DELETE /v1/apps/:appId/token` first to rotate.
   *
   * When `GEZEL_AUTOAPPROVE_APPS` lists `appId`, the grant arrives
   * already `approved` and the response carries the token immediately
   * — the polling round-trip is still safe, but unnecessary.
   */
  app.post(
    '/register',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
    async (c) => {
      // Grant registration is a native-app/device handshake, not a browser
      // API. Reject browser-shaped requests before parsing the body. This
      // closes drive-by registration via cross-origin fetch/forms while
      // leaving CLI, desktop, and service-to-service clients unchanged.
      if (c.req.header('origin') || c.req.header('sec-fetch-site')) {
        return c.json({ error: 'browser_registration_not_allowed' }, 403);
      }
      const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return c.json({ error: 'content_type_must_be_application_json' }, 415);
      }
      const now = Date.now();
      while (registerAttempts.length > 0 && registerAttempts[0]! <= now - 60_000) {
        registerAttempts.shift();
      }
      if (registerAttempts.length >= 20) {
        return c.json({ error: 'registration_rate_limited', retryAfterSeconds: 60 }, 429, {
          'Retry-After': '60',
        });
      }
      registerAttempts.push(now);
      await ctx.grants.sweepExpired(now);
      const body = RegisterRequestSchema.parse(await c.req.json());

      // Only grantable scopes may be requested — reject reserved (`root`,
      // `ui`) or unknown scopes with an actionable message rather than minting
      // a token carrying a scope that means nothing.
      const ungrantable = body.scopes.filter(
        (s) => !(APP_GRANTABLE_SCOPES as readonly string[]).includes(s),
      );
      if (ungrantable.length > 0) {
        return c.json(
          {
            error: 'invalid_scope',
            hint: `These scopes can't be granted to an app: ${ungrantable.join(', ')}. Valid app scopes: ${APP_GRANTABLE_SCOPES.join(', ')}.`,
          },
          400,
        );
      }

      if (isReservedPublicGrantAppId(body.appId)) {
        return c.json(
          {
            error: 'reserved_app_id',
            hint: 'This appId is reserved for a Gezel-managed integration.',
          },
          400,
        );
      }

      // The Connected Apps switch disables only the public OpenAI facade.
      // Registration is also the consent waist for CLI/product/device
      // clients, so gating the whole route makes those unrelated clients
      // disappear with the inference switch. Reject only grants that would
      // authorize the disabled facade.
      if (body.scopes.includes('openai')) {
        const config = await ctx.store
          .readConfig()
          .catch(() => ({}) as { openaiEndpoints?: { enabled?: boolean } });
        if (config.openaiEndpoints?.enabled === false) {
          return c.json(
            {
              error: {
                message:
                  'OpenAI-compatible endpoints are turned off in Gezel. Enable them under Settings → Connected Apps.',
                type: 'invalid_request_error',
                code: 'openai_endpoints_disabled',
              },
            },
            403,
          );
        }
      }

      if (ctx.tokenStore.list().some((r) => r.appId === body.appId)) {
        return c.json(
          {
            error: 'already_connected',
            hint: "DELETE /v1/apps/:appId/token first to rotate this app's token",
          },
          409,
        );
      }

      let grant: GrantRequest;
      let verificationCode: string | undefined;
      try {
        const created = await ctx.grants.request({
          appId: body.appId,
          appName: body.appName,
          scopes: body.scopes,
          ...(body.requireVerificationCode ? { requireVerificationCode: true } : {}),
          ...(body.iconUrl ? { iconUrl: body.iconUrl } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.deviceIdentityPubKey ? { deviceIdentityPubKey: body.deviceIdentityPubKey } : {}),
        });
        grant = created.grant;
        verificationCode = created.verificationCode;
      } catch (error) {
        if (error instanceof ReservedPublicGrantAppIdError) {
          return c.json(
            {
              error: 'reserved_app_id',
              hint: 'This appId is reserved for a Gezel-managed integration.',
            },
            400,
          );
        }
        if (error instanceof PendingGrantExistsError) {
          return c.json({ error: 'grant_already_pending' }, 409);
        }
        if (error instanceof TooManyPendingGrantsError) {
          return c.json({ error: 'too_many_pending_grants' }, 429);
        }
        throw error;
      }

      const token = grant.status === 'approved' ? await ctx.grants.consumeToken(grant.id) : null;

      return c.json(
        {
          grantRequestId: grant.id,
          status: grant.status,
          ...(token ? { token } : {}),
          ...(verificationCode ? { verificationRequired: true, verificationCode } : {}),
        },
        201,
      );
    },
  );

  /**
   * Poll for grant status. Default behavior is one-shot (returns
   * current state immediately). When `?wait=<seconds>` is set
   * (1..30), holds the connection open until the status changes or
   * the timeout elapses — saves the SDK from a tight poll loop.
   *
   * The status field tells the caller what to do next:
   *   pending  → poll again or open the SSE stream.
   *   approved → read `token`, stash it, hit `/v1/chat/completions`.
   *   denied   → surface "user declined" to the human running the app.
   */
  app.get('/grant/:id', async (c) => {
    await ctx.grants.sweepExpired();
    const id = c.req.param('id');
    const grant = ctx.grants.get(id);
    if (!grant) return c.json({ error: 'grant_not_found' }, 404);

    if (grant.status !== 'pending') {
      const token = await ctx.grants.consumeToken(id);
      return c.json(toPollResponse(grant, token));
    }

    const waitParam = c.req.query('wait');
    const wait = waitParam ? Math.min(30, Math.max(1, Number.parseInt(waitParam, 10) || 0)) : 0;
    if (wait === 0) {
      return c.json(toPollResponse(grant));
    }

    // Long-poll. Subscribe to manager events; resolve on the first
    // decision OR after `wait` seconds. The subscription auto-cleans
    // up via the unsubscribe call.
    const decided = await new Promise<GrantRequest | null>((resolve) => {
      let resolved = false;
      const finish = (value: GrantRequest | null): void => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = ctx.grants.subscribe((event) => {
        if (event.type === 'grant_decided' && event.grant.id === id) {
          finish(event.grant);
        }
      });
      const timer = setTimeout(() => finish(null), wait * 1000);
    });

    const final = decided ?? ctx.grants.get(id);
    if (!final) return c.json({ error: 'grant_not_found' }, 404);
    const token = await ctx.grants.consumeToken(id);
    return c.json(toPollResponse(final, token));
  });

  /**
   * SSE companion to the long-poll. Emits `data: <GrantPollResponse>`
   * on every status change for the target grant; closes itself once
   * the grant reaches a decided state.
   *
   * Apps that prefer push to poll subscribe here right after
   * `register`. The initial emit carries the current status so the
   * client sees the same shape regardless of whether the connection
   * raced the decision.
   */
  app.get('/grant/:id/events', async (c) => {
    await ctx.grants.sweepExpired();
    const id = c.req.param('id');
    const grant = ctx.grants.get(id);
    if (!grant) return c.json({ error: 'grant_not_found' }, 404);

    return streamSSE(c, async (stream) => {
      let closed = false;
      const send = async (g: GrantRequest): Promise<void> => {
        let token: string | null = null;
        try {
          token = await ctx.grants.consumeToken(g.id);
          await stream.writeSSE({ data: JSON.stringify(toPollResponse(g, token)) });
        } catch {
          // If the socket dies after the one-time claim, do not leave an
          // active credential that no caller can retrieve. The app may safely
          // register again because its token record is gone.
          if (token) await ctx.tokenStore.revoke(g.appId).catch(() => false);
          closed = true;
        }
      };

      const initial = ctx.grants.get(id);
      if (initial) await send(initial);
      // If the grant was already decided before the client connected,
      // emit once and close — no further events are coming.
      if (initial && initial.status !== 'pending') return;

      const unsubscribe = ctx.grants.subscribe((event) => {
        if (event.type !== 'grant_decided') return;
        if (event.grant.id !== id) return;
        void send(event.grant).then(() => {
          closed = true;
        });
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      // Keepalive pings so intermediaries don't kill the idle TCP.
      while (!closed) {
        await stream.sleep(1000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  /**
   * UI roster: every app with a live token plus every decided grant.
   * Drives the Settings → Connected Apps view. Root-only because the
   * response carries appName + scopes for every connected app.
   */
  app.get('/', auth, firstParty, async (c) => {
    await ctx.grants.sweepExpired();
    const tokens = ctx.tokenStore.list().filter((r) => r.appId !== 'root');
    const grants = ctx.grants.list();
    return c.json({
      apps: tokens.map((rec) => ({
        appId: rec.appId,
        appName: rec.appName,
        scopes: rec.scopes,
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt,
        ...(rec.kind ? { kind: rec.kind } : {}),
      })),
      grants: grants.map((g) => ({
        id: g.id,
        appId: g.appId,
        appName: g.appName,
        scopes: g.scopes,
        ...(g.iconUrl ? { iconUrl: g.iconUrl } : {}),
        status: g.status,
        createdAt: g.createdAt,
        ...(g.decidedAt ? { decidedAt: g.decidedAt } : {}),
        ...(g.kind ? { kind: g.kind } : {}),
        ...(g.verificationRequired ? { verificationRequired: true } : {}),
      })),
    });
  });

  /**
   * UI approval. Issues the per-app token and transitions the grant
   * to `approved`. The polling app picks the new token off the
   * corresponding `GET /grant/:id` or its SSE stream.
   */
  app.post('/grant/:id/approve', auth, firstParty, async (c) => {
    const id = c.req.param('id');
    let body: z.infer<typeof ApproveRequestSchema>;
    try {
      const parsed =
        c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
          ? await c.req.json()
          : {};
      body = ApproveRequestSchema.parse(parsed);
    } catch {
      return c.json({ error: 'invalid_approval_request' }, 400);
    }
    try {
      const grant = await ctx.grants.approve(id, body.verificationCode);
      return c.json({ ok: true, grant: toPollResponse(grant) });
    } catch (err) {
      if (err instanceof ReservedPublicGrantAppIdError) {
        return c.json({ error: 'reserved_app_id' }, 409);
      }
      if (err instanceof GrantExpiredError) {
        return c.json({ error: 'grant_expired' }, 410);
      }
      if (err instanceof VerificationCodeRequiredError) {
        return c.json({ error: 'verification_code_required' }, 400);
      }
      if (err instanceof InvalidVerificationCodeError) {
        return c.json(
          {
            error: 'verification_code_invalid',
            attemptsRemaining: err.attemptsRemaining,
          },
          403,
        );
      }
      if (err instanceof VerificationAttemptsExceededError) {
        return c.json({ error: 'verification_attempts_exceeded' }, 429);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: 'grant_not_found' }, 404);
      return c.json({ error: msg }, 409);
    }
  });

  /** UI denial. Flips the grant to `denied`; no token is issued. */
  app.post('/grant/:id/deny', auth, firstParty, async (c) => {
    const id = c.req.param('id');
    try {
      const grant = await ctx.grants.deny(id);
      return c.json({ ok: true, grant: toPollResponse(grant) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: 'grant_not_found' }, 404);
      return c.json({ error: msg }, 409);
    }
  });

  /**
   * Revoke an app's token. Two valid callers:
   *   - The app itself (token in Authorization header matches `appId`).
   *   - The UI on behalf of the user (root scope).
   * Returns 404 when no such app, 403 when someone else's app is
   * targeted without root scope.
   */
  app.delete('/:appId/token', auth, async (c) => {
    const appId = c.req.param('appId');
    const callerAuth = c.get('auth');
    const isOwn = callerAuth?.appId === appId;
    const isFirstParty = (callerAuth?.scopes ?? []).some((s) => s === 'root' || s === 'ui');
    if (!isOwn && !isFirstParty) {
      return c.json({ error: 'missing_scope:first-party' }, 403);
    }
    const removed = await ctx.tokenStore.revoke(appId);
    if (!removed) return c.json({ error: 'app_not_found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
