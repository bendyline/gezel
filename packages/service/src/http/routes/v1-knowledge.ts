import type { UnifiedSearchResult } from '@bendyline/gezel';
import {
  AppKnowledgeActionSchema,
  AppKnowledgeQuerySchema,
  AppKnowledgeRelevanceSchema,
  AppKnowledgeRetrievalSchema,
  type AppKnowledgeState,
  AppKnowledgeStateSchema,
} from '@bendyline/gezel/app-models';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { admitsUnjudgedKnowledge } from '../../search/project-retrieval.js';
import type { ServiceContext } from '../context.js';

interface Passage {
  uri: string;
  title: string;
  text: string;
  catalogId: string;
  version: string;
}

/**
 * Bundled catalogs (the Handboek, Gezel's own manual) belong to Gezel, not to
 * connected apps. They are enabled on every install, so exposing them would
 * hand each app a catalog the person never chose — and with it a relevance
 * model requirement and Gezel help text in unrelated prompts.
 */
function appCatalog(entry: { source?: string }): boolean {
  return entry.source !== 'bundled';
}

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
    const [listed, available, relevance] = await Promise.all([
      manager.list(),
      manager.available(),
      ctx.relevance.status(),
    ]);
    const installed = listed.filter(appCatalog);
    const hidden = new Set(
      listed.filter((entry) => !appCatalog(entry)).map((entry) => entry.ref.catalogId),
    );
    const jobs = new Map(manager.activeInstalls().map((job) => [job.catalogId, job]));
    const catalogs = new Map<string, AppKnowledgeState['catalogs'][number]>();
    for (const entry of available) {
      if (hidden.has(entry.id)) continue;
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
    }
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
      const target = (await manager.list()).find(
        (entry) => entry.ref.catalogId === action.catalogId,
      );
      const changed =
        target !== undefined &&
        appCatalog(target) &&
        (action.action === 'remove'
          ? await manager.remove(action.catalogId)
          : await manager.setEnabled(action.catalogId, action.action === 'enable'));
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
  app.get('/relevance', async (c) => {
    const relevance = await ctx.relevance.status();
    const selected = relevance.models.find((model) => model.id === relevance.modelId);
    const progress = relevance.progress;
    return c.json(
      AppKnowledgeRelevanceSchema.parse({
        ready: selected?.installed === true,
        downloading: progress !== undefined,
        percent:
          progress && progress.bytesTotal > 0
            ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100)
            : null,
        downloadBytes:
          selected && !selected.installed && relevance.status !== 'blocked-network'
            ? selected.approxBytes
            : null,
      }),
    );
  });
  app.post('/retrieve', async (c) => {
    const query = AppKnowledgeQuerySchema.parse(await c.req.json());
    const required = query.rerank === 'required';
    const manager = ctx.knowledge!;
    const installed = await manager.list();
    const enabled = installed.filter((entry) => entry.enabled && appCatalog(entry));
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
    if (!activeModel && required)
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
      catalogs: enabled.map((entry) => entry.ref.catalogId),
    });
    c.req.raw.signal.throwIfAborted();
    const candidates: Array<{ hit: UnifiedSearchResult; passage: Passage }> = [];
    for (const hit of hits.slice(0, 24)) {
      if (!hit.uri) continue;
      // Without the model, skip what the unjudged bar would drop anyway.
      if (!activeModel && !admitsUnjudgedKnowledge(hit)) continue;
      const citation = await manager.resolveCitation(hit.uri);
      if (!citation.ok) continue;
      const text = (citation.chunk?.text ?? citation.markdown ?? '').slice(0, 6000);
      if (!text) continue;
      candidates.push({
        hit,
        passage: {
          uri: hit.uri,
          title: citation.title.slice(0, 256),
          text,
          catalogId: citation.uri.catalogId,
          version: citation.catalogVersion,
        },
      });
    }
    const fit = (ranked: readonly Passage[]): Passage[] => {
      const selected: Passage[] = [];
      let remaining = query.maxCharacters;
      for (const passage of ranked) {
        if (!remaining || selected.length >= query.maxResults) break;
        const text = passage.text.slice(0, remaining);
        selected.push({ ...passage, text });
        remaining -= text.length;
      }
      return selected;
    };
    // `auto` without a usable model: Gezel's own bar, in fused order.
    const unjudged = () =>
      c.json(
        AppKnowledgeRetrievalSchema.parse({
          reranked: false,
          passages: fit(
            candidates
              .filter(({ hit }) => admitsUnjudgedKnowledge(hit))
              .map(({ passage }) => passage),
          ),
        }),
      );
    if (!activeModel) return unjudged();
    if (!candidates.length) return c.json({ reranked: true as const, passages: [] });
    const result = await ctx.relevance.scorer.score({
      model: activeModel.model,
      query: query.query,
      passages: candidates.map(({ passage }) => passage.text),
      waitForLoad: true,
      budgetMs: 30_000,
    });
    c.req.raw.signal.throwIfAborted();
    if (
      result.status !== 'scored' ||
      result.scores?.length !== candidates.length ||
      result.scores.some((score) => score === null || !Number.isFinite(score))
    ) {
      if (!required) return unjudged();
      return c.json(
        {
          error: {
            code: 'reranker_required',
            message: 'The relevance model could not score every passage. Retry the request.',
          },
        },
        409,
      );
    }
    const ordered = candidates
      .map(({ passage }, index) => ({ passage, score: result.scores![index]! }))
      .filter(({ score }) => !activeModel.thresholds || score >= activeModel.thresholds.keep)
      .sort((a, b) => b.score - a.score);
    return c.json(
      AppKnowledgeRetrievalSchema.parse({
        reranked: true,
        passages: fit(ordered.map(({ passage }) => passage)),
      }),
    );
  });
  return app;
}
