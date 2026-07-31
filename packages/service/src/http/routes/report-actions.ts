import {
  DismissReportActionRequestSchema,
  FireReportActionRequestSchema,
  createLogger,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { ReportNotFoundError } from '../../report-actions/report-action-manager.js';
import { CraftbookSetupRequiredError } from '../../tasks/manager.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Report actions — the ```gezel-action blocks embedded in markdown report
 * artifacts, surfaced as fireable cards.
 *
 *   GET  /api/projects/:id/report-actions?path=<artifacts-relative>
 *   POST /api/projects/:id/report-actions/fire     { path, actionId, params? }
 *   POST /api/projects/:id/report-actions/dismiss  { path, actionId }
 *
 * SECURITY: action blocks are MODEL-AUTHORED, UNTRUSTED content inside
 * artifacts. Nothing here fires without this authenticated POST — the UI
 * shows the full params/diffs first, so the user's click is the consent.
 * Execution reuses the same validated paths as user-initiated work
 * (task creation + dispatch, workspace-writability-gated patch apply);
 * cross-project targets are validated against real projects and labeled
 * in the UI; create-task prompts are delimiter-wrapped as untrusted
 * evidence.
 */
export function reportActionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/report-actions', async (c) => {
    const projectId = c.req.param('id');
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'query parameter "path" is required' }, 400);
    try {
      return c.json(await ctx.reportActions.listForReport(projectId, path));
    } catch (err) {
      if (err instanceof ReportNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.post('/:id/report-actions/fire', async (c) => {
    const projectId = c.req.param('id');
    const parsed = FireReportActionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = await ctx.reportActions.fire(
        projectId,
        parsed.data.path,
        parsed.data.actionId,
        parsed.data.params,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof ReportNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof CraftbookSetupRequiredError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            craftbookId: err.craftbookId,
            missingToolsets: err.missingToolsets,
          },
          409,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `[report-actions] fire failed for ${projectId}/${parsed.data.path}#${parsed.data.actionId}: ${message}`,
      );
      return c.json({ error: message }, message.startsWith('unknown report action') ? 404 : 500);
    }
  });

  app.post('/:id/report-actions/dismiss', async (c) => {
    const projectId = c.req.param('id');
    const parsed = DismissReportActionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const record = await ctx.reportActions.dismiss(
        projectId,
        parsed.data.path,
        parsed.data.actionId,
      );
      return c.json({ record });
    } catch (err) {
      if (err instanceof ReportNotFoundError) return c.json({ error: err.message }, 404);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.startsWith('unknown report action') ? 404 : 500);
    }
  });

  return app;
}
