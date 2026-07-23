import { SendChannelMessageRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

export function channelRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const channels = await ctx.channels.list();
    return c.json({ channels });
  });

  app.post('/send', async (c) => {
    const body = SendChannelMessageRequestSchema.parse(await c.req.json());
    const result = await ctx.channels.send(body.message, {
      ...(body.channel ? { channel: body.channel } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      source: 'http',
    });
    return c.json(result);
  });

  app.post('/:name/test', async (c) => {
    const name = c.req.param('name');
    if (name !== 'webhook') return c.json({ error: 'unknown channel' }, 404);
    const testMessage = `Test from Gezel at ${new Date().toISOString()}`;
    const result = await ctx.channels.send(testMessage, {
      channel: name,
      source: 'test',
    });
    return c.json(result);
  });

  return app;
}
