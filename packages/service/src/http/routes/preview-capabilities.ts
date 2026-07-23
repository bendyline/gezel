import { CreatePreviewCapabilityRequestSchema, type PreviewSource } from '@bendyline/gezel';
import { Hono } from 'hono';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import {
  type PreviewCapabilityStore,
  encodePreviewPath,
  normalizePreviewPath,
} from '../preview-capability.js';

/**
 * Authenticated minting endpoint for the otherwise header-less iframe flow.
 * Only root/UI callers may mint; session, third-party app, and paired-device
 * credentials are never accepted as preview authorities.
 */
export function previewCapabilityRoutes(
  ctx: ServiceContext,
  capabilities: PreviewCapabilityStore,
): Hono {
  const app = new Hono();

  app.post('/:projectId/preview-capability', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    const body = CreatePreviewCapabilityRequestSchema.parse(await c.req.json());
    const entryPath = normalizePreviewPath(body.path);
    if (entryPath === null) return c.json({ error: 'invalid preview path' }, 400);
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    if (body.source === 'type' && !project.projectType) {
      return c.json({ error: 'project has no applied project type' }, 409);
    }

    let additionalScopes: Array<{
      source: PreviewSource;
      path: string;
      subtree?: boolean;
    }> = [];
    if (body.source === 'type' && project.projectType) {
      const pt = project.projectType;
      const detail = await ctx.catalog
        .get('project-type', pt.id, pt.source, pt.version)
        .catch(() => null);
      if (!detail || detail.manifest.kind !== 'project-type') {
        return c.json({ error: 'applied project type not found' }, 404);
      }
      // Cross-source reads are trusted catalog metadata, never client input,
      // and attach only to the declared entry page that needs them.
      if (detail.manifest.pages?.entry === entryPath) {
        additionalScopes = (detail.manifest.pages.reads ?? []).map((read) => ({
          source: read.source,
          path: read.path,
          ...(read.subtree !== undefined ? { subtree: read.subtree } : {}),
        }));
      }
    }

    const minted = capabilities.mint({
      source: body.source as PreviewSource,
      projectId,
      entryPath: body.path,
      ...(additionalScopes.length > 0 ? { additionalScopes } : {}),
    });
    const suffix = encodePreviewPath(entryPath);
    const url = `/preview/${encodeURIComponent(minted.token)}/${body.source}/${encodeURIComponent(projectId)}/${suffix}`;
    c.header('cache-control', 'no-store');
    return c.json(
      {
        url,
        expiresAt: minted.expiresAt,
        scopePath: minted.scopePath,
      },
      201,
    );
  });

  return app;
}
