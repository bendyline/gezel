/**
 * Local hardware a project can connect to, mounted at `/api/devices`. Today:
 * which cameras this computer has, and one test picture from one of them for
 * the setup panel. Owner callers only — a camera's picture is the person's.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { resetFfmpegProbe } from '../../media/ffmpeg.js';
import { isOwnerCaller } from '../auth.js';
import type { ServiceContext } from '../context.js';

const ProbeSchema = z.object({ device: z.string().min(1).max(1024) });

export const ownerOnly: MiddlewareHandler = async (c, next) =>
  isOwnerCaller(c) ? next() : c.json({ error: 'owner_only' }, 403);

export function deviceRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', ownerOnly);

  app.get('/cameras', async (c) => {
    // "Check again" after installing ffmpeg must see it.
    if (c.req.query('refresh') === '1') resetFfmpegProbe();
    return c.json(await ctx.cameras.discover());
  });

  // Which cameras are on right now (the shell's indicator reads this on load).
  app.get('/cameras/watching', (c) => c.json({ cameras: ctx.liveConnectors.watchingCameras() }));

  app.post('/cameras/probe', async (c) => {
    const parsed = ProbeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'device is required' }, 400);
    try {
      const jpeg = await ctx.cameras.probe(parsed.data.device);
      return c.body(new Uint8Array(jpeg), 200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  return app;
}
