/**
 * Connector routes, mounted under /api/projects so URLs resolve as
 * `/api/projects/:id/connectors/*`. Binding a source and triggering a sync are
 * user-initiated actions (like a mailbox link), so they aren't gated by the
 * autonomous `allowExternalServices` posture — that gates the background loop.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';

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
});

const OAuthCompleteSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

const ActionDraftSchema = z.object({
  action: z.string().min(1),
  input: z.unknown().optional(),
});

export function connectorRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/connectors', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(await ctx.connectors.status(project));
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
      const result = await ctx.connectors.syncBinding(project, c.req.param('bindingId'));
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/:id/connectors/:bindingId', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    await ctx.connectors.unbind(project, c.req.param('bindingId'));
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
  // consent scope (daemon-enforced, deny-by-default) + night-shift deferral,
  // so both users and enforcer-cleared agent tools (send_email) land here.
  app.post('/:id/connectors/actions/:draftId/commit', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      const result = await ctx.connectorActions.commit(project, c.req.param('draftId'));
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
