import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  PAGE_IMPORT_MAX_BYTES,
  type PageImportAvailability,
  PageImportRequestSchema,
} from '@bendyline/gezel';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { Hono } from 'hono';
import { resolveProjectTypeManifest } from '../../project-type/script-tools.js';
import { WorkspaceWriteDeniedError } from '../../workspace/errors.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { normalizePreviewPath } from '../preview-capability.js';

/** Uploads are first-party only: no visitor cookies, preview capabilities or model tokens. */
export function pageImportRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const active = new Map<string, number>();
  const attempts = new Map<string, { since: number; count: number }>();
  let total = 0;
  async function targets(projectId: string): Promise<PageImportAvailability[]> {
    const project = await ctx.store.getProject(projectId);
    const manifest = await resolveProjectTypeManifest(ctx.catalog, project);
    return Promise.all(
      (manifest?.pages?.imports ?? []).map(async (target) => {
        const gate = await ctx.store.assertWorkspaceWritable(projectId, {
          initiatedByGezel: true,
          path: target.path,
        });
        return {
          ...target,
          writable: gate.ok,
          ...(!gate.ok
            ? { reason: 'Enable managed workspace writes in Project Settings to add files.' }
            : {}),
        };
      }),
    );
  }
  app.get('/:projectId/page-imports', requireFirstParty(), async (c) => {
    try {
      return c.json(await targets(c.req.param('projectId')));
    } catch {
      return c.json({ error: 'Project unavailable.' }, 404);
    }
  });
  app.post('/:projectId/page-imports', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    const parsed = PageImportRequestSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid import target or filename.' }, 400);
    const { target: targetId, name } = parsed.data;
    for (const [id, window] of attempts)
      if (Date.now() - window.since >= 60_000) attempts.delete(id);
    const window = attempts.get(projectId) ?? { since: Date.now(), count: 0 };
    if (window.count >= 120)
      return c.json({ error: 'Too many imports. Try again in a minute.' }, 429);
    window.count++;
    attempts.set(projectId, window);
    if (total >= 4 || (active.get(projectId) ?? 0) >= 2)
      return c.json({ error: 'Too many imports. Try again shortly.' }, 429);
    total++;
    active.set(projectId, (active.get(projectId) ?? 0) + 1);
    let staging: string | undefined;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5 * 60_000)]);
    try {
      const target = (await targets(projectId)).find((t) => t.id === targetId);
      if (!target?.writable)
        return c.json({ error: target?.reason ?? 'Import target is not declared.' }, 403);
      const dir = normalizePreviewPath(target.path);
      if (dir === null) return c.json({ error: 'Invalid import destination.' }, 403);
      if (target.accept && !target.accept.includes(extname(name).toLowerCase()))
        return c.json({ error: 'This file type is not accepted here.' }, 400);
      const maxBytes = Math.min(
        target.maxFileBytes ?? PAGE_IMPORT_MAX_BYTES,
        PAGE_IMPORT_MAX_BYTES,
      );
      const root = await ctx.store.projectWorkspaceDir(projectId);
      await resolveInside(root, posix.join(dir, name), { allowRoot: false });
      if (Number(c.req.header('content-length')) > maxBytes)
        return c.json({ error: 'File exceeds the import size limit.' }, 413);
      if (!c.req.raw.body) return c.json({ error: 'Missing file bytes.' }, 400);
      staging = await mkdtemp(join(tmpdir(), 'gezel-import-'));
      const stagedPath = join(staging, 'file');
      let size = 0;
      await pipeline(
        Readable.fromWeb(c.req.raw.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            callback(size > maxBytes ? new Error('import-size-limit') : null, chunk);
          },
        }),
        createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      // Re-resolve at commit: revoking permissions or changing the project/type while
      // bytes arrive must not publish into the old or a newly selected destination.
      const current = (await targets(projectId)).find((t) => t.id === targetId);
      if (
        JSON.stringify(current) !== JSON.stringify(target) ||
        (await ctx.store.projectWorkspaceDir(projectId)) !== root
      )
        return c.json({ error: 'Import permissions changed. Try again.' }, 403);
      const ext = extname(name);
      for (let n = 0; n < 1000; n++) {
        signal.throwIfAborted();
        const savedName = n ? `${name.slice(0, name.length - ext.length)} (${n})${ext}` : name;
        const path = posix.join(dir, savedName);
        try {
          await ctx.store.importProjectWorkspaceFile(projectId, path, stagedPath, signal);
          return c.json({
            source: 'workspace' as const,
            path,
            name: savedName,
            size,
            mtime: Date.now(),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      return c.json({ error: 'Too many files with this name.' }, 409);
    } catch (error) {
      if (error instanceof WorkspaceWriteDeniedError)
        return c.json({ error: 'Workspace writes are disabled.' }, 403);
      if (error instanceof Error && error.message === 'import-size-limit')
        return c.json({ error: 'File exceeds the import size limit.' }, 413);
      if (signal.aborted) return c.json({ error: 'Import cancelled or timed out.' }, 408);
      // Do not leak host paths to an untrusted page.
      return c.json(
        { error: 'Could not import this file. Check the destination and permissions.' },
        400,
      );
    } finally {
      total--;
      const remaining = (active.get(projectId) ?? 1) - 1;
      if (remaining) active.set(projectId, remaining);
      else active.delete(projectId);
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  });
  return app;
}
