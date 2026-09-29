import {
  type RetrievalDecisionTrace,
  type RetrievalPreviewKept,
  type RetrievalPreviewRequest,
  RetrievalPreviewRequestSchema,
  type RetrievalPreviewResponse,
  type UnifiedSearchResult,
  renderTaskReferencesBlock,
  retrievalDocKey,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { embeddingsHealth, warmEmbeddings } from '../../memory/embeddings.js';
import {
  type ProjectRetrievalHit,
  resolveSessionRetrievalPolicy,
  retrieveProjectContext,
} from '../../search/project-retrieval.js';
import { relevanceSummary } from '../../search/relevance-stage.js';
import { RetrievalTraceBuilder } from '../../search/retrieval-trace.js';
import { gatherTaskReferences } from '../../tasks/references.js';
import type { ServiceContext } from '../context.js';

/**
 * `POST /api/projects/:id/retrieval/preview` runs a retrieval surface's real
 * decision code — the per-turn injection, the launch reference list, or the
 * model's search — and reports what it would keep, with one decision per
 * candidate. Nothing is written: no history event, no session dedupe state.
 * It is how the retrieval evals reach the injection decision, which otherwise
 * runs only inside a chat turn or a task launch.
 */
export function retrievalPreviewRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/retrieval/preview', async (c) => {
    const projectId = c.req.param('id');
    if (!(await ctx.store.getProject(projectId))) {
      return c.json({ error: 'project not found' }, 404);
    }
    const body = RetrievalPreviewRequestSchema.parse(await c.req.json());
    const started = performance.now();
    // An arm that asked for a model it cannot have must fail loudly: a
    // silent fall-through would score as the model-off arm.
    const relevance = body.relevanceModel?.enabled
      ? await ctx.search.relevanceFor(body.surface, body.relevanceModel)
      : null;
    if (body.relevanceModel?.enabled && !relevance) {
      return c.json(
        {
          error: `relevance model ${body.relevanceModel.modelId ?? '(default)'} is not installed`,
        },
        409,
      );
    }
    if (body.warm) {
      await warmEmbeddings();
      await ctx.knowledge?.warmQueryModels();
      const active = relevance ?? (await ctx.search.relevanceFor(body.surface));
      if (active) await ctx.search.warmRelevance(active);
    }
    const outcome =
      body.surface === 'turn'
        ? await previewTurn(ctx, projectId, body)
        : body.surface === 'references'
          ? await previewReferences(ctx, projectId, body)
          : await previewSearch(ctx, projectId, body);
    if ('error' in outcome) return c.json({ error: outcome.error }, outcome.status);
    const response: RetrievalPreviewResponse = {
      ...outcome,
      surface: body.surface,
      timings: { totalMs: Math.round(performance.now() - started) },
      embedder: embeddingsHealth(),
      ...(outcome.trace?.relevanceModel ? { relevanceModel: outcome.trace.relevanceModel } : {}),
    };
    return c.json(response);
  });

  return app;
}

type PreviewOutcome =
  | Omit<RetrievalPreviewResponse, 'surface' | 'timings' | 'embedder'>
  | { error: string; status: 400 | 404 | 409 };

async function previewTurn(
  ctx: ServiceContext,
  projectId: string,
  body: RetrievalPreviewRequest,
): Promise<PreviewOutcome> {
  const config = await ctx.store.readConfig();
  const gezelId = body.gezelId ?? config.meesterGezelId;
  const gezel = gezelId ? await ctx.store.getGezel(gezelId).catch(() => null) : null;
  if (!gezel) return { error: 'gezel not found', status: 404 };
  const record = {
    id: 'retrieval-preview',
    projectId,
    gezelId: gezel.id,
    ...(body.taskRef ? { taskRef: body.taskRef } : {}),
    ...(body.stepId ? { stepId: body.stepId } : {}),
  };
  const override = body.mode
    ? {
        mode: body.mode,
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        ...(body.sources ? { sources: body.sources } : {}),
      }
    : undefined;
  const policy = await resolveSessionRetrievalPolicy({
    store: ctx.store,
    record,
    gezel,
    config,
    ...(body.contextWindow ? { contextWindow: body.contextWindow } : {}),
    ...(override ? { override } : {}),
  });
  let trace: RetrievalDecisionTrace | null = null;
  let arms: RetrievalPreviewResponse['arms'];
  const linked = await ctx.store.linkedProjectIds(projectId);
  const result = await retrieveProjectContext({
    store: ctx.store,
    search: ctx.search,
    record,
    gezel,
    config,
    userText: body.query,
    messageOrigin: body.messageOrigin ?? (body.taskRef ? 'cross-gezel' : 'direct-user'),
    projectIds: [projectId, ...linked],
    ...(body.contextWindow ? { contextWindow: body.contextWindow } : {}),
    ...(body.availableToolNames ? { availableToolNames: body.availableToolNames } : {}),
    ...(override ? { policyOverride: override } : {}),
    ...(body.relevanceModel ? { relevanceOverride: body.relevanceModel } : {}),
    onSearchProbe: (probe) => {
      arms = probe.arms;
    },
    onDecisionTrace: (t) => {
      trace = t;
    },
  });
  return {
    policy,
    trace,
    kept: (result?.hits ?? []).map(keptFromHit),
    ...(result
      ? { estimatedTokens: result.estimatedTokens, injectedBytes: result.injectedBytes }
      : {}),
    ...(result && body.includeText ? { prompt: result.prompt } : {}),
    ...(arms ? { arms } : {}),
  };
}

async function previewReferences(
  ctx: ServiceContext,
  projectId: string,
  body: RetrievalPreviewRequest,
): Promise<PreviewOutcome> {
  let trace: RetrievalDecisionTrace | null = null;
  const references = await gatherTaskReferences({
    search: ctx.search,
    projectId,
    subject: body.query,
    craftbookName: body.craftbookName ?? '',
    ...(body.relevanceModel ? { relevanceOverride: body.relevanceModel } : {}),
    onDecisionTrace: (t) => {
      trace = t;
    },
  });
  const decided = trace as RetrievalDecisionTrace | null;
  // Items are kept in candidate order, so the kept trace rows line up with them.
  const keptRows = (decided?.candidates ?? []).filter((candidate) => candidate.kept);
  const kept: RetrievalPreviewKept[] = (references?.items ?? []).map((item, index) => ({
    id: keptRows[index]?.id ?? item.uri ?? item.path ?? item.title,
    docKey: item.uri ? item.uri.replace(/#.*$/, '') : `shared:${item.path ?? ''}`,
    source: item.source,
    kind: item.source === 'knowledge' ? 'knowledge' : 'document',
    title: item.title,
    ...(item.path ? { path: item.path } : {}),
    ...(item.uri ? { uri: item.uri } : {}),
    ...(item.catalogId ? { catalogId: item.catalogId } : {}),
  }));
  const wired = (name: string) =>
    body.availableToolNames === undefined || body.availableToolNames.includes(name);
  const block = references ? renderTaskReferencesBlock(references, wired) : null;
  return {
    trace: decided,
    kept,
    ...(block && body.includeText ? { prompt: block } : {}),
  };
}

async function previewSearch(
  ctx: ServiceContext,
  projectId: string,
  body: RetrievalPreviewRequest,
): Promise<PreviewOutcome> {
  const linked = await ctx.store.linkedProjectIds(projectId);
  const active = await ctx.search.relevanceFor('search', body.relevanceModel);
  const found = await ctx.search.searchProject(body.query, {
    projectIds: [projectId, ...linked],
    ...(body.gezelId ? { gezelId: body.gezelId } : {}),
    includeShared: true,
    ...(body.sources ? { sources: body.sources } : {}),
    ...(body.maxResults ? { maxResults: body.maxResults } : {}),
    ...(active
      ? { relevance: { surface: 'search' as const, mode: 'reorder' as const, active } }
      : {}),
  });
  const stage = found.relevance?.applied ? found.relevance : undefined;
  const trace = new RetrievalTraceBuilder('search', '');
  trace.addAll(stage?.fused ?? found.results);
  if (stage) {
    trace.scored(stage.scores);
    for (const result of stage.hidden) trace.reject(result, 'relevance-model');
  }
  for (const result of found.results) trace.keep(result);
  trace.rejectRemaining('depth');
  return {
    trace: trace.finish({
      ...(found.sourcesIncomplete ? { sourcesIncomplete: true } : {}),
      ...(found.relevance ? { relevanceModel: relevanceSummary(found.relevance) } : {}),
    }),
    kept: found.results.map(keptFromResult),
    ...(found.arms ? { arms: found.arms } : {}),
  };
}

function keptFromHit(hit: ProjectRetrievalHit): RetrievalPreviewKept {
  return {
    id: hit.id,
    docKey: hit.docKey,
    source: hit.source,
    kind: hit.kind,
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.path ? { path: hit.path } : {}),
    ...(hit.uri ? { uri: hit.uri } : {}),
    ...(hit.catalogId ? { catalogId: hit.catalogId } : {}),
    ...(hit.relevance !== undefined ? { relevance: hit.relevance } : {}),
    ...(hit.tier ? { tier: hit.tier } : {}),
  };
}

function keptFromResult(result: UnifiedSearchResult): RetrievalPreviewKept {
  return {
    id: result.id,
    docKey: retrievalDocKey(result),
    ...(result.retrievalSource ? { source: result.retrievalSource } : {}),
    kind: result.kind,
    title: result.title,
    ...(result.path ? { path: result.path } : {}),
    ...(result.uri ? { uri: result.uri } : {}),
    ...(result.catalogId ? { catalogId: result.catalogId } : {}),
    ...(result.relevance !== undefined ? { relevance: result.relevance } : {}),
    ...(result.tier ? { tier: result.tier } : {}),
  };
}
