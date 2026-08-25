import { PageReadRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { readPageData } from '../page-io.js';

export { PAGE_READ_MAX_BYTES } from '../page-io.js';

/** Watch polling rides this route, so the budget is generous vs page-invoke. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_READS = 600;

/**
 * The read half of the first-party page bridge (Output Pane API v1).
 *
 * A served type page reads files its manifest declares in `pages.reads`;
 * the parent Output pane relays the request here with its ui bearer, the
 * same trust shape as page-invoke. Enforcement lives in `page-io.ts`
 * (shared with the app-serve visitor head): scopes are re-derived from the
 * applied type's manifest per request — never trusted from the client — and
 * every path goes through the standard traversal fences. The
 * preview-capability fetch path stays alive in parallel for v0 pages,
 * browser mode, and media URLs; this route exists so embedded pages never
 * juggle capability expiry.
 */
export function pageReadRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const readTimes = new Map<string, number[]>();

  function rateLimited(projectId: string): boolean {
    const now = Date.now();
    const recent = (readTimes.get(projectId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_READS) {
      readTimes.set(projectId, recent);
      return true;
    }
    recent.push(now);
    readTimes.set(projectId, recent);
    return false;
  }

  app.post('/:projectId/page-read', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    if (rateLimited(projectId)) return c.json({ error: 'rate limited' }, 429);
    const body = PageReadRequestSchema.parse(await c.req.json());
    const result = await readPageData(ctx, { projectId, request: body });
    return c.json(result.body, result.status);
  });

  return app;
}
