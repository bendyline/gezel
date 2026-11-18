/**
 * Connections a draft calls for, mounted under /api/projects. Both routes are
 * the person's: the composer reads the offers for the words being written,
 * and accepting one reaches the network on their behalf. The scope guard
 * refuses them to session tokens. Contract: docs/prompt-connectors.md.
 */

import {
  AcceptPromptConnectorRequestSchema,
  PromptConnectorOffersRequestSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

export function promptConnectorRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/prompt-connectors/offers', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = PromptConnectorOffersRequestSchema.parse(await c.req.json());
    return c.json({ offers: await ctx.promptConnectors.offers(project, body.text) });
  });

  app.post('/:id/prompt-connectors/accept', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = AcceptPromptConnectorRequestSchema.parse(await c.req.json());
    try {
      return c.json({
        inclusion: await ctx.promptConnectors.accept(project, body.rule, body.subject),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
