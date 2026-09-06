/**
 * Knowledge catalogs (docs/knowledge-catalogs.md route table):
 *
 *   GET    /api/knowledge/catalogs                     installed refs + health + enabled state + update flags
 *   GET    /api/knowledge/available                    gilde entries joined with this user's state
 *   GET    /api/knowledge/updates                      installed catalogs with a newer gilde version
 *   POST   /api/knowledge/install                      { source } → { jobId, alreadyRunning }
 *   POST   /api/knowledge/catalogs/:id/install         install a gilde entry, events as SSE
 *   DELETE /api/knowledge/catalogs/:id/install         cancel that install
 *   GET    /api/knowledge/active-installs              running installs with their latest progress
 *   GET    /api/knowledge/incomplete                   partial downloads no job is writing
 *   DELETE /api/knowledge/incomplete/:key              delete one
 *   GET    /api/knowledge/jobs/:jobId                  job snapshot
 *   GET    /api/knowledge/jobs/:jobId/events           SSE progress stream
 *   DELETE /api/knowledge/jobs/:jobId                  cancel
 *   PATCH  /api/knowledge/catalogs/:catalogId          enable / disable / auto-update
 *   DELETE /api/knowledge/catalogs/:catalogId          remove ref + private bytes
 *   POST   /api/knowledge/search                       browser/global catalog search
 *   GET    /api/knowledge/catalogs/:catalogId/topics   the shipped TOC
 *   GET    /api/knowledge/catalogs/:catalogId/documents?topic=&offset=&limit=&descendants=0
 *   GET    /api/knowledge/catalogs/:catalogId/document?id=<docId>   body + metadata
 *   GET    /api/knowledge/catalogs/:catalogId/assets                the declared image assets
 *   GET    /api/knowledge/catalogs/:catalogId/assets/<path>?v=      one asset's bytes
 *
 * Installs run as background jobs owned by the KnowledgeManager's registry;
 * the SSE routes are subscribers, so a client disconnect detaches the
 * consumer without abandoning the download. Cancel is the explicit DELETE.
 * Catalog ids resolve against THIS user's registry — never against request-
 * supplied paths. The document read uses a query param because document ids
 * legitimately contain slashes.
 */

import type { KnowledgeUpdatesResponse } from '@bendyline/gezel';
import {
  KnowledgeAssetPathSchema,
  KnowledgeInstallRequestSchema,
  KnowledgeSearchRequestSchema,
  UpdateKnowledgeCatalogRequestSchema,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { KnowledgeNotFoundError } from '../../knowledge/manager.js';
import { embedQuery } from '../../memory/embeddings.js';
import type { ServiceContext } from '../context.js';
import { subscribeToInstallSse } from './install-sse.js';

const NETWORK_BLOCKED = {
  error: 'network-blocked',
  message:
    'Downloading knowledge catalogs needs app network access, which the security policy turns off.',
} as const;

export function knowledgeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const manager = () => {
    if (!ctx.knowledge) throw new KnowledgeNotFoundError('knowledge subsystem not available');
    return ctx.knowledge;
  };
  const networkBlocked = async () =>
    !resolveSecurityPolicy(await ctx.store.readConfig()).allowAppNetwork;

  app.onError((err, c) => {
    if (err instanceof KnowledgeNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  });

  app.get('/catalogs', async (c) => c.json({ catalogs: await manager().list() }));

  app.get('/available', async (c) => c.json({ catalogs: await manager().available() }));

  /**
   * Installed catalogs for which the shipped gilde content carries a newer
   * version. Read-only and offline: the answer comes from the pinned content,
   * and installing an update is `POST /catalogs/:id/install`.
   */
  app.get('/updates', async (c) => {
    const body: KnowledgeUpdatesResponse = {
      source: 'gilde',
      checkedAt: new Date().toISOString(),
      updates: await manager().updates(),
    };
    return c.json(body);
  });

  app.get('/active-installs', (c) => c.json({ installs: manager().activeInstalls() }));

  app.get('/incomplete', async (c) =>
    c.json({ incomplete: await manager().listIncompleteDownloads() }),
  );

  app.delete('/incomplete/:key', async (c) => {
    const removed = await manager().deleteIncompleteDownload(c.req.param('key'));
    if (!removed) return c.json({ error: 'no such download' }, 404);
    return c.json({ ok: true });
  });

  app.post('/install', async (c) => {
    const body = KnowledgeInstallRequestSchema.parse(await c.req.json());
    if (body.source.kind !== 'file' && (await networkBlocked())) {
      return c.json(NETWORK_BLOCKED, 403);
    }
    const { jobId, alreadyRunning } = manager().startInstall(body.source);
    return c.json({ jobId, alreadyRunning }, 202);
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
    return streamSSE(c, (stream) =>
      subscribeToInstallSse(knowledge.installRegistry, jobId, stream),
    );
  });

  app.delete('/jobs/:jobId', (c) => {
    const cancelled = manager().cancelJob(c.req.param('jobId'));
    return c.json({ cancelled });
  });

  /**
   * Install a gilde `knowledge-catalog` entry. The job id is the catalog id,
   * so a second POST for a running id attaches to the in-flight install
   * rather than starting a parallel one; the auto-updater lands on the same
   * job. `?version=` pins an older release; `?placement=user` keeps the
   * bytes private even when a machine-shared store is available.
   */
  app.post('/catalogs/:catalogId/install', async (c) => {
    if (await networkBlocked()) return c.json(NETWORK_BLOCKED, 403);
    const version = c.req.query('version');
    const placement = c.req.query('placement');
    const { source } = KnowledgeInstallRequestSchema.parse({
      source: {
        kind: 'catalog',
        id: c.req.param('catalogId'),
        ...(version ? { version } : {}),
        ...(placement ? { placement } : {}),
      },
    });
    const knowledge = manager();
    const { jobId } = knowledge.startInstall(source);
    return streamSSE(c, (stream) =>
      subscribeToInstallSse(knowledge.installRegistry, jobId, stream),
    );
  });

  /** Explicitly cancel an in-flight catalog install. Disconnect alone does not cancel. */
  app.delete('/catalogs/:catalogId/install', (c) =>
    c.json({ aborted: manager().cancelJob(c.req.param('catalogId')) }),
  );

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
      descendants: c.req.query('descendants') !== '0',
    });
    return c.json(page);
  });

  app.get('/catalogs/:catalogId/assets', async (c) => {
    const assets = await manager().assets(c.req.param('catalogId'));
    return c.json({ assets });
  });

  // Served as bytes for the viewer's media provider. The manifest declaration
  // is the authorization (extraction reconciled and hashed every entry), the
  // sha256 doubles as the ETag, and an SVG is sandboxed in case a person
  // opens the URL directly — the format already refuses active SVG content.
  app.get('/catalogs/:catalogId/assets/:path{.+}', async (c) => {
    const catalogId = c.req.param('catalogId');
    const parsed = KnowledgeAssetPathSchema.safeParse(`assets/${c.req.param('path')}`);
    if (!parsed.success) return c.json({ error: 'invalid asset path' }, 400);
    const version = c.req.query('v');
    if (version && version !== manager().mountedVersion(catalogId)) {
      return c.json({ error: 'catalog version not mounted' }, 404);
    }
    const asset = await manager().readAsset(catalogId, parsed.data);
    if (!asset) return c.json({ error: 'asset not found' }, 404);
    const etag = `"${asset.sha256}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.body(Buffer.from(asset.bytes), 200, {
      'Content-Type': asset.contentType,
      'Content-Length': String(asset.sizeBytes),
      ETag: etag,
      'Cache-Control': version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': 'inline',
      ...(asset.contentType === 'image/svg+xml'
        ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" }
        : {}),
    });
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
