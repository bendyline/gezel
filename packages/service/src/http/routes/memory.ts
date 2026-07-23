import { Hono } from 'hono';
import { type MemoryKind, isMemoryKind } from '../../memory/daily-markdown.js';
import type { ServiceContext } from '../context.js';

export function memoryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/search', async (c) => {
    const body = (await c.req.json()) as {
      gezelId: string;
      projectId: string;
      query: string;
      topK?: number;
    };
    const results = await ctx.memory.searchAll(
      body.gezelId,
      body.projectId,
      body.query,
      body.topK ?? 10,
    );
    return c.json({ results });
  });

  app.post('/save', async (c) => {
    const body = (await c.req.json()) as {
      scope: 'gezel' | 'project';
      id: string;
      text: string;
      kind?: MemoryKind;
    };
    const kind = isMemoryKind(body.kind) ? body.kind : 'fact';
    const outcome = await ctx.memory.save(body.scope, body.id, body.text, kind);
    return c.json({ ok: true, status: outcome?.status ?? 'saved' });
  });

  app.get('/recent', async (c) => {
    const scope = (c.req.query('scope') ?? 'gezel') as 'gezel' | 'project';
    const id = c.req.query('id') ?? '';
    const days = Number.parseInt(c.req.query('days') ?? '7', 10);
    const content = await ctx.memory.getRecent(scope, id, days);
    return c.json({ content });
  });

  app.get('/days', async (c) => {
    const scope = (c.req.query('scope') ?? 'gezel') as 'gezel' | 'project';
    const id = c.req.query('id') ?? '';
    const days = await ctx.memory.listDays(scope, id);
    return c.json({ days });
  });

  app.get('/day', async (c) => {
    const scope = (c.req.query('scope') ?? 'gezel') as 'gezel' | 'project';
    const id = c.req.query('id') ?? '';
    const day = c.req.query('day') ?? '';
    if (!day) return c.json({ error: 'missing ?day=YYYY-MM-DD' }, 400);
    const content = await ctx.memory.readDay(scope, id, day);
    return c.json({ content });
  });

  app.get('/summary', async (c) => {
    const scope = (c.req.query('scope') ?? 'gezel') as 'gezel' | 'project';
    const id = c.req.query('id') ?? '';
    const content = await ctx.memory.readSummary(scope, id);
    return c.json({ content });
  });

  app.get('/lessons', async (c) => {
    const gezelId = c.req.query('gezelId') ?? '';
    if (!gezelId) return c.json({ error: 'missing ?gezelId=' }, 400);
    const content = await ctx.store.readMemoryLessons(gezelId);
    return c.json({ content });
  });

  return app;
}
