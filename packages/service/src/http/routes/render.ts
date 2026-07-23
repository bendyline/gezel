import { RenderImageRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Image rendering — POST /api/render/image. Flattens the composition,
 * saves a PNG/JPEG under `projects/{id}/artifacts/renders/`, and returns
 * the path plus a base64 copy so the caller can feed it directly into a
 * vision-capable model without a second HTTP round trip.
 */
export function renderRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/image', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RenderImageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;
    const projectId = req.projectId ?? 'default';

    try {
      const result = await ctx.renderer.render(req, {
        resolveImage: async (p) => {
          const hit = await ctx.store.resolveProjectArtifact(projectId, p);
          if (hit.kind !== 'found') return null;
          // The resolve path returns string content; for binary images we
          // re-read via the dedicated binary path so we get raw bytes.
          const raw = await ctx.store.readProjectArtifactBinary(projectId, hit.path);
          if (!raw) return null;
          return `data:${raw.mimeType};base64,${raw.data.toString('base64')}`;
        },
      });

      const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
      const baseName = (req.filename ?? `render-${Date.now()}`).replace(/[^a-z0-9._-]+/gi, '-');
      const relPath = `renders/${baseName}${ext}`;
      const saved = await ctx.store.writeProjectArtifactBinary(projectId, relPath, result.buffer);

      await ctx.history.log({
        kind: 'render.generated',
        projectId,
        summary: `Rendered ${result.width}×${result.height} ${result.mimeType} to ${saved}`,
        details: {
          path: saved,
          width: result.width,
          height: result.height,
          bytes: result.buffer.byteLength,
          engine: result.engine,
          layers: req.layers.map((l) => l.kind),
        },
      });

      return c.json({
        path: saved,
        url: `/api/projects/${encodeURIComponent(projectId)}/artifacts/${saved
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
        width: result.width,
        height: result.height,
        bytes: result.buffer.byteLength,
        mimeType: result.mimeType,
        base64: result.buffer.toString('base64'),
        engine: result.engine,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('[render] failed:', message);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
