import {
  CreateDocumentFolderRequestSchema,
  RenameDocumentRequestSchema,
  SearchDocumentsRequestSchema,
  WriteDocumentRequestSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { DocumentPathExistsError, DocumentPathNotFoundError } from '../../fs/documents-store.js';
import { realpathContained, safeJoin } from '../../fs/safe-paths.js';
import type { ServiceContext } from '../context.js';

export function documentRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const subpath = c.req.query('path') ?? '';
    const recursive = c.req.query('recursive') === '1';
    const entries = recursive
      ? await ctx.store.listDocumentsRecursive()
      : await ctx.store.listDocuments(subpath);
    return c.json({ files: entries });
  });

  app.get('/search', async (c) => {
    const params = SearchDocumentsRequestSchema.parse({
      q: c.req.query('q'),
      maxResults: c.req.query('maxResults')
        ? Number.parseInt(c.req.query('maxResults')!, 10)
        : undefined,
    });
    const results = await ctx.globalIndex.searchDocuments(params.q, params.maxResults);
    const status = await ctx.globalIndex.status();
    return c.json({ results, engine: status.available ? 'fts' : 'unavailable' });
  });

  app.get('/read', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    if (c.req.query('raw') === '1') {
      return serveRawFile(c, ctx.store.documentsDir(), filePath);
    }
    // 1. Global documents library — the canonical interpretation.
    const content = await ctx.store.readDocument(filePath);
    if (content !== null) {
      return c.json({ path: filePath, content, kind: 'document' as const });
    }
    // 2. Fuzzy fallback: small models routinely confuse "document" vs
    //    "artifact" and omit (or mis-place) the `artifacts/` infix in
    //    paths returned to `ask_user_question`. Rather than surface a
    //    404 that blocks the user from reviewing real content, try the
    //    per-project documents dir and the per-project artifacts dir
    //    before giving up. The response `kind` tells the UI what it
    //    actually resolved to so the chip label matches reality.
    const m = filePath.match(/^projects\/([^\/]+)\/(.+)$/);
    if (m) {
      const projectId = m[1]!;
      const rest = m[2]!;
      const docRel = rest.replace(/^documents\//, '');
      const projectDoc = await ctx.store.readProjectDoc(projectId, docRel);
      if (projectDoc !== null) {
        return c.json({
          path: filePath,
          content: projectDoc,
          kind: 'project-document' as const,
          resolvedFrom: { projectId, relativePath: docRel },
        });
      }
      const artifactRel = rest.replace(/^artifacts\//, '');
      const artifact = await ctx.store.readProjectArtifact(projectId, artifactRel);
      if (artifact !== null) {
        return c.json({
          path: filePath,
          content: artifact,
          kind: 'artifact' as const,
          resolvedFrom: { projectId, relativePath: artifactRel },
        });
      }
    }
    return c.json({ error: 'not found' }, 404);
  });

  app.put('/write', async (c) => {
    const body = WriteDocumentRequestSchema.parse(await c.req.json());
    await ctx.store.writeDocument(body.path, body.content);
    return c.json({ ok: true, path: body.path });
  });

  // Binary write — body is the raw bytes, `?path=` is the target.
  // Powers the squisq editor's Files panel (image uploads, etc.) for
  // documents. Text edits still go through PUT /write (JSON payload);
  // this endpoint exists because that route's `WriteDocumentRequestSchema`
  // expects a UTF-8 `content` field.
  app.put('/raw', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    await ctx.store.writeDocumentBinary(filePath, buf);
    return c.json({ ok: true, path: filePath });
  });

  app.delete('/delete', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    await ctx.store.deleteDocument(filePath);
    return c.json({ ok: true });
  });

  app.post('/mkdir', async (c) => {
    const body = CreateDocumentFolderRequestSchema.parse(await c.req.json());
    await ctx.store.createDocumentFolder(body.path);
    return c.json({ ok: true, path: body.path });
  });

  app.post('/rename', async (c) => {
    const body = RenameDocumentRequestSchema.parse(await c.req.json());
    try {
      await ctx.store.renameDocument(body.fromPath, body.toPath);
      return c.json({ ok: true, fromPath: body.fromPath, toPath: body.toPath });
    } catch (error) {
      if (error instanceof DocumentPathExistsError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof DocumentPathNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  return app;
}

async function serveRawFile(c: import('hono').Context, base: string, filePath: string) {
  const { readFile } = await import('node:fs/promises');
  const { mimeTypeForPath } = await import('../mime.js');
  const full = safeJoin(base, filePath);
  if (!full || !(await realpathContained(base, full))) {
    return c.json({ error: 'path traversal' }, 400);
  }
  try {
    const buf = await readFile(full);
    return c.body(buf, 200, { 'content-type': mimeTypeForPath(filePath) });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
}
