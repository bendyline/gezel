import { InvokePageToolRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { invokePageTool } from '../page-io.js';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_INVOKES = 120;

/**
 * The first-party bridge behind interactive Output pages.
 *
 * A served type page cannot reach `/api/*` (it holds only a preview
 * capability); its parent — the in-app Output pane, which holds the ui
 * bearer — relays `{tool, input}` requests here. The enforcement itself
 * lives in `page-io.ts` (shared with the app-serve visitor head): the
 * allowlist is re-derived from the applied type's manifest per request, the
 * declared script runs through the standard sandboxed pipeline, and the
 * tool's declared reaction fires only through this shared path (model-called
 * tools never react, and session tokens can't reach this route, so a gezel
 * can never summon itself).
 */
export function pageInvokeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const invokeTimes = new Map<string, number[]>();

  function rateLimited(projectId: string): boolean {
    const now = Date.now();
    const recent = (invokeTimes.get(projectId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_INVOKES) {
      invokeTimes.set(projectId, recent);
      return true;
    }
    recent.push(now);
    invokeTimes.set(projectId, recent);
    return false;
  }

  app.post('/:projectId/page-invoke', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    if (rateLimited(projectId)) return c.json({ error: 'rate limited' }, 429);
    const body = InvokePageToolRequestSchema.parse(await c.req.json());
    const result = await invokePageTool(ctx, {
      projectId,
      request: body,
      allowReaction: true,
      origin: 'page',
    });
    return c.json(result.body, result.status);
  });

  return app;
}
