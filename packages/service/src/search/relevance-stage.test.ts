import type {
  ChatSession,
  GezelConfig,
  GezelDetail,
  RelevanceThresholds,
  RetrievalDecisionTrace,
  UnifiedSearchResult,
} from '@bendyline/gezel';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { RelevanceScorer } from '../relevance/relevance-model.js';
import { gatherTaskReferences } from '../tasks/references.js';
import { type RetrievalSearch, retrieveProjectContext } from './project-retrieval.js';
import {
  type ActiveRelevance,
  applyRelevanceModel,
  clearRelevanceScoreCache,
  relevancePassage,
} from './relevance-stage.js';
import { scoreResult } from './search-service.js';

const CALIBRATED: RelevanceThresholds = { drop: 0.05, keep: 0.2, strong: 0.7 };

function active(thresholds: RelevanceThresholds | null): ActiveRelevance {
  return {
    model: {
      id: 'fake@1',
      dir: '/nowhere',
      graph: 'onnx/model.onnx',
      graphSha256: '0'.repeat(64),
      maxTokens: 64,
      queryMaxTokens: 16,
      scoreActivation: 'sigmoid',
    },
    thresholds,
    budgetMs: 250,
    order: 'weighted',
  };
}

/** Scores a passage by the first `score=N` it contains; 0 otherwise. */
function fakeScorer(status: 'ready' | 'cold' = 'ready') {
  const calls: string[][] = [];
  let warms = 0;
  const scorer: RelevanceScorer = {
    status: () => status,
    warm: async () => {
      warms++;
      return true;
    },
    score: async ({ passages }) => {
      calls.push(passages);
      return {
        status: 'scored',
        scores: passages.map((p) => Number(/score=([\d.]+)/.exec(p)?.[1] ?? 0)),
        ms: 1,
        modelId: 'fake@1',
      };
    },
  };
  return { scorer, calls, warms: () => warms };
}

function hit(
  name: string,
  opts: { relevance?: number; model?: number; arm?: 'fts' | 'vector' } = {},
): UnifiedSearchResult {
  return {
    kind: 'content',
    id: `content:p1:src/${name}.md:1`,
    title: `${name}.md`,
    snippet: `notes on ${name}${opts.model !== undefined ? ` score=${opts.model}` : ''}`,
    projectId: 'p1',
    path: `src/${name}.md`,
    source: 'workspace',
    retrievalSource: 'workspace',
    line: 1,
    arm: opts.arm ?? 'fts',
    ...scoreResult('content', opts.relevance ?? 0.6),
  };
}

const passages = async (window: UnifiedSearchResult[]) => window.map((r) => relevancePassage(r));

describe('applyRelevanceModel', () => {
  beforeEach(() => clearRelevanceScoreCache());

  it('passes a cold model through untouched and starts it warming', async () => {
    const { scorer, calls, warms } = fakeScorer('cold');
    const results = [hit('a', { model: 0.9 }), hit('b', { model: 0.1 })];
    const staged = await applyRelevanceModel({
      results,
      query: 'q',
      active: active(CALIBRATED),
      scorer,
      mode: 'filter',
      window: 24,
      passages,
    });
    expect(staged.results).toBe(results);
    expect(staged.report).toMatchObject({ status: 'cold', applied: false });
    expect(calls).toHaveLength(0);
    expect(warms()).toBe(1);
  });

  it('lets an uncalibrated model reorder but never drop', async () => {
    const { scorer } = fakeScorer();
    const staged = await applyRelevanceModel({
      results: [
        hit('a', { relevance: 0.9, model: 0.001 }),
        hit('b', { relevance: 0.8, model: 0.5 }),
        hit('c', { relevance: 0.7, model: 0.95 }),
      ],
      query: 'q',
      active: active(null),
      scorer,
      mode: 'filter',
      window: 24,
      passages,
    });
    expect(staged.results.map((r) => r.title)).toEqual(['c.md', 'b.md', 'a.md']);
    expect(staged.report.hidden).toEqual([]);
    expect(staged.report).toMatchObject({ applied: true, calibrated: false });
  });

  it('drops below keep when filtering and only below drop when reordering', async () => {
    const results = [
      hit('off-topic', { model: 0.01 }),
      hit('weak-lead', { model: 0.1 }),
      hit('answer', { model: 0.9 }),
    ];
    const filter = await applyRelevanceModel({
      results,
      query: 'q',
      active: active(CALIBRATED),
      scorer: fakeScorer().scorer,
      mode: 'filter',
      window: 24,
      passages,
    });
    expect(filter.results.map((r) => r.title)).toEqual(['answer.md']);
    expect(filter.report.hidden.map((r) => r.title)).toEqual(['off-topic.md', 'weak-lead.md']);

    clearRelevanceScoreCache();
    const reorder = await applyRelevanceModel({
      results,
      query: 'q',
      active: active(CALIBRATED),
      scorer: fakeScorer().scorer,
      mode: 'reorder',
      window: 24,
      passages,
    });
    expect(reorder.results.map((r) => r.title)).toEqual(['answer.md', 'weak-lead.md']);
    expect(reorder.results[0]).toMatchObject({ tier: 'strong' });
  });

  it('scores only the window and serves a repeated query from cache', async () => {
    const { scorer, calls } = fakeScorer();
    const results = [hit('a', { model: 0.3 }), hit('b', { model: 0.9 }), hit('tail', { model: 1 })];
    const run = () =>
      applyRelevanceModel({
        results,
        query: 'q',
        active: active(null),
        scorer,
        mode: 'reorder',
        window: 2,
        passages,
      });
    const first = await run();
    expect(first.results.map((r) => r.title)).toEqual(['b.md', 'a.md', 'tail.md']);
    const second = await run();
    expect(second.results.map((r) => r.title)).toEqual(['b.md', 'a.md', 'tail.md']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });
});

const GEZEL = {
  parsed: { frontmatter: { retrieval: { mode: 'balanced' } } },
} as unknown as GezelDetail;
const RECORD = { id: 's1', projectId: 'p1', gezelId: 'g1', messages: [] } as unknown as ChatSession;
const STORE = {
  readProjectWorkspaceFile: async () => 'an unrelated line of text',
  readProjectArtifact: async () => null,
  readDocumentAsMarkdown: async () => null,
  readTask: async () => null,
} as unknown as Store;

/** A search that runs the real stage over fixed results, the way SearchService does. */
function stagedSearch(
  results: UnifiedSearchResult[],
  relevance: ActiveRelevance | null,
  scorer: RelevanceScorer,
) {
  const requests: Array<{ maxResults?: number }> = [];
  const search: RetrievalSearch = {
    relevanceFor: async () => relevance,
    relevanceReady: (a) => scorer.status(a.model.id) === 'ready',
    searchProject: (async (
      query: string,
      opts: Parameters<RetrievalSearch['searchProject']>[1],
    ) => {
      requests.push(opts);
      const pool = results;
      if (!opts.relevance?.active) {
        return { results: pool.slice(0, opts.maxResults), truncated: false };
      }
      const staged = await applyRelevanceModel({
        results: pool,
        query: opts.relevance.query ?? query,
        active: opts.relevance.active,
        scorer,
        mode: opts.relevance.mode,
        window: 24,
        passages,
      });
      return {
        results: staged.results.slice(0, opts.maxResults),
        truncated: false,
        relevance: staged.report,
      };
    }) as RetrievalSearch['searchProject'],
  };
  return { search, requests };
}

async function turn(search: RetrievalSearch) {
  let trace: RetrievalDecisionTrace | null = null;
  const result = await retrieveProjectContext({
    store: STORE,
    search,
    record: RECORD,
    gezel: GEZEL,
    config: {} as GezelConfig,
    userText: 'how do I cut strong corner joints by hand?',
    messageOrigin: 'direct-user',
    onDecisionTrace: (t) => {
      trace = t;
    },
  });
  return { result, trace: trace as RetrievalDecisionTrace | null };
}

describe('per-turn retrieval with a relevance model', () => {
  beforeEach(() => clearRelevanceScoreCache());

  const results = [
    hit('dovetails', { model: 0.9 }),
    hit('invoice-template', { model: 0.01 }),
    hit('mortise', { arm: 'vector', relevance: 0.5 }),
  ];

  it('behaves exactly as with the model off while the model is cold', async () => {
    const off = await turn(stagedSearch(results, null, fakeScorer().scorer).search);
    const cold = stagedSearch(results, active(CALIBRATED), fakeScorer('cold').scorer);
    const coldTurn = await turn(cold.search);
    expect(coldTurn.result?.prompt).toBe(off.result?.prompt);
    expect(coldTurn.trace?.counts).toEqual(off.trace?.counts);
    expect(cold.requests[0]?.maxResults).toBe(12);
  });

  it('keeps what a calibrated model judged on topic, even with no shared words', async () => {
    const off = await turn(stagedSearch(results, null, fakeScorer().scorer).search);
    // Grounding rejects both keyword hits today: the file text names no query term.
    expect(off.trace?.counts.grounding).toBe(2);

    const on = stagedSearch(results, active(CALIBRATED), fakeScorer().scorer);
    const { result, trace } = await turn(on.search);
    expect(on.requests[0]?.maxResults).toBe(24);
    expect(result?.hits.map((h) => h.path)).toEqual(['src/dovetails.md']);
    const byPath = new Map(trace?.candidates.map((c) => [c.docKey, c]));
    expect(byPath.get('workspace:p1:src/dovetails.md')).toMatchObject({
      kept: true,
      modelScore: 0.9,
    });
    expect(byPath.get('workspace:p1:src/invoice-template.md')).toMatchObject({
      kept: false,
      reason: 'relevance-model',
    });
    expect(trace?.relevanceModel).toMatchObject({ status: 'scored', calibrated: true, hidden: 2 });
  });
});

describe('reference list with a relevance model', () => {
  beforeEach(() => clearRelevanceScoreCache());

  function knowledge(n: number, title: string, model: number): UnifiedSearchResult {
    return {
      kind: 'knowledge',
      id: `knowledge:food:chunk${n}`,
      title,
      snippet: `A savoury custard tart score=${model}`,
      retrievalSource: 'knowledge',
      catalogId: 'food',
      catalogVersion: '1.0.0',
      uri: `knowledge://gezel/food/doc${n}#chunk=${n}`,
      arm: 'vector',
      ...scoreResult('knowledge', 0.8),
    };
  }

  it('keeps a judged entry the lexical rule would drop, and says the model chose', async () => {
    const results = [knowledge(1, 'Lorraine custard tart', 0.92), knowledge(2, 'QuEChERS', 0.02)];
    const { search } = stagedSearch(results, active(CALIBRATED), fakeScorer().scorer);
    let trace: RetrievalDecisionTrace | null = null;
    const references = await gatherTaskReferences({
      search,
      projectId: 'p1',
      subject: 'quiche',
      craftbookName: 'PowerPoint deck',
      onDecisionTrace: (t) => {
        trace = t;
      },
    });
    expect(references?.items.map((item) => item.title)).toEqual(['Lorraine custard tart']);
    expect(references?.selection).toMatchObject({
      method: 'relevance-model',
      modelId: 'fake@1',
      modelStatus: 'scored',
    });
    expect((trace as RetrievalDecisionTrace | null)?.counts).toMatchObject({
      kept: 1,
      'relevance-model': 1,
    });
  });
});
