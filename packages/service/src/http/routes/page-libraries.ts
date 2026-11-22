import { createLogger, resolveDistributionProfile, resolveSecurityPolicy } from '@bendyline/gezel';
import { pageLibraryKey } from '@bendyline/gezel-inference/internal/page-libraries/manager';
import {
  type PageLibrariesResponse,
  type PageLibraryForm,
  type PageLibraryLine,
  PageLibraryNeedsRequestSchema,
  type PageLibraryNeedsResponse,
  listedPageLibraries,
} from '@bendyline/gezel/pages';
import { Hono } from 'hono';
import { exportWorkspacePage } from '../../page-libraries/export.js';
import {
  catalogPageLibraryLines,
  ensurePageLibrariesForPage,
} from '../../page-libraries/service.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { normalizePreviewPath } from '../preview-capability.js';

const log = createLogger('http');
const FORMS: PageLibraryForm[] = ['module', 'classic', 'style'];
/** Longest a request waits for a download it started; the download itself keeps going. */
const MAX_NEEDS_WAIT_MS = 60_000;
const PERSON_INSTALL_WAIT_MS = 5 * 60_000;

const REFUSALS: Record<string, string> = {
  network:
    'App network is off at this security level, so libraries are not downloaded on their own. Download one here, or raise the level in Settings → Security & compliance.',
  setting: 'Automatic downloads are off. Download a library here to make it available.',
};

/**
 * Page libraries (docs/page-libraries.md).
 *
 *   GET    /api/page-libraries                  what the catalog offers and what is installed
 *   POST   /api/page-libraries/install          { library, version } — first-party only
 *   DELETE /api/page-libraries/:library/:version — first-party only
 *
 * Session tokens reach none of these: a gezel never installs or removes a
 * library by name. The project route below is how a page's needs are met.
 */
export function pageLibraryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const manager = ctx.pageLibraries;
    const distribution = resolveDistributionProfile();
    const config = await ctx.store.readConfig().catch(() => null);
    const policy = config ? resolveSecurityPolicy(config) : null;
    const autoDownload = config?.pageLibraries?.autoDownload !== false;
    const blocked = !distribution.allowPageLibraryDownloads
      ? 'build'
      : !policy?.allowAppNetwork
        ? 'network'
        : !autoDownload
          ? 'setting'
          : undefined;
    const installed = manager ? await manager.store.installed() : [];
    const offered = await catalogPageLibraryLines(ctx.catalog);
    const items = await ctx.catalog.list('page-library').catch(() => []);
    const downloading = new Set(manager?.downloading() ?? []);

    const byLibrary = new Map<string, PageLibrariesResponse['libraries'][number]>();
    const lineStatus = (line: PageLibraryLine) => {
      const key = pageLibraryKey(line);
      const have = installed.find((entry) => pageLibraryKey(entry.line) === key);
      const error = manager?.lastFailure(key);
      return {
        version: line.version,
        forms: FORMS.filter((form) => line[form] !== undefined),
        defaults: FORMS.filter((form) => line[form]?.default),
        installed: Boolean(have),
        removable: have?.removable ?? false,
        downloading: downloading.has(key),
        ...(have
          ? { bytes: Object.values(have.files).reduce((total, file) => total + file.bytes, 0) }
          : {}),
        license: line.license,
        ...(error ? { error } : {}),
      };
    };
    const seen = new Set<string>();
    for (const line of [...installed.map((entry) => entry.line), ...offered]) {
      const key = pageLibraryKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      let group = byLibrary.get(line.library);
      if (!group) {
        const item = items.find(
          (entry) => entry.manifest.kind === 'page-library' && entry.manifest.id === line.library,
        )?.manifest;
        group = {
          library: line.library,
          name: line.name,
          ...(item?.description ? { description: item.description } : {}),
          ...(item?.kind === 'page-library' && item.homepage ? { homepage: item.homepage } : {}),
          lines: [],
        };
        byLibrary.set(line.library, group);
      }
      group.lines.push(lineStatus(line));
    }
    const body: PageLibrariesResponse = {
      downloads: {
        person: distribution.allowPageLibraryDownloads,
        automatic: blocked === undefined,
        ...(blocked ? { blocked } : {}),
        ...(blocked
          ? {
              refusal:
                blocked === 'build'
                  ? distribution.refusalReason('page-library')
                  : REFUSALS[blocked],
            }
          : {}),
      },
      autoDownload,
      libraries: [...byLibrary.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
    return c.json(body);
  });

  app.post('/install', requireFirstParty(), async (c) => {
    const manager = ctx.pageLibraries;
    if (!manager) return c.json({ error: 'page libraries are not available here' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { library?: unknown; version?: unknown };
    const line = (await catalogPageLibraryLines(ctx.catalog)).find(
      (entry) => entry.library === body.library && entry.version === body.version,
    );
    if (!line) return c.json({ error: 'no such page library in the catalog' }, 404);
    const result = await manager.ensure([line], {
      waitMs: PERSON_INSTALL_WAIT_MS,
      trigger: 'person',
    });
    if (result.blocked === 'build') {
      return c.json({ error: resolveDistributionProfile().refusalReason('page-library') }, 403);
    }
    if (result.failed.length) return c.json({ error: result.failed[0]!.error }, 502);
    return c.json({ ok: true, ready: result.ready.includes(pageLibraryKey(line)) });
  });

  app.delete('/:library/:version', requireFirstParty(), async (c) => {
    const manager = ctx.pageLibraries;
    if (!manager) return c.json({ error: 'page libraries are not available here' }, 503);
    const removed = await manager.remove(c.req.param('library'), c.req.param('version'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'not a downloaded page library' }, 404);
  });

  return app;
}

/**
 *   POST /api/projects/:id/pages/export   { path, format: 'folder' | 'single' }
 *
 * The page with its libraries: a zip of its folder, or one HTML file. Only
 * libraries already on the shelf go in; the notes header says what did not.
 */
export function projectPageExportRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.post('/:id/pages/export', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; format?: unknown };
    const entry = typeof body.path === 'string' ? normalizePreviewPath(body.path) : null;
    if (!entry || !/\.html?$/i.test(entry)) {
      return c.json({ error: 'needs a workspace-relative .html path' }, 400);
    }
    const format = body.format === 'single' ? 'single' : 'folder';
    const projectId = c.req.param('id');
    if (!(await ctx.store.getProject(projectId).catch(() => null))) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (ctx.pageLibraries) {
      // A library the page uses but this computer lacks would be left out.
      await ensurePageLibrariesForPage({
        store: ctx.store,
        manager: ctx.pageLibraries,
        projectId,
        entry,
        waitMs: MAX_NEEDS_WAIT_MS,
      }).catch(() => null);
    }
    const shelf = ctx.pageLibraries?.store;
    if (!shelf) return c.json({ error: 'page libraries are not available here' }, 503);
    try {
      const exported = await exportWorkspacePage({
        store: ctx.store,
        shelf,
        projectId,
        entry,
        format,
      });
      return c.body(new Uint8Array(exported.body), 200, {
        'content-type': exported.contentType,
        'content-disposition': `attachment; filename="${exported.filename}"`,
        // Plain words, one per line, for the person: what the copy leaves out.
        'x-gezel-export-notes': encodeURIComponent(exported.notes.join('\n')),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
    }
  });
  return app;
}

/**
 *   POST /api/projects/:id/page-libraries/needs   { path, waitMs? }
 *
 * What a workspace page needs from the shelf, downloading what is missing
 * when allowed and waiting up to `waitMs`. Open to a project's session
 * tokens: `validate` reads it, and a download it starts is one of the
 * catalog's pinned libraries, never one a caller names.
 */
export function projectPageLibraryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/page-libraries/needs', async (c) => {
    const manager = ctx.pageLibraries;
    const parsed = PageLibraryNeedsRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'needs a workspace-relative page path' }, 400);
    const entry = normalizePreviewPath(parsed.data.path);
    if (!entry || !/\.html?$/i.test(entry)) {
      return c.json({ error: 'needs a workspace-relative .html path' }, 400);
    }
    const projectId = c.req.param('id');
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const config = await ctx.store.readConfig().catch(() => null);
    const policy = config ? resolveSecurityPolicy(config) : null;
    const externalNetwork = Boolean(policy?.allowExternalServices && policy.allowAppNetwork);
    if (!manager) {
      const empty: PageLibraryNeedsResponse = {
        needed: [],
        installed: [],
        pending: [],
        failed: [],
        unknown: [],
        externalNetwork,
        available: [],
      };
      return c.json(empty);
    }
    const { collected, ensure } = await ensurePageLibrariesForPage({
      store: ctx.store,
      manager,
      projectId,
      entry,
      waitMs: Math.min(parsed.data.waitMs ?? 0, MAX_NEEDS_WAIT_MS),
    });
    if (ensure.installed.length) {
      log.info(`[page-libraries] ${projectId}/${entry} needed ${ensure.installed.join(', ')}`);
    }
    const ready = new Set(ensure.ready);
    const body: PageLibraryNeedsResponse = {
      needed: collected.lines.map((line) => ({
        library: line.library,
        name: line.name,
        version: line.version,
        ready: ready.has(pageLibraryKey(line)),
      })),
      installed: ensure.installed,
      pending: ensure.pending,
      failed: ensure.failed,
      unknown: collected.unknown,
      ...(ensure.blocked ? { blocked: ensure.blocked } : {}),
      externalNetwork,
      available: listedPageLibraries(await manager.usableLines()).map(
        ({ name, version, scriptOnly }) => ({ name, version, scriptOnly }),
      ),
    };
    return c.json(body);
  });

  return app;
}
