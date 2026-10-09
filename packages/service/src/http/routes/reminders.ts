import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/** Every project's reminder, for the notifiers to schedule. Read-only: scripts set them. */
export function reminderRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.get('/', async (c) => c.json({ reminders: await ctx.store.listReminders() }));
  return app;
}
