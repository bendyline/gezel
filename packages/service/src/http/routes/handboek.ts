import { readFile } from 'node:fs/promises';
import { HandboekRenderModeSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { createHandboekNarrator } from '../../handboek/narration.js';
import type { ServiceContext } from '../context.js';

export function handboekRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const narrator = createHandboekNarrator({ home: ctx.home, tts: ctx.tts });

  app.get('/toc', async (c) => {
    return c.json(await ctx.handboek.toc());
  });

  app.get('/how-do-i', async (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ error: 'missing q' }, 400);
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const results = await ctx.handboek.howDoI(q, {
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json({ results });
  });

  app.get('/narration/audio/:hash{[a-f0-9]{64}}', async (c) => {
    const path = narrator.audioPath(c.req.param('hash'));
    if (!path) return c.json({ error: 'unknown narration segment' }, 404);
    const wav = await readFile(path);
    return c.body(new Uint8Array(wav), 200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'private, max-age=86400',
    });
  });

  app.get('/narration/article/:id{.+}', async (c) => {
    const health = await (await ctx.tts.current()).health();
    if (health.status !== 'ok') {
      return c.json({ error: `text-to-speech engine unavailable: ${health.status}` }, 409);
    }
    const id = c.req.param('id');
    const article = await ctx.handboek.article(id, { mode: 'app' });
    if (!article) return c.json({ error: `unknown handboek article: ${id}` }, 404);
    const voice = c.req.query('voice') || undefined;
    return c.json(await narrator.manifest(article, { voice }));
  });

  // Article ids contain slashes (`role/meester`, `craftbook/research-report`),
  // so the param takes the rest of the path.
  app.get('/article/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const parsedMode = HandboekRenderModeSchema.safeParse(c.req.query('mode'));
    const mode = parsedMode.success ? parsedMode.data : 'app';
    const article = await ctx.handboek.article(id, { mode });
    if (!article) return c.json({ error: `unknown handboek article: ${id}` }, 404);
    return c.json(article);
  });

  return app;
}
