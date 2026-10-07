import { Hono } from 'hono';
import { z } from 'zod';
import { resetFfmpegProbe } from '../../media/ffmpeg.js';
import type { ServiceContext } from '../context.js';

/**
 * `/api/media-search` — the media-search model's status for Settings, an
 * explicit (re)install, and a fresh ffmpeg probe after the user installs one.
 * Not a session route: the scope guard denies new `/api/*` paths to session
 * tokens.
 */
export function mediaSearchRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await ctx.mediaSearch.status()));

  app.post('/install', async (c) => {
    const body = z
      .object({ audio: z.boolean().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const result = await ctx.mediaSearch.install(
      body.audio ? ['text', 'vision', 'audio'] : ['text', 'vision'],
    );
    if (result.installed) return c.json(result);
    if (result.started) return c.json(result, 202);
    return c.json({ ...result, error: result.reason ?? 'the download could not start' }, 409);
  });

  app.post('/ffmpeg/recheck', async (c) => {
    resetFfmpegProbe();
    await ctx.mediaSearch.applyGate();
    return c.json(await ctx.mediaSearch.status());
  });

  return app;
}
