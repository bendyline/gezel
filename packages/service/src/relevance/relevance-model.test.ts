import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedRelevanceModel } from './relevance-core.js';
import { type RelevanceBackend, createRelevanceScorer } from './relevance-model.js';
import { resolveRelevanceSetting } from './settings.js';

const MODEL: ResolvedRelevanceModel = {
  id: 'fake@1',
  dir: '/nowhere',
  graph: 'onnx/model.onnx',
  graphSha256: '0'.repeat(64),
  maxTokens: 64,
  queryMaxTokens: 16,
  scoreActivation: 'sigmoid',
};

function backend(opts: { warmMs?: number; scoreMs?: number; failWarm?: boolean } = {}) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    warm: async () => {
      await sleep(opts.warmMs ?? 0);
      if (opts.failWarm) throw new Error('model files missing');
    },
    score: async (_model, _query, passages) => {
      await sleep(opts.scoreMs ?? 0);
      return {
        scores: passages.map((_, i) => 1 - i / 10),
        partial: false,
        truncatedPassages: 0,
        inferMs: 1,
      };
    },
  } satisfies RelevanceBackend;
}

describe('relevance scorer host', () => {
  afterEach(() => {
    delete process.env.GEZEL_DISABLE_RELEVANCE_MODEL;
  });

  it('answers cold at once and warms in the background', async () => {
    const scorer = createRelevanceScorer(backend({ warmMs: 30 }));
    const first = await scorer.score({ model: MODEL, query: 'q', passages: ['a'], budgetMs: 100 });
    expect(first.status).toBe('cold');
    expect(scorer.status(MODEL.id)).toBe('warming');
    await scorer.warm(MODEL);
    const second = await scorer.score({
      model: MODEL,
      query: 'q',
      passages: ['a', 'b'],
      budgetMs: 100,
    });
    expect(second).toMatchObject({ status: 'scored', scores: [1, 0.9] });
    scorer.dispose();
  });

  it('waits for the load only when asked to', async () => {
    const scorer = createRelevanceScorer(backend({ warmMs: 20 }));
    const result = await scorer.score({
      model: MODEL,
      query: 'q',
      passages: ['a'],
      budgetMs: 100,
      waitForLoad: true,
    });
    expect(result.status).toBe('scored');
    scorer.dispose();
  });

  it('times out instead of holding the caller past its budget', async () => {
    const scorer = createRelevanceScorer(backend({ scoreMs: 200 }));
    await scorer.warm(MODEL);
    const result = await scorer.score({ model: MODEL, query: 'q', passages: ['a'], budgetMs: 20 });
    expect(result.status).toBe('timeout');
    scorer.dispose();
  });

  it('reports a model that failed to load as unavailable, and honors the kill switch', async () => {
    const scorer = createRelevanceScorer(backend({ failWarm: true }));
    expect(await scorer.warm(MODEL)).toBe(false);
    expect(scorer.status(MODEL.id)).toBe('unavailable');
    process.env.GEZEL_DISABLE_RELEVANCE_MODEL = '1';
    expect(scorer.status(MODEL.id)).toBe('disabled');
    scorer.dispose();
  });
});

describe('resolveRelevanceSetting', () => {
  it('is off by default and follows config', () => {
    expect(resolveRelevanceSetting(null, {}).enabled).toBe(false);
    const on = resolveRelevanceSetting({ relevanceModel: { enabled: true } }, {});
    expect(on).toMatchObject({
      enabled: true,
      source: 'config',
      thresholds: { drop: 0.00001, keep: 0.00003, strong: 0.95 },
    });
    expect(on.spec?.id).toBe('ms-marco-minilm-l6@1');
  });

  it('lets an eval env override the model, surfaces, thresholds, and budgets', () => {
    const setting = resolveRelevanceSetting(
      { relevanceModel: { enabled: false } },
      {
        GEZEL_RELEVANCE_MODEL: 'mxbai-rerank-xsmall@1',
        GEZEL_RELEVANCE_SURFACES: 'references',
        GEZEL_RELEVANCE_THRESHOLDS: '0.1,0.4,0.8',
        GEZEL_RELEVANCE_BUDGET_MS: 'references:900',
      },
    );
    expect(setting).toMatchObject({
      enabled: true,
      source: 'env',
      thresholds: { drop: 0.1, keep: 0.4, strong: 0.8 },
      budgets: { turn: 250, references: 900, search: 400 },
    });
    expect(setting.spec?.id).toBe('mxbai-rerank-xsmall@1');
    expect([...setting.surfaces]).toEqual(['references']);
    expect(resolveRelevanceSetting(null, { GEZEL_RELEVANCE_MODEL: 'off' }).enabled).toBe(false);
  });

  it('ignores thresholds out of order and an unknown model', () => {
    // A malformed override is ignored, so the registry's calibration stands.
    expect(
      resolveRelevanceSetting(null, { GEZEL_RELEVANCE_THRESHOLDS: '0.5,0.4,0.8' }).thresholds,
    ).toEqual({ drop: 0.00001, keep: 0.00003, strong: 0.95 });
    expect(resolveRelevanceSetting(null, { GEZEL_RELEVANCE_MODEL: 'nope@1' }).enabled).toBe(false);
  });
});
