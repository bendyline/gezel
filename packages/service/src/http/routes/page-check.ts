import { PageCheckRequestSchema, type PageCheckResponse, createLogger } from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import {
  isChromiumReady,
  resolvePlaywrightInstall,
  runPageCheck,
} from '../../page-check/runner.js';
import type { ServiceContext } from '../context.js';
import {
  type PreviewCapabilityStore,
  encodePreviewPath,
  normalizePreviewPath,
} from '../preview-capability.js';

const log = createLogger('http');

/**
 * Headless runtime smoke check of a workspace HTML page. The MCP write
 * tools call this after landing `*.html` so the model learns — inside the
 * same tool result it is already reading — whether the page it just wrote
 * actually runs, not merely parses. See page-check/runner.ts for the
 * incident this exists for and the skip philosophy: no Playwright toolset
 * → `{ran: false}` fast, never an error, never a background download.
 *
 * The page is served through a freshly minted preview capability so
 * relative assets resolve exactly as they do in the user-facing preview
 * iframe — same origin semantics, same injected log shim, same CSP.
 */
export function pageCheckRoutes(ctx: ServiceContext, capabilities: PreviewCapabilityStore): Hono {
  const app = new Hono();

  // Deliberately NOT requireFirstParty: the primary caller is the gezel's
  // MCP subprocess with a session-scoped token (scope-guard has already
  // bound it to this project). Unlike the mint route, no capability ever
  // reaches the caller — the lease is consumed by the headless browser and
  // the response carries only ran/ok/errors, so a session credential gains
  // no read authority it didn't already have through its workspace tools.
  app.post('/:id/page-check', async (c) => {
    const projectId = c.req.param('id');
    const body = PageCheckRequestSchema.parse(await c.req.json());
    const entryPath = normalizePreviewPath(body.path);
    if (entryPath === null || !/\.html?$/i.test(entryPath)) {
      return c.json({ error: 'page-check requires a workspace-relative .html path' }, 400);
    }
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);

    const respond = (r: PageCheckResponse) => c.json(r);

    const installPath = await resolvePlaywrightInstall(ctx.store);
    if (!installPath) {
      return respond({ ran: false, reason: 'browser-runtime-not-installed' });
    }
    if (!(await isChromiumReady(ctx.home))) {
      return respond({ ran: false, reason: 'chromium-not-installed' });
    }

    const minted = capabilities.mint({
      source: 'workspace',
      projectId,
      entryPath: body.path,
    });
    // Self-origin from the incoming request: the MCP server calls the same
    // scheme://127.0.0.1:port it was handed as GEZEL_BASE_URL, so this is
    // correct for both plain-HTTP dev and pinned-TLS packaged transports.
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/preview/${encodeURIComponent(minted.token)}/workspace/${encodeURIComponent(projectId)}/${encodePreviewPath(entryPath)}`;

    const outcome = await runPageCheck({
      installPath,
      browsersPath: playwrightBrowsersDir(ctx.home),
      url,
    });
    if (outcome.ran) {
      log.info(
        `[page-check] ${projectId}/${entryPath} → ${outcome.ok ? 'clean' : `${outcome.errors?.length ?? 0} error(s)`}`,
      );
    }
    return respond({
      ran: outcome.ran,
      ...(outcome.ok !== undefined ? { ok: outcome.ok } : {}),
      ...(outcome.errors ? { errors: outcome.errors } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  });

  return app;
}
