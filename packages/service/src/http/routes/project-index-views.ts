import {
  GalleryRequestSchema,
  GalleryShelfRequestSchema,
  TimelineBucketRequestSchema,
  TimelineRequestSchema,
  folderKindOf,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * Index reads for the project Views tab that have a view of their own:
 *
 *   GET /api/projects/:id/index/gallery        → GalleryResponse
 *   GET /api/projects/:id/index/gallery/shelf  → GalleryShelfResponse
 *   GET /api/projects/:id/index/timeline       → TimelineResponse
 *   GET /api/projects/:id/index/timeline/bucket → TimelineBucketResponse
 *
 * Reads only; nothing here writes to the index or the workspace.
 */
export function projectIndexViewRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const folderKind = async (projectId: string) => {
    const project = await ctx.store.getProject(projectId).catch(() => null);
    return project ? { kind: folderKindOf(project) } : null;
  };

  app.get('/:id/index/gallery', async (c) => {
    const parsed = GalleryRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    }
    const projectId = c.req.param('id');
    const project = await folderKind(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    return c.json(await ctx.contentIndex.gallery(projectId, parsed.data, project.kind));
  });

  app.get('/:id/index/gallery/shelf', async (c) => {
    const parsed = GalleryShelfRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    }
    const projectId = c.req.param('id');
    const project = await folderKind(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const page = await ctx.contentIndex.galleryShelf(projectId, parsed.data, project.kind);
    return page ? c.json(page) : c.json({ error: 'shelf not found' }, 404);
  });

  app.get('/:id/index/timeline', async (c) => {
    const parsed = TimelineRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    }
    const projectId = c.req.param('id');
    if (!(await folderKind(projectId))) return c.json({ error: 'project not found' }, 404);
    return c.json(await ctx.contentIndex.timeline(projectId, parsed.data));
  });

  app.get('/:id/index/timeline/bucket', async (c) => {
    const parsed = TimelineBucketRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    }
    const projectId = c.req.param('id');
    if (!(await folderKind(projectId))) return c.json({ error: 'project not found' }, 404);
    const detail = await ctx.contentIndex.timelineBucket(projectId, parsed.data);
    return detail ? c.json(detail) : c.json({ error: 'not indexed' }, 404);
  });

  return app;
}
