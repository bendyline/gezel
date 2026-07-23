import { ReportPreviewLogRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

/**
 * Loopback for runtime errors the preview iframe's injected shim caught.
 * Posted by the UI (which holds the first-party bearer — the sandboxed
 * iframe itself has a null origin and no credential, so entries travel
 * shim → postMessage → HtmlPreviewFrame → here). Entries land in the
 * in-memory PreviewLogBuffer; ChatManager drains them into the next
 * send's prelude for sessions scoped to the project.
 *
 * First-party only: a session token feeding fabricated "errors" into
 * another gezel's prelude would be a prompt-injection channel.
 */
export function previewLogRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/preview-log', requireFirstParty(), async (c) => {
    const projectId = c.req.param('id');
    const body = ReportPreviewLogRequestSchema.parse(await c.req.json());
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    ctx.previewLog.record(projectId, body.entries);
    return c.json({ ok: true, pending: ctx.previewLog.pendingCount(projectId) });
  });

  return app;
}
