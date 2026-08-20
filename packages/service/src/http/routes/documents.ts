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
    // `stats=1` / `hidden=1` mirror the project file routes — the documents
    // library is browsed through the same file panel, which sorts by mtime and
    // has a show-hidden key. Only meaningful with `recursive=1`.
    const withStats = c.req.query('stats') === '1';
    const includeHidden = c.req.query('hidden') === '1';
    if (recursive) {
      const detailed = await ctx.store.listDocumentsRecursiveDetailed({
        ...(withStats ? { withStats: true } : {}),
        ...(includeHidden ? { includeHidden: true } : {}),
      });
      return c.json({ files: detailed.entries, truncated: detailed.truncated });
    }
    return c.json({ files: await ctx.store.listDocuments(subpath) });
  });

  // Same "Open" affordance the project file panels have, now that the library
  // is browsed through the same panel. Same argv-array launch as
  // `POST /api/projects/:id/reveal`: never an interpolated shell string, since
  // the documents root is relocatable via ExternalFolders.
  app.post('/reveal', async (c) => {
    const dir = ctx.store.documentsDir();
    const { execFile } = await import('node:child_process');
    const launcher: { cmd: string; args: string[] } =
      process.platform === 'darwin'
        ? { cmd: 'open', args: [dir] }
        : process.platform === 'win32'
          ? { cmd: 'explorer', args: [dir] }
          : { cmd: 'xdg-open', args: [dir] };
    execFile(launcher.cmd, launcher.args, { windowsHide: true }, () => {});
    return c.json({ ok: true, path: dir });
  });

  app.get('/search', async (c) => {
    const params = SearchDocumentsRequestSchema.parse({
      q: c.req.query('q'),
      maxResults: c.req.query('maxResults')
        ? Number.parseInt(c.req.query('maxResults')!, 10)
        : undefined,
    });
    // The library is a project, so its content index is the one that has
    // ranked, embedding-backed retrieval over these documents. No queryVector
    // is passed on purpose: searchLibrary self-embeds the query when the vec
    // table is available, so this single-call route is already hybrid — the
    // precomputed-vector parameter only pays off in multi-corpus fan-outs.
    const libraryId = await ctx.store.sharedProjectId();
    if (!libraryId) return c.json({ results: [], engine: 'unavailable' });
    const found = await ctx.contentIndex.searchLibrary(libraryId, params.q, {
      ...(params.maxResults ? { maxResults: params.maxResults } : {}),
    });
    return c.json(found);
  });

  app.get('/read', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    if (c.req.query('raw') === '1') {
      return serveRawFile(c, ctx.store.documentsDir(), filePath);
    }
    // 1. Global documents library — the canonical interpretation. Model
    //    callers ask for `as=markdown` so office formats arrive readable
    //    instead of as mojibake; the UI's own reads stay byte-for-byte.
    if (c.req.query('as') === 'markdown') {
      const doc = await ctx.store.readDocumentAsMarkdown(filePath);
      if (doc !== null) {
        return c.json({
          path: filePath,
          content: doc.content,
          kind: 'document' as const,
          ...(doc.converted ? { converted: true } : {}),
        });
      }
    } else {
      const content = await ctx.store.readDocument(filePath);
      if (content !== null) {
        // Byte size rides along so a viewer that cannot preview the content
        // (binaries) can still say how big the file is. The decoded string's
        // length does not answer that — UTF-8 replacement chars destroy it.
        const size = await ctx.store.documentSize(filePath);
        return c.json({
          path: filePath,
          content,
          kind: 'document' as const,
          ...(size === null ? {} : { size }),
        });
      }
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
    await ctx.store.writeDocument(body.path, body.content, {
      ...(body.gezelId ? { gezelId: body.gezelId } : {}),
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    });
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
    const gezelId = c.req.query('gezelId');
    await ctx.store.deleteDocument(filePath, gezelId ? { gezelId } : undefined);
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
