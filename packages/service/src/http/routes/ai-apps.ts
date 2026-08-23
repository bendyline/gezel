/**
 * Global AI App management (docs/project-types.md):
 *
 *   GET    /api/ai-apps                      installed apps (registry + receipts)
 *   POST   /api/ai-apps/import?confirm=1     raw .gezapp bytes → preview / install
 *   GET    /api/ai-apps/:appId               detail incl. live dependency check
 *   PATCH  /api/ai-apps/:appId               { enabled } toggle
 *   DELETE /api/ai-apps/:appId?keepFiles=1   uninstall
 *
 * The import body is the raw archive (`application/octet-stream`), not
 * multipart — the same shape as the artifacts raw-upload route. Deliberately
 * NOT on the session scope-guard allowlist: installing or removing apps is a
 * user/CLI capability, not a gezel capability. The project-nested
 * `/:id/ai-apps/*` routes remain for the artifact-drawer flow the MCP tools
 * use.
 */

import type { AiAppAppliedProject, AiAppDetail, AiAppStatus, Project } from '@bendyline/gezel';
import { UpdateAiAppRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  GEZAPP_MAX_ARCHIVE_BYTES,
  type InstalledGezapp,
  importGezapp,
  listGezapps,
  missingGezappDependencies,
  removeGezapp,
  setGezappEnabled,
} from '../../project-type/gezapp.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('ai-apps');

function toStatus(app: InstalledGezapp): AiAppStatus {
  const manifest = app.receipt?.manifest ?? null;
  return {
    appId: app.entry.appId,
    version: app.entry.version,
    packageSha256: app.entry.packageSha256,
    installedAt: app.entry.installedAt,
    enabled: app.entry.enabled,
    name: manifest?.name ?? null,
    description: manifest?.description ?? null,
    publisher: manifest?.publisher ?? null,
    itemCount: manifest?.items.length ?? 0,
    dependencyCount: manifest?.dependencies.length ?? 0,
    versionsOnDisk: app.versionsOnDisk,
  };
}

function appliedProjects(projects: Project[], appId: string): AiAppAppliedProject[] {
  return projects
    .filter((project) => project.projectType?.id === appId)
    .map((project) => ({
      id: project.id,
      name: project.name,
      version: project.projectType?.version ?? '',
    }));
}

export function aiAppRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const apps = await listGezapps(ctx.home);
    return c.json({ apps: apps.map(toStatus) });
  });

  app.post('/import', async (c) => {
    const length = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(length) && length > GEZAPP_MAX_ARCHIVE_BYTES) {
      return c.json(
        { error: `.gezapp exceeds ${GEZAPP_MAX_ARCHIVE_BYTES} byte archive limit` },
        413,
      );
    }
    const buffer = Buffer.from(await c.req.arrayBuffer());
    if (buffer.length === 0) return c.json({ error: 'empty request body' }, 400);
    if (buffer.length > GEZAPP_MAX_ARCHIVE_BYTES) {
      return c.json(
        { error: `.gezapp exceeds ${GEZAPP_MAX_ARCHIVE_BYTES} byte archive limit` },
        413,
      );
    }
    const confirm = c.req.query('confirm') === '1' || c.req.query('confirm') === 'true';
    try {
      const before = await listGezapps(ctx.home);
      const result = await importGezapp({ home: ctx.home, catalog: ctx.catalog }, buffer, {
        confirm,
      });
      const previous = before.find((app) => app.entry.appId === result.manifest.entry.projectType);
      const withPrevious = previous
        ? {
            ...result,
            previous: { version: previous.entry.version, enabled: previous.entry.enabled },
          }
        : result;
      if (result.installed) {
        await ctx.chat.resetClient({ deferBusy: true });
        await ctx.history.log({
          kind: 'ai-app.installed',
          summary: `Installed AI App ${result.installed.appId}@${result.installed.version}`,
          details: {
            appId: result.installed.appId,
            version: result.installed.version,
            ...(previous ? { previousVersion: previous.entry.version } : {}),
            alreadyPresent: result.installed.alreadyPresent,
          },
        });
      }
      return c.json(withPrevious);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/:appId', async (c) => {
    const appId = c.req.param('appId');
    const apps = await listGezapps(ctx.home);
    const found = apps.find((app) => app.entry.appId === appId);
    if (!found) return c.json({ error: 'AI App not found' }, 404);
    const projects = await ctx.store.listProjects().catch(() => [] as Project[]);
    const detail: AiAppDetail = {
      ...toStatus(found),
      manifest: found.receipt?.manifest ?? null,
      missingDependencies: found.receipt
        ? await missingGezappDependencies(ctx.catalog, found.receipt.manifest.dependencies)
        : [],
      appliedProjects: appliedProjects(projects, appId),
    };
    return c.json(detail);
  });

  app.patch('/:appId', async (c) => {
    const appId = c.req.param('appId');
    const body = UpdateAiAppRequestSchema.parse(await c.req.json());
    const entry = await setGezappEnabled(ctx.home, appId, body.enabled);
    if (!entry) return c.json({ error: 'AI App not found' }, 404);
    await ctx.chat.resetClient({ deferBusy: true });
    await ctx.history.log({
      kind: body.enabled ? 'ai-app.enabled' : 'ai-app.disabled',
      summary: `${body.enabled ? 'Enabled' : 'Disabled'} AI App ${appId}`,
      details: { appId, version: entry.version },
    });
    return c.json({ entry });
  });

  app.delete('/:appId', async (c) => {
    const appId = c.req.param('appId');
    const keepFiles = c.req.query('keepFiles') === '1' || c.req.query('keepFiles') === 'true';
    const projects = await ctx.store.listProjects().catch(() => [] as Project[]);
    const removed = await removeGezapp(ctx.home, appId, { keepFiles });
    if (!removed) return c.json({ error: 'AI App not found' }, 404);
    await ctx.chat.resetClient({ deferBusy: true });
    await ctx.history.log({
      kind: 'ai-app.removed',
      summary: `Uninstalled AI App ${appId}`,
      details: {
        appId,
        removedVersions: removed.removedVersions,
        keptVersions: removed.keptVersions,
      },
    });
    if (removed.keptVersions.length > 0 && !keepFiles) {
      log.warn(
        `[remove] ${appId}: ${removed.keptVersions.length} version dir(s) could not be deleted`,
      );
    }
    return c.json({ ...removed, appliedProjects: appliedProjects(projects, appId) });
  });

  return app;
}
