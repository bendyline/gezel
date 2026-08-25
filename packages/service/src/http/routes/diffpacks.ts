import {
  ApplyDiffpackRequestSchema,
  type ApplyDiffpackResponse,
  type DiffpackResponse,
  type DismissDiffpackResponse,
  type ListDiffpacksResponse,
  createLogger,
} from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { DiffpackDriftedError, DiffpackNotFoundError } from '../../diffpack/manager.js';
import { WorkspaceWriteDeniedError } from '../../workspace/errors.js';
import type { ServiceContext } from '../context.js';
import { buildDiffpackZip } from './diffpack-export.js';

const log = createLogger('http');

/**
 * Diffpacks — change sets a gezel proposed but never applied.
 *
 *   GET    /api/projects/:id/diffpacks
 *   GET    /api/projects/:id/diffpacks/:packId
 *   POST   /api/projects/:id/diffpacks/:packId/apply    { paths?, allowDrifted? }
 *   POST   /api/projects/:id/diffpacks/:packId/dismiss
 *   GET    /api/projects/:id/diffpacks/:packId/export   → application/zip
 *
 * The apply route is the ONLY place in the service that passes
 * `userInitiated` to the workspace write gate. That is deliberate and it is
 * the whole feature: the gezel drafted into artifacts because it holds no
 * write grant on the user's folder, so the authenticated click here — not the
 * gezel — is what performs the write. Nothing model-reachable can call it.
 */
export function diffpackRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/diffpacks', async (c) => {
    const out: ListDiffpacksResponse = { diffpacks: await ctx.diffpacks.list(c.req.param('id')) };
    return c.json(out);
  });

  app.get('/:id/diffpacks/:packId', async (c) => {
    const projectId = c.req.param('id');
    const packId = c.req.param('packId');
    try {
      const diffpack = await ctx.diffpacks.get(projectId, packId);
      const notes =
        (await ctx.store.readProjectArtifact(projectId, diffpack.notesPath).catch(() => null)) ??
        '';
      const out: DiffpackResponse = { diffpack, notes };
      return c.json(out);
    } catch (err) {
      if (err instanceof DiffpackNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.post('/:id/diffpacks/:packId/apply', async (c) => {
    const projectId = c.req.param('id');
    const packId = c.req.param('packId');
    const parsed = ApplyDiffpackRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = await ctx.diffpacks.apply(projectId, packId, parsed.data);
      const out: ApplyDiffpackResponse = {
        ok: result.ok,
        results: result.results,
        diffpack: await ctx.diffpacks.get(projectId, packId),
      };
      return c.json(out);
    } catch (err) {
      if (err instanceof DiffpackNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof DiffpackDriftedError) {
        return c.json({ error: err.message, code: 'drifted', paths: err.paths }, 409);
      }
      if (err instanceof WorkspaceWriteDeniedError) {
        // `userInitiated` waives external consent, so reaching here means the
        // project turned managed writes off outright — a deliberate "nothing
        // edits this project" setting the user has to lift themselves.
        return c.json({ error: err.message, code: err.reason }, 403);
      }
      throw err;
    }
  });

  app.post('/:id/diffpacks/:packId/dismiss', async (c) => {
    const projectId = c.req.param('id');
    try {
      const record = await ctx.diffpacks.dismiss(projectId, c.req.param('packId'));
      ctx.history
        ?.log({
          kind: 'project.diffpack.dismissed',
          projectId,
          summary: `Dismissed change proposal DP-${record.packId}`,
          details: { packId: record.packId },
        })
        .catch(() => {});
      const out: DismissDiffpackResponse = {
        ok: true,
        diffpack: await ctx.diffpacks.get(projectId, record.packId),
      };
      return c.json(out);
    } catch (err) {
      if (err instanceof DiffpackNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.get('/:id/diffpacks/:packId/export', async (c) => {
    const projectId = c.req.param('id');
    const packId = c.req.param('packId');
    try {
      const zip = await buildDiffpackZip(ctx, projectId, packId);
      return c.body(new Uint8Array(zip), 200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="DP-${packId}.zip"`,
      });
    } catch (err) {
      if (err instanceof DiffpackNotFoundError) return c.json({ error: err.message }, 404);
      log.warn(`[diffpack] export failed for ${packId}: ${String(err)}`);
      throw err;
    }
  });

  /* ─── Drafting ─────────────────────────────────────────────────────
   *
   * The surface a drafting session's workspace-write tools are pointed at.
   * Deliberately mirrors `/workspace/*` request and response shapes one for
   * one, because the MCP tools behind them are the SAME tools with the SAME
   * names — only the sink moves. A model drafting a proposal writes
   * `replace_in_file` exactly as it would against the workspace, and every
   * prompt, behavior, and error string it has learned still applies.
   *
   * No writability gate: the artifacts drawer is project-owned and a draft is
   * a proposal. The gate lives on `apply`, where the user is the actor.
   */

  app.get('/:id/diffpacks/:packId/draft/read', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'query parameter "path" is required' }, 400);
    const content = await ctx.diffpacks.drafts.read(c.req.param('id'), c.req.param('packId'), path);
    if (content === null) return c.json({ error: 'not found' }, 404);
    return c.json({ path, content, size: Buffer.byteLength(content) });
  });

  app.get('/:id/diffpacks/:packId/draft/stat', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'query parameter "path" is required' }, 400);
    const content = await ctx.diffpacks.drafts.read(c.req.param('id'), c.req.param('packId'), path);
    if (content !== null) return c.json({ kind: 'file', size: Buffer.byteLength(content) });
    // Not a drafted file — fall back to the real workspace so directory
    // stats and untouched paths still answer truthfully.
    return c.json(await ctx.store.statProjectWorkspacePath(c.req.param('id'), path));
  });

  app.put('/:id/diffpacks/:packId/draft/file', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; content?: string };
    if (typeof body.path !== 'string' || !body.path) return c.json({ error: 'missing path' }, 400);
    if (typeof body.content !== 'string') return c.json({ error: 'missing content string' }, 400);
    return draftEdit(c, async () => {
      await ctx.diffpacks.ensureForDraft(c.req.param('id'), c.req.param('packId'));
      return ctx.diffpacks.drafts.write(
        c.req.param('id'),
        c.req.param('packId'),
        body.path as string,
        body.content as string,
      );
    });
  });

  app.post('/:id/diffpacks/:packId/draft/replace', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return draftEdit(c, async () => {
      await ctx.diffpacks.ensureForDraft(c.req.param('id'), c.req.param('packId'));
      return ctx.diffpacks.drafts.replaceIn(c.req.param('id'), c.req.param('packId'), {
        path: String(body.path ?? ''),
        find: String(body.find ?? ''),
        replace: String(body.replace ?? ''),
        ...(body.occurrence !== undefined ? { occurrence: body.occurrence as number | 'all' } : {}),
      });
    });
  });

  app.post('/:id/diffpacks/:packId/draft/replace-lines', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return draftEdit(c, async () => {
      await ctx.diffpacks.ensureForDraft(c.req.param('id'), c.req.param('packId'));
      return ctx.diffpacks.drafts.replaceLines(c.req.param('id'), c.req.param('packId'), {
        path: String(body.path ?? ''),
        startLine: Number(body.startLine),
        endLine: Number(body.endLine),
        content: String(body.content ?? ''),
      });
    });
  });

  app.post('/:id/diffpacks/:packId/draft/insert-at-marker', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return draftEdit(c, async () => {
      await ctx.diffpacks.ensureForDraft(c.req.param('id'), c.req.param('packId'));
      return ctx.diffpacks.drafts.insertAtMarker(c.req.param('id'), c.req.param('packId'), {
        path: String(body.path ?? ''),
        marker: String(body.marker ?? ''),
        content: String(body.content ?? ''),
        ...(body.where === 'before' || body.where === 'after' ? { where: body.where } : {}),
      });
    });
  });

  app.delete('/:id/diffpacks/:packId/draft/path', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'query parameter "path" is required' }, 400);
    try {
      await ctx.diffpacks.ensureForDraft(c.req.param('id'), c.req.param('packId'));
      await ctx.diffpacks.drafts.delete(c.req.param('id'), c.req.param('packId'), path);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}

/**
 * Run one draft edit and answer in the `WorkspaceEditResponse` shape.
 *
 * Edit failures come back as 400 with the transform's own message — the
 * strings models are trained on by repetition ("pattern not found…re-read and
 * try again"). Flattening them to a generic error would make the drafting
 * surface measurably worse at recovering than the workspace one.
 */
async function draftEdit(
  c: Context,
  run: () => Promise<{
    path: string;
    diff: string;
    addedLines: number;
    removedLines: number;
    diffTruncated?: boolean;
  }>,
): Promise<Response> {
  try {
    const result = await run();
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}
