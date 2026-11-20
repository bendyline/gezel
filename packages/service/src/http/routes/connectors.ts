/**
 * Connector routes, mounted under /api/projects so URLs resolve as
 * `/api/projects/:id/connectors/*`. Binding a source and triggering a sync are
 * user-initiated actions (like a mailbox link), so they aren't gated by the
 * autonomous `allowExternalServices` posture — that gates the background loop.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { ConnectorPolicyError } from '../../connectors/manager.js';
import { isFirstPartyCaller } from '../auth.js';
import type { ServiceContext } from '../context.js';

/**
 * Whether the person asked for this commit just now: they pressed Approve in
 * the app, or the gezel session committing is running a turn they started.
 * Every other caller (a scheduled or night-shift turn, a nudge, another
 * gezel's request, an app's grant) is unattended, and its commit holds for
 * approval.
 */
function commitIsAttended(ctx: ServiceContext, c: Context): boolean {
  if (isFirstPartyCaller(c)) return true;
  const auth = c.get('auth');
  if (!auth?.scopes.includes('session') || !auth.appId.startsWith('session:')) return false;
  return ctx.chat.isUserDirectedTurn(auth.appId.slice('session:'.length));
}

const BindRequestSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Credential to store in the SecretStore — object (stringified) or string. */
  credential: z.unknown().optional(),
});

const OAuthStartSchema = z.object({
  type: z.string().min(1),
  redirectUri: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  displayName: z.string().optional(),
  /** Pre-fill the provider's account picker (mail: the address being linked). */
  loginHint: z.string().optional(),
  /** Re-link this existing connection in place instead of adding one. */
  relinkBindingId: z.string().optional(),
});

const ReconnectSchema = z.object({
  /** The new credential — object (stringified) or string. */
  credential: z.unknown(),
});

const OAuthCompleteSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

const ActionDraftSchema = z.object({
  action: z.string().min(1),
  input: z.unknown().optional(),
});

const PatchSchema = z.object({
  displayName: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
});

export function connectorRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/connectors', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(await ctx.connectors.status(project));
  });

  // What connecting a type fetches first (a published component), or why it
  // cannot: the form says so before the person fills it in.
  app.get('/:id/connectors/readiness', async (c) => {
    const type = c.req.query('type');
    if (!type) return c.json({ error: 'type is required' }, 400);
    try {
      return c.json(await ctx.connectors.componentReadiness(type));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Whether Gezel's own sign-in app can connect a type, so the form can say
  // which app Connect will use before the person presses it.
  app.get('/:id/connectors/oauth-app', async (c) => {
    const type = c.req.query('type');
    if (!type) return c.json({ error: 'type is required' }, 400);
    try {
      return c.json(await ctx.connectors.oauthAppFor(type));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/:id/connectors/bind', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = BindRequestSchema.parse(await c.req.json());
    try {
      const credential =
        body.credential === undefined
          ? undefined
          : typeof body.credential === 'string'
            ? body.credential
            : JSON.stringify(body.credential);
      const binding = await ctx.connectors.bind(project, {
        type: body.type,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.config ? { config: body.config } : {}),
        ...(credential !== undefined ? { credential } : {}),
      });
      return c.json({ ok: true, binding });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // OAuth linking for OAuth-shaped connector types (Gmail, Calendar, …). The
  // shell opens `authUrl`, captures the redirect's `code`, and posts it to
  // /complete. Client ids come from the install env named in the type's shape.
  app.post('/:id/connectors/oauth/start', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = OAuthStartSchema.parse(await c.req.json());
    try {
      const result = await ctx.connectors.startOAuth(project, body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/:id/connectors/oauth/complete', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = OAuthCompleteSchema.parse(await c.req.json());
    try {
      const binding = await ctx.connectors.completeOAuth(project, body);
      return c.json({ ok: true, binding });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/:id/connectors/:bindingId/sync', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      const result = await ctx.connectors.syncBinding(project, c.req.param('bindingId'), {
        trigger: 'manual',
      });
      return c.json({ ok: true, result });
    } catch (err) {
      const status = err instanceof ConnectorPolicyError ? 403 : 400;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  });

  // What a connection has downloaded, for the remove dialog to name.
  app.get('/:id/connectors/:bindingId/stored', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      return c.json(await ctx.connectors.storedData(project, c.req.param('bindingId')));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // `?deleteData=1` also deletes what the connection downloaded; without it
  // the records stay in the project.
  app.delete('/:id/connectors/:bindingId', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const bindingId = c.req.param('bindingId');
    const binding = project.connectors?.find((b) => b.id === bindingId);
    const deleteData = c.req.query('deleteData') === '1';
    let result: Awaited<ReturnType<typeof ctx.connectors.unbind>>;
    try {
      result = await ctx.connectors.unbind(project, bindingId, { deleteData });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    // A camera's saved pictures go with it unless the person keeps them.
    if (binding?.driver === 'device' && c.req.query('keepPictures') !== '1') {
      await ctx.cameras
        .capturesFor(project.id, binding)
        .clear()
        .catch(() => {});
    }
    return deleteData ? c.json({ ok: true, ...result }) : c.body(null, 204);
  });

  // Re-link in place: a new credential for an existing connection, keeping
  // its settings, cursor, and records. OAuth types re-link through
  // /oauth/start with `relinkBindingId`.
  app.post('/:id/connectors/:bindingId/reconnect', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = ReconnectSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || body.data.credential === undefined || body.data.credential === null) {
      return c.json({ error: 'a credential is required' }, 400);
    }
    const credential =
      typeof body.data.credential === 'string'
        ? body.data.credential
        : JSON.stringify(body.data.credential);
    try {
      const binding = await ctx.connectors.reconnect(project, c.req.param('bindingId'), credential);
      return c.json({ ok: true, binding });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Check a connection: a trial pass that changes nothing the project keeps.
  // `cassette: true` adds the scrubbed exchanges, for a person to keep or send.
  app.post('/:id/connectors/:bindingId/check', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { cassette?: unknown };
    try {
      const check = await ctx.connectors.checkConnection(project, c.req.param('bindingId'), {
        cassette: body?.cassette === true,
      });
      return c.json({ ok: true, check });
    } catch (err) {
      if (err instanceof ConnectorPolicyError) return c.json({ error: err.message }, 403);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Rename, reconfigure, pause, or resume a binding (a camera's settings).
  app.patch('/:id/connectors/:bindingId', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    try {
      const binding = await ctx.connectors.patchBinding(project, c.req.param('bindingId'), {
        ...(body.data.displayName !== undefined ? { displayName: body.data.displayName } : {}),
        ...(body.data.config ? { config: body.data.config } : {}),
        ...(body.data.disabled !== undefined ? { disabled: body.data.disabled } : {}),
        firstParty: isFirstPartyCaller(c),
      });
      return c.json({ ok: true, binding });
    } catch (err) {
      if (err instanceof ConnectorPolicyError) return c.json({ error: err.message }, 403);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Cameras (device bindings) ───────────────────────────────────────────
  // The live preview is the newest frame in memory; nothing is written to
  // disk for it. Saved pictures live in the project's private sidecar.

  app.get('/:id/connectors/:bindingId/preview', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    const binding = project?.connectors?.find((b) => b.id === c.req.param('bindingId'));
    if (!project || !binding || binding.driver !== 'device')
      return c.json({ error: 'not found' }, 404);
    const frame = ctx.cameras.preview(binding);
    if (!frame) return c.json({ error: 'not watching' }, 404);
    return c.body(new Uint8Array(frame.jpeg), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'X-Frame-At': new Date(frame.at).toISOString(),
    });
  });

  app.get('/:id/connectors/:bindingId/captures', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    const binding = project?.connectors?.find((b) => b.id === c.req.param('bindingId'));
    if (!project || !binding || binding.driver !== 'device')
      return c.json({ error: 'not found' }, 404);
    const store = ctx.cameras.capturesFor(project.id, binding);
    const day = c.req.query('date');
    const captures = await store.list(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined);
    return c.json({ captures, totalBytes: captures.reduce((n, x) => n + x.bytes, 0) });
  });

  app.get('/:id/connectors/:bindingId/captures/file', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    const binding = project?.connectors?.find((b) => b.id === c.req.param('bindingId'));
    if (!project || !binding || binding.driver !== 'device')
      return c.json({ error: 'not found' }, 404);
    const path = c.req.query('path') ?? '';
    try {
      const bytes = await ctx.cameras.capturesFor(project.id, binding).read(path);
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  app.delete('/:id/connectors/:bindingId/captures', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    const binding = project?.connectors?.find((b) => b.id === c.req.param('bindingId'));
    if (!project || !binding || binding.driver !== 'device')
      return c.json({ error: 'not found' }, 404);
    await ctx.cameras.capturesFor(project.id, binding).clear();
    return c.body(null, 204);
  });

  // ── Write actions (draft → queue → commit) ───────────────────────────────
  // A gezel DRAFTS an action; committing (the live write) must clear the
  // action's daemon-enforced consent scope. Generic actions have no enforcer
  // an agent can satisfy, so their commit stays user-only; mail's send tools
  // commit through the recipient-allowlist enforcer (deny-by-default).

  // Pending actions across the project's connectors (the review surface).
  app.get('/:id/connectors/actions', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(await ctx.connectorActions.list(project));
  });

  // Stage a drafted action to the outbox (no network, no consent needed yet).
  app.post('/:id/connectors/actions/:draftId/queue', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      const result = await ctx.connectorActions.queue(project, c.req.param('draftId'));
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Commit a drafted action. Reaches transmission only through the action's
  // consent scope (daemon-enforced, deny-by-default), and only when someone
  // is attending; otherwise it holds for approval. Both users and
  // enforcer-cleared agent tools (send_email, publish_post) land here.
  app.post('/:id/connectors/actions/:draftId/commit', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      const result = await ctx.connectorActions.commit(project, c.req.param('draftId'), {
        agentInitiated: !isFirstPartyCaller(c),
        attended: commitIsAttended(ctx, c),
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/:id/connectors/actions/:draftId', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    await ctx.connectorActions.discard(project, c.req.param('draftId'));
    return c.body(null, 204);
  });

  // Draft an action on a binding (agent-facing; never commits).
  app.post('/:id/connectors/:bindingId/actions', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = ActionDraftSchema.parse(await c.req.json());
    try {
      const result = await ctx.connectorActions.draft(project, {
        bindingId: c.req.param('bindingId'),
        action: body.action,
        input: body.input,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
