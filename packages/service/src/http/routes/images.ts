import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/** Hard cap on any single uploaded image. Images larger than this almost
 *  always indicate a user misstep (a screen recording, a raw camera dump)
 *  and the LLMs we send to will refuse them anyway. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/**
 * Per-session image upload/download endpoints. Mounted under
 * `/api/projects/:projectId/sessions/:sessionId/images`. Images live
 * under the project's artifacts tree so the existing MCP artifact tools
 * can see them — a gezel can "look at that screenshot I pasted" in a
 * later turn without any extra plumbing.
 */
export function imagesRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // Project-scoped attachments — images (and in the future, other
  // file types) pasted/uploaded via the chat composer land here. Each
  // project gets one flat folder at `artifacts/attachments/` so any
  // session can reference the same file, and the Artifacts tab shows
  // them alongside other project files. Markdown refs use the
  // relative form `attachments/<filename>` which `extractImageAttachments`
  // resolves to bytes at send time.
  app.post('/:projectId/attachments', async (c) => {
    const projectId = c.req.param('projectId');
    const rawType = c.req.header('content-type') ?? '';
    const mime = rawType.split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return c.json({ error: `unsupported image type: ${mime}` }, 415);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
    if (body.byteLength > MAX_IMAGE_BYTES) {
      return c.json(
        { error: `attachment too large: ${body.byteLength} bytes (max ${MAX_IMAGE_BYTES})` },
        413,
      );
    }
    const { relativePath, filename } = await ctx.store.writeProjectAttachment(
      projectId,
      Buffer.from(body),
      mime,
    );
    return c.json({
      relativePath,
      filename,
      url: `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(filename)}`,
    });
  });

  app.get('/:projectId/attachments', async (c) => {
    const projectId = c.req.param('projectId');
    const attachments = await ctx.store.listProjectAttachments(projectId);
    return c.json({ attachments });
  });

  app.get('/:projectId/attachments/:filename', async (c) => {
    const projectId = c.req.param('projectId');
    const filename = c.req.param('filename');
    const hit = await ctx.store.readProjectAttachment(projectId, filename);
    if (!hit) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(hit.data), 200, { 'content-type': hit.mimeType });
  });

  app.delete('/:projectId/attachments/:filename', async (c) => {
    const projectId = c.req.param('projectId');
    const filename = c.req.param('filename');
    await ctx.store.removeProjectAttachment(projectId, filename);
    return c.json({ ok: true });
  });

  app.post('/:projectId/sessions/:sessionId/images', async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const rawType = c.req.header('content-type') ?? '';
    const mime = rawType.split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return c.json({ error: `unsupported image type: ${mime}` }, 415);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
    if (body.byteLength > MAX_IMAGE_BYTES) {
      return c.json(
        { error: `image too large: ${body.byteLength} bytes (max ${MAX_IMAGE_BYTES})` },
        413,
      );
    }
    const { relativePath, filename } = await ctx.store.writeSessionImage(
      projectId,
      sessionId,
      Buffer.from(body),
      mime,
    );
    return c.json({
      relativePath,
      filename,
      url: `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`,
    });
  });

  app.get('/:projectId/sessions/:sessionId/images', async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const images = await ctx.store.listSessionImages(projectId, sessionId);
    return c.json({ images });
  });

  app.get('/:projectId/sessions/:sessionId/images/:filename', async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const filename = c.req.param('filename');
    const hit = await ctx.store.readSessionImage(projectId, sessionId, filename);
    if (!hit) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(hit.data), 200, { 'content-type': hit.mimeType });
  });

  app.delete('/:projectId/sessions/:sessionId/images/:filename', async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const filename = c.req.param('filename');
    await ctx.store.removeSessionImage(projectId, sessionId, filename);
    return c.json({ ok: true });
  });

  return app;
}
