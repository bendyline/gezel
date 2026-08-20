/**
 * Knowledge catalogs (docs/knowledge-catalogs.md route table):
 *
 *   GET    /api/knowledge/catalogs                     installed refs + health + enabled state
 *   POST   /api/knowledge/install                      { source } → { jobId }
 *   GET    /api/knowledge/jobs/:jobId                  job snapshot
 *   GET    /api/knowledge/jobs/:jobId/events           SSE progress stream
 *   DELETE /api/knowledge/jobs/:jobId                  cancel
 *   PATCH  /api/knowledge/catalogs/:catalogId          enable / disable / auto-update
 *   DELETE /api/knowledge/catalogs/:catalogId          remove ref + private bytes
 *   POST   /api/knowledge/search                       browser/global catalog search
 *   GET    /api/knowledge/catalogs/:catalogId/topics   the shipped TOC
 *   GET    /api/knowledge/catalogs/:catalogId/documents?topic=&offset=&limit=
 *   GET    /api/knowledge/catalogs/:catalogId/document?id=<docId>   body + metadata
 *
 * Catalog ids resolve against THIS user's registry — never against request-
 * supplied paths. The document read uses a query param because document ids
 * legitimately contain slashes.
 */

import {
  KnowledgeInstallRequestSchema,
  KnowledgeSearchRequestSchema,
  UpdateKnowledgeCatalogRequestSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { KnowledgeNotFoundError } from '../../knowledge/manager.js';
import { embedQuery } from '../../memory/embeddings.js';
import type { ServiceContext } from '../context.js';

export function knowledgeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const manager = () => {
    if (!ctx.knowledge) throw new KnowledgeNotFoundError('knowledge subsystem not available');
    return ctx.knowledge;
  };

  app.onError((err, c) => {
    if (err instanceof KnowledgeNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  });

  app.get('/catalogs', async (c) => c.json({ catalogs: await manager().list() }));

  app.post('/install', async (c) => {
    const body = KnowledgeInstallRequestSchema.parse(await c.req.json());
    const { jobId } = manager().startInstall(body.source);
    return c.json({ jobId }, 202);
  });

  app.get('/jobs/:jobId', (c) => {
    const job = manager().getJob(c.req.param('jobId'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json(job);
  });

  app.get('/jobs/:jobId/events', (c) => {
    const jobId = c.req.param('jobId');
    const knowledge = manager();
    if (!knowledge.getJob(jobId)) return c.json({ error: 'job not found' }, 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = knowledge.subscribeJob(jobId, (event) => {
        void stream
          .writeSSE({ data: JSON.stringify(event) })
          .then(() => {
            if (event.type === 'done' || event.type === 'error') closed = true;
          })
          .catch(() => {
            closed = true;
          });
      });
      if (!unsubscribe) {
        closed = true;
        return;
      }
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(1000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  app.delete('/jobs/:jobId', (c) => {
    const cancelled = manager().cancelJob(c.req.param('jobId'));
    return c.json({ cancelled });
  });

  app.patch('/catalogs/:catalogId', async (c) => {
    const catalogId = c.req.param('catalogId');
    const body = UpdateKnowledgeCatalogRequestSchema.parse(await c.req.json());
    if (body.enabled !== undefined) {
      const ok = await manager().setEnabled(catalogId, body.enabled);
      if (!ok) return c.json({ error: 'catalog not found' }, 404);
    }
    return c.json({ ok: true });
  });

  app.delete('/catalogs/:catalogId', async (c) => {
    const removed = await manager().remove(c.req.param('catalogId'));
    if (!removed) return c.json({ error: 'catalog not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/search', async (c) => {
    const body = KnowledgeSearchRequestSchema.parse(await c.req.json());
    let vector: number[] | null = null;
    try {
      vector = await embedQuery(body.query);
    } catch {
      vector = null;
    }
    const results = await manager().searchUnified(body.query, {
      vector,
      maxResults: body.maxResults ?? 20,
    });
    const filtered = body.catalogs
      ? results.filter((r) => r.catalogId && body.catalogs?.includes(r.catalogId))
      : results;
    return c.json({ results: filtered.slice(0, body.maxResults ?? 20) });
  });

  app.get('/catalogs/:catalogId/topics', async (c) => {
    const topics = await manager().topics(c.req.param('catalogId'));
    return c.json({ topics });
  });

  app.get('/catalogs/:catalogId/documents', async (c) => {
    const topicId = c.req.query('topic');
    const offset = Number.parseInt(c.req.query('offset') ?? '0', 10) || 0;
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10) || 50;
    const page = await manager().documentsPage(c.req.param('catalogId'), {
      ...(topicId ? { topicId } : {}),
      offset,
      limit,
    });
    return c.json(page);
  });

  app.get('/catalogs/:catalogId/document', async (c) => {
    const documentId = c.req.query('id');
    if (!documentId) return c.json({ error: 'id query parameter required' }, 400);
    const doc = await manager().getDocument(c.req.param('catalogId'), documentId);
    if (!doc) return c.json({ error: 'document not found' }, 404);
    return c.json(doc);
  });

  return app;
}
