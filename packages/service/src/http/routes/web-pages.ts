/**
 * Saved web pages, mounted under /api/projects. Listing is open to sessions
 * (`list_web_pages` reads it); saving a page and everything about signing in
 * are the person's, refused to session tokens by the scope guard. A gezel's
 * request for a found link goes through `/web-pages/request`, which fetches
 * only an address the crawler already saw on a site the person follows.
 * Contract: docs/website-connector.md.
 */

import { SaveWebPageRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { CaptureUnavailableError } from '../../page-capture/types.js';
import type { ServiceContext } from '../context.js';

const RequestSchema = z.object({ url: z.string().min(1).max(4000) });
const ImportSchema = z.object({
  cookies: z.array(z.unknown()).max(2000),
  origins: z.array(z.unknown()).max(200).optional(),
});
/** A storage state larger than this is not a sign-in. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function webPageRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const project = async (id: string) => ctx.store.getProject(id);
  const fail = (err: unknown) => (err instanceof Error ? err.message : String(err));

  app.get('/:id/web-pages', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    const limit = Number(c.req.query('limit') ?? '') || undefined;
    const bindingId = c.req.query('binding') || undefined;
    return c.json(
      await ctx.websites.list(p, {
        ...(limit ? { limit } : {}),
        ...(bindingId ? { bindingId } : {}),
      }),
    );
  });

  app.get('/:id/web-pages/page', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    const page = await ctx.websites.find(p, c.req.query('url') ?? '');
    return page ? c.json({ page }) : c.json({ error: 'not saved' }, 404);
  });

  app.post('/:id/web-pages/save', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    const body = SaveWebPageRequestSchema.parse(await c.req.json());
    try {
      return c.json(await ctx.websites.savePage(p, body.url, body.sessionId));
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  app.post('/:id/web-pages/request', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    const body = RequestSchema.parse(await c.req.json());
    return c.json(await ctx.websites.requestPage(p, body.url));
  });

  app.post('/:id/connectors/:bindingId/sign-in', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    try {
      return c.json(await ctx.websites.startSignIn(p, c.req.param('bindingId')));
    } catch (err) {
      return c.json({ error: fail(err) }, err instanceof CaptureUnavailableError ? 409 : 400);
    }
  });

  app.post('/:id/connectors/:bindingId/sign-in/:signInId/finish', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    try {
      return c.json(
        await ctx.websites.finishSignIn(p, c.req.param('bindingId'), c.req.param('signInId')),
      );
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  app.delete('/:id/connectors/:bindingId/sign-in/:signInId', async (c) => {
    await ctx.websites.cancelSignIn(c.req.param('signInId'));
    return c.json({ ok: true });
  });

  app.get('/:id/connectors/:bindingId/session', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    c.header('cache-control', 'no-store');
    return c.json(await ctx.websites.sessionInfo(p, c.req.param('bindingId')));
  });

  app.delete('/:id/connectors/:bindingId/session', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    await ctx.websites.forgetSignIn(p, c.req.param('bindingId'));
    return c.json({ ok: true });
  });

  app.put('/:id/connectors/:bindingId/session', async (c) => {
    const p = await project(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    const raw = await c.req.text();
    if (raw.length > MAX_IMPORT_BYTES)
      return c.json({ error: 'That is too large to be a sign-in.' }, 413);
    let parsed: z.infer<typeof ImportSchema>;
    try {
      parsed = ImportSchema.parse(JSON.parse(raw));
    } catch {
      return c.json({ error: 'Expected a browser storage state (JSON with a cookies list).' }, 400);
    }
    try {
      await ctx.websites.importSignIn(p, c.req.param('bindingId'), parsed);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  return app;
}
