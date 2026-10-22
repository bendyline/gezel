import { GenerateProjectReportRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { generateProjectReport, listProjectReports } from '../../reports/project-reports.js';
import type { ServiceContext } from '../context.js';

/**
 * The project's reports, for the Reports view.
 *
 *   GET  /api/projects/:id/reports                    → ProjectReportsResponse
 *   POST /api/projects/:id/reports/generate  { kind } → GenerateProjectReportResponse
 *
 * Generate runs one of the model-free nightly writers now, replacing the
 * day's report. Nothing it writes goes outside the artifacts drawer.
 */
export function projectReportRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const deps = { store: ctx.store, contentIndex: ctx.contentIndex, diffpacks: ctx.diffpacks };

  app.get('/:id/reports', async (c) => {
    const projectId = c.req.param('id');
    if (!(await ctx.store.getProject(projectId).catch(() => null))) {
      return c.json({ error: 'project not found' }, 404);
    }
    return c.json(await listProjectReports(deps, projectId));
  });

  app.post('/:id/reports/generate', async (c) => {
    const projectId = c.req.param('id');
    const parsed = GenerateProjectReportRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!(await ctx.store.getProject(projectId).catch(() => null))) {
      return c.json({ error: 'project not found' }, 404);
    }
    return c.json(await generateProjectReport(deps, projectId, parsed.data.kind, new Date()));
  });

  return app;
}
