import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { PageReadRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { realpathContained, safeJoin } from '../../fs/safe-paths.js';
import { resolvePageReads } from '../../project-type/script-tools.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { normalizePreviewPath, pathIsInScope } from '../preview-capability.js';

const log = createLogger('http');

/** Hard ceiling on a single page read; the shim advertises it via `init.limits`. */
export const PAGE_READ_MAX_BYTES = 2 * 1024 * 1024;

/** Watch polling rides this route, so the budget is generous vs page-invoke. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_READS = 600;

function etagOf(size: number, mtimeMs: number): string {
  return createHash('sha256')
    .update(`${size}:${Math.trunc(mtimeMs)}`)
    .digest('base64url')
    .slice(0, 16);
}

/**
 * The read half of the first-party page bridge (Output Pane API v1).
 *
 * A served type page reads files its manifest declares in `pages.reads`;
 * the parent Output pane relays the request here with its ui bearer, the
 * same trust shape as page-invoke. Scopes are re-derived from the applied
 * type's manifest per request — never trusted from the client — and every
 * path goes through the standard traversal fences. The preview-capability
 * fetch path stays alive in parallel for v0 pages, browser mode, and media
 * URLs; this route exists so embedded pages never juggle capability expiry.
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
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);

    const scopes = await resolvePageReads(ctx.catalog, project);
    if (!scopes) return c.json({ error: 'project has no applied project type' }, 404);

    const requested = normalizePreviewPath(body.path);
    if (requested === null) return c.json({ error: 'bad path' }, 400);
    const inScope = scopes.some(
      (scope) =>
        scope.source === body.source &&
        (scope.subtree
          ? pathIsInScope(requested, normalizePreviewPath(scope.path) ?? scope.path)
          : requested === normalizePreviewPath(scope.path)),
    );
    if (!inScope) return c.json({ error: 'path is not a declared page read' }, 403);

    const baseDir =
      body.source === 'workspace'
        ? await ctx.store.projectWorkspaceDir(projectId)
        : ctx.store.projectArtifactsDir(projectId);
    const full = safeJoin(baseDir, requested);
    if (!full || !(await realpathContained(baseDir, full))) {
      return c.json({ error: 'path traversal blocked' }, 400);
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(full);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }

    if (body.op === 'stat') {
      if (stats.isDirectory()) {
        // Directory etag folds the listing so a rename/add/delete flips it
        // even when the directory inode's own mtime lags the change.
        const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
        const listed = await Promise.all(
          entries.map(async (entry) => {
            const child = await stat(`${full}/${entry.name}`).catch(() => null);
            return `${entry.name}:${entry.isDirectory() ? 'dir' : 'file'}:${Math.trunc(child?.mtimeMs ?? 0)}`;
          }),
        );
        const digest = createHash('sha256')
          .update(listed.sort().join('\n'))
          .digest('base64url')
          .slice(0, 16);
        return c.json({ op: 'stat', etag: digest, mtime: stats.mtimeMs });
      }
      return c.json({
        op: 'stat',
        etag: etagOf(stats.size, stats.mtimeMs),
        size: stats.size,
        mtime: stats.mtimeMs,
      });
    }

    if (body.op === 'list') {
      if (!stats.isDirectory()) return c.json({ error: 'not a directory' }, 400);
      const entries = await readdir(full, { withFileTypes: true });
      const listed = (
        await Promise.all(
          entries.map(async (entry) => {
            const child = await stat(`${full}/${entry.name}`).catch(() => null);
            if (!child) return null;
            return {
              name: entry.name,
              kind: entry.isDirectory() ? ('dir' as const) : ('file' as const),
              size: child.size,
              mtime: child.mtimeMs,
            };
          }),
        )
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const digest = createHash('sha256')
        .update(
          listed
            .map((e) => `${e.name}:${e.kind}:${Math.trunc(e.mtime)}`)
            .sort()
            .join('\n'),
        )
        .digest('base64url')
        .slice(0, 16);
      return c.json({ op: 'list', entries: listed, etag: digest, mtime: stats.mtimeMs });
    }

    if (stats.isDirectory()) return c.json({ error: 'is a directory' }, 400);
    const cap = Math.min(body.maxBytes ?? PAGE_READ_MAX_BYTES, PAGE_READ_MAX_BYTES);
    if (stats.size > cap) {
      return c.json({ error: `file exceeds read cap (${stats.size} > ${cap} bytes)` }, 413);
    }
    let buf: Awaited<ReturnType<typeof readFile>>;
    try {
      buf = await readFile(full);
    } catch (err) {
      log.warn(`[page-read] read failed for ${requested}:`, err);
      return c.json({ error: 'not found' }, 404);
    }
    const as = body.as ?? (requested.endsWith('.json') ? 'json' : 'text');
    const encoding = as === 'bytes' ? 'base64' : 'utf8';
    return c.json({
      op: 'read',
      content: buf.toString(encoding),
      encoding,
      etag: etagOf(stats.size, stats.mtimeMs),
      size: stats.size,
      mtime: stats.mtimeMs,
    });
  });

  return app;
}
