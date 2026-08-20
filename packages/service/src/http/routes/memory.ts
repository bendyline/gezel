import { MemorySearchRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { type MemoryKind, isMemoryKind } from '../../memory/daily-markdown.js';
import type { ServiceContext } from '../context.js';

const MEMORY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_ID_PATTERN = /^(?!\.{1,2}$)[^/\\]+$/;

export function memoryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/search', async (c) => {
    const body = MemorySearchRequestSchema.parse(await c.req.json());
    const outcome = await ctx.memory.searchAllDetailed(
      body.gezelId,
      body.projectId,
      body.query,
      body.topK ?? 10,
    );
    return c.json(outcome);
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
    return c.json({ ok: true, ...outcome });
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

  app.patch('/day', async (c) => {
    const scope = c.req.query('scope');
    const id = c.req.query('id') ?? '';
    const day = c.req.query('day') ?? '';
    if (scope !== 'gezel' && scope !== 'project') {
      return c.json({ error: 'missing or invalid ?scope=' }, 400);
    }
    if (!MEMORY_ID_PATTERN.test(id)) return c.json({ error: 'missing or invalid ?id=' }, 400);
    if (!MEMORY_DAY_PATTERN.test(day)) {
      return c.json({ error: 'missing or invalid ?day=YYYY-MM-DD' }, 400);
    }
    const target =
      scope === 'project' ? await ctx.store.getProject(id) : await ctx.store.getGezel(id);
    if (!target) return c.json({ error: `${scope} not found` }, 404);
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    if (typeof body?.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    const { indexed } = await ctx.memory.replaceDay(scope, id, day, body.content);
    return c.json({ ok: true, indexed });
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
