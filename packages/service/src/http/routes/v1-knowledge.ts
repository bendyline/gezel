import {
  AppKnowledgeActionSchema,
  AppKnowledgeQuerySchema,
  AppKnowledgeRetrievalSchema,
  type AppKnowledgeState,
  AppKnowledgeStateSchema,
} from '@bendyline/gezel/app-models';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ServiceContext } from '../context.js';

/** Public app surface: registered catalogs and reference passages only. */
export function v1KnowledgeRoutes(ctx: Pick<ServiceContext, 'knowledge' | 'relevance'>): Hono {
  const app = new Hono();
  let active = 0;
  app.use('*', bodyLimit({ maxSize: 40_000 }));
  app.use('*', async (c, next) => {
    if (!ctx.knowledge)
      return c.json(
        {
          error: {
            code: 'knowledge_unavailable',
            message: 'Knowledge catalogs are unavailable in this service.',
          },
        },
        503,
      );
    if (active >= 4)
      return c.json(
        {
          error: {
            code: 'rate_limited',
            message: 'Knowledge service is busy.',
          },
        },
        429,
      );
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  app.get('/state', async (c) => {
    const manager = ctx.knowledge!;
    const [installed, available, relevance] = await Promise.all([
      manager.list(),
      manager.available(),
      ctx.relevance.status(),
    ]);
    const jobs = new Map(manager.activeInstalls().map((job) => [job.catalogId, job]));
    const catalogs = new Map<string, AppKnowledgeState['catalogs'][number]>();
    for (const entry of available)
      catalogs.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        version: entry.version,
        installedVersion: null,
        enabled: false,
        updateAvailable: false,
        downloadBytes: entry.archiveBytes,
        documents: entry.documents,
        state: 'available',
        percent: null,
        message: null,
      });
    for (const entry of installed) {
      const previous = catalogs.get(entry.ref.catalogId);
      catalogs.set(entry.ref.catalogId, {
        id: entry.ref.catalogId,
        name: entry.name ?? entry.ref.catalogId,
        description: entry.description ?? '',
        version: entry.availableVersion ?? entry.ref.version,
        installedVersion: entry.ref.version,
        enabled: entry.enabled,
        updateAvailable: entry.updateAvailable,
        downloadBytes: previous?.downloadBytes ?? null,
        documents: entry.documents ?? null,
        state: entry.disabledReason ? 'error' : 'installed',
        percent: null,
        message: entry.disabledReason ?? null,
      });
    }
    for (const entry of catalogs.values()) {
      const job = jobs.get(entry.id);
      const snapshot = manager.getJob(entry.id);
      if (job) {
        entry.state = 'downloading';
        entry.percent =
          job.bytesTotal > 0 ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100) : null;
        entry.message = 'Downloading catalog…';
      } else if (snapshot?.error) {
        entry.state = 'error';
        entry.message = 'The catalog download failed. Try downloading it again.';
      }
    }
    const selected = relevance.models.find((model) => model.id === relevance.modelId);
    return c.json(
      AppKnowledgeStateSchema.parse({
        catalogs: [...catalogs.values()],
        reranker: {
          ready: selected?.installed === true,
          downloading: relevance.progress !== undefined,
          message:
            relevance.error ??
            (selected?.installed
              ? null
              : 'Download the relevance model before using knowledge catalogs.'),
        },
      }),
    );
  });
  app.post('/update', async (c) => {
    const action = AppKnowledgeActionSchema.parse(await c.req.json());
    const manager = ctx.knowledge!;
    if (action.action === 'prepare-reranker') {
      const setting = await ctx.relevance.setting();
      if (!setting.spec)
        return c.json(
          {
            error: {
              code: 'reranker_unavailable',
              message: 'No relevance model is configured.',
            },
          },
          409,
        );
      const result = await ctx.relevance.install(setting.spec.id);
      if (!result.started && !result.installed)
        return c.json(
          {
            error: {
              code: 'reranker_unavailable',
              message: result.reason ?? 'The relevance model could not be downloaded.',
            },
          },
          409,
        );
    } else if (action.action === 'install') {
      const available = await manager.available();
      if (!available.some((entry) => entry.id === action.catalogId))
        return c.json(
          {
            error: {
              code: 'catalog_not_found',
              message: 'That catalog is not available.',
            },
          },
          404,
        );
      if (manager.activeInstalls().length >= 2)
        return c.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Wait for a catalog download to finish.',
            },
          },
          429,
        );
      manager.startInstall({
        kind: 'catalog',
        id: action.catalogId,
        placement: 'user',
      });
    } else if (action.action === 'cancel') {
      manager.cancelJob(action.catalogId);
    } else {
      const changed =
        action.action === 'remove'
          ? await manager.remove(action.catalogId)
          : await manager.setEnabled(action.catalogId, action.action === 'enable');
      if (!changed)
        return c.json(
          {
            error: {
              code: 'catalog_not_found',
              message: 'That catalog is not installed.',
            },
          },
          404,
        );
    }
    return c.json({ ok: true });
  });
  app.post('/retrieve', async (c) => {
    const query = AppKnowledgeQuerySchema.parse(await c.req.json());
    const manager = ctx.knowledge!;
    const installed = await manager.list();
    const enabled = installed.filter((entry) => entry.enabled);
    if (enabled.some((entry) => !entry.mounted))
      return c.json(
        {
          error: {
            code: 'knowledge_unavailable',
            message: 'An enabled knowledge catalog is unavailable.',
          },
        },
        409,
      );
    if (enabled.length === 0) return c.json({ reranked: true as const, passages: [] });
    const activeModel = await ctx.relevance.forSurface('search', {
      enabled: true,
    });
    if (!activeModel)
      return c.json(
        {
          error: {
            code: 'reranker_required',
            message: 'Download the relevance model in AI settings before using knowledge catalogs.',
          },
        },
        409,
      );
    c.req.raw.signal.throwIfAborted();
    const hits = await manager.searchUnified(query.query, {
      vector: null,
      localModelsOnly: true,
      maxResults: 24,
      queryEmbedBudgetMs: 5000,
    });
    c.req.raw.signal.throwIfAborted();
    const passages: Array<{
      uri: string;
      title: string;
      text: string;
      catalogId: string;
      version: string;
    }> = [];
    for (const hit of hits.slice(0, 24)) {
      if (!hit.uri) continue;
      const citation = await manager.resolveCitation(hit.uri);
      if (!citation.ok) continue;
      const text = (citation.chunk?.text ?? citation.markdown ?? '').slice(0, 6000);
      if (!text) continue;
      passages.push({
        uri: hit.uri,
        title: citation.title.slice(0, 256),
        text,
        catalogId: citation.uri.catalogId,
        version: citation.catalogVersion,
      });
    }
    if (!passages.length) return c.json({ reranked: true as const, passages: [] });
    const result = await ctx.relevance.scorer.score({
      model: activeModel.model,
      query: query.query,
      passages: passages.map((passage) => passage.text),
      waitForLoad: true,
      budgetMs: 30_000,
    });
    c.req.raw.signal.throwIfAborted();
    if (
      result.status !== 'scored' ||
      result.scores?.length !== passages.length ||
      result.scores.some((score) => score === null || !Number.isFinite(score))
    )
      return c.json(
        {
          error: {
            code: 'reranker_required',
            message: 'The relevance model could not score every passage. Retry the request.',
          },
        },
        409,
      );
    const ordered = passages
      .map((passage, index) => ({ passage, score: result.scores![index]! }))
      .sort((a, b) => b.score - a.score);
    const selected: typeof passages = [];
    let remaining = query.maxCharacters;
    for (const { passage, score } of ordered) {
      if (activeModel.thresholds && score < activeModel.thresholds.keep) continue;
      if (!remaining || selected.length >= query.maxResults) break;
      const text = passage.text.slice(0, remaining);
      selected.push({ ...passage, text });
      remaining -= text.length;
    }
    return c.json(AppKnowledgeRetrievalSchema.parse({ reranked: true, passages: selected }));
  });
  return app;
}
