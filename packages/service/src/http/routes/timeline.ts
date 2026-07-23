import type { ListTimelineResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * Global, project-agnostic timeline. Used by the Meester chat surface to
 * show every chat happening anywhere in the install in one chronological
 * stream. The composer still scopes its message to a single (gezel,
 * session) — the timeline is purely a viewer.
 *
 * The per-project timeline lives at `/api/projects/:id/timeline` (mounted
 * inside `projectRoutes`). Both endpoints share the same response shape.
 */
export function timelineRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const response = await buildTimeline(ctx, {
      rawLimit: c.req.query('limit'),
      before: c.req.query('before'),
      gezelId: c.req.query('gezel'),
    });
    return c.json(response);
  });

  return app;
}

export async function buildTimeline(
  ctx: ServiceContext,
  opts: {
    projectId?: string;
    gezelId?: string;
    rawLimit?: string;
    before?: string;
  },
): Promise<ListTimelineResponse> {
  const limit = clampLimit(opts.rawLimit);
  const result = await ctx.store.listTimeline({
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.gezelId ? { gezelId: opts.gezelId } : {}),
    limit,
    ...(opts.before ? { before: opts.before } : {}),
  });
  return {
    messages: result.messages,
    hasMore: result.hasMore,
    ...(result.hasMore && result.messages.length > 0 ? { nextCursor: result.messages[0]!.at } : {}),
    ...(result.terminalEntries ? { terminalEntries: result.terminalEntries } : {}),
  };
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 100;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(500, n);
}
