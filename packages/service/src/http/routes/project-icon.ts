import {
  DrawProjectIconRequestSchema,
  PROJECT_ICON_IMAGE_MAX_BYTES,
  PROJECT_ICON_MEDIA_TYPES,
  SetProjectIconSvgRequestSchema,
  createLogger,
  sniffProjectIconImage,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  ProjectIconNotDrawnError,
  drawProjectIcon,
  sanitizeProjectIconSvg,
} from '../../icon/project-icon.js';
import type { ServiceContext } from '../context.js';

/**
 * A project's own icon, in place of its maker's mark.
 *
 *   POST   /api/projects/:id/icon/draw  { description } → { svg }   (nothing saved)
 *   PUT    /api/projects/:id/icon       { svg }          → ProjectDetail
 *   PUT    /api/projects/:id/icon       <image bytes>    → ProjectDetail
 *   GET    /api/projects/:id/icon                        → the stored art
 *   DELETE /api/projects/:id/icon                        → ProjectDetail
 *
 * Drawing costs a model call and never saves: the person looks at the result
 * and keeps it with the PUT. The PUT takes either a drawn mark as JSON or a
 * picture as raw bytes. A picture's format is read from the bytes, never from
 * the declared type, and only PNG, JPEG and WebP are kept. None of these
 * routes is on the session allowlist, so a gezel cannot reach them.
 */
const log = createLogger('project-icon');

export function projectIconRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/icon/draw', async (c) => {
    const id = c.req.param('id');
    const parsed = DrawProjectIconRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Say what the icon should show.' }, 400);
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    try {
      const svg = await drawProjectIcon(ctx.chat, project, parsed.data.description);
      return c.json({ svg });
    } catch (err) {
      // Both are answered below 500 on purpose: a 5xx body is replaced with
      // an opaque one, and these are outcomes the person acts on.
      if (err instanceof ProjectIconNotDrawnError) return c.json({ error: err.message }, 422);
      log.warn(`could not draw an icon for ${id}: ${err instanceof Error ? err.message : err}`);
      return c.json(
        {
          error:
            'No model could draw the icon just now. Check that a model is set up and ready, then try again.',
        },
        424,
      );
    }
  });

  app.put('/:id/icon', async (c) => {
    const id = c.req.param('id');
    if (!(await ctx.store.getProject(id).catch(() => null))) {
      return c.json({ error: 'project not found' }, 404);
    }
    if ((c.req.header('content-type') ?? '').includes('application/json')) {
      const parsed = SetProjectIconSvgRequestSchema.safeParse(await c.req.json().catch(() => ({})));
      const svg = parsed.success ? sanitizeProjectIconSvg(parsed.data.svg) : null;
      if (!svg) return c.json({ error: 'That is not a usable icon drawing.' }, 400);
      return c.json(await ctx.store.writeProjectIconArt(id, { kind: 'drawn', svg }));
    }
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > PROJECT_ICON_IMAGE_MAX_BYTES) {
      return c.json({ error: 'That picture is too large for an icon.' }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PROJECT_ICON_IMAGE_MAX_BYTES) {
      return c.json({ error: 'That picture is too large for an icon.' }, 413);
    }
    const format = sniffProjectIconImage(bytes);
    if (!format) return c.json({ error: 'An icon picture is a PNG, JPEG or WebP file.' }, 415);
    return c.json(await ctx.store.writeProjectIconArt(id, { kind: 'image', format, bytes }));
  });

  app.get('/:id/icon', async (c) => {
    const art = await ctx.store.readProjectIconArt(c.req.param('id')).catch(() => null);
    if (!art) return c.json({ error: 'this project has no icon of its own' }, 404);
    // A stored SVG was sanitized on the way in; it is still served as an
    // image that may not run script or be framed as a document.
    return c.body(new Uint8Array(art.bytes), 200, {
      'content-type': PROJECT_ICON_MEDIA_TYPES[art.format],
      'cache-control': 'private, no-cache',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    });
  });

  app.delete('/:id/icon', async (c) => {
    const id = c.req.param('id');
    if (!(await ctx.store.getProject(id).catch(() => null))) {
      return c.json({ error: 'project not found' }, 404);
    }
    return c.json(await ctx.store.clearProjectIconArt(id));
  });

  return app;
}
