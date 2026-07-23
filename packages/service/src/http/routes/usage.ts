import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

export function usageRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const summary = ctx.chat.usageTracker.summary();
    return c.json(summary);
  });

  return app;
}
