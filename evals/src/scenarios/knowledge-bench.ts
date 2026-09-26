import {
  GOLDEN_QUERIES,
  KNOWLEDGE_BENCH_TOPICS,
  type KnowledgeQueryOutcome,
  knowledgeBenchDocuments,
  scoreKnowledgeOutcomes,
} from '../knowledge-bench/corpus.ts';
import { compileAndInstallCatalog } from '../retrieval-corpora/catalog.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Knowledge-bench — NO agent involved (the index-bench shape). Setup builds
 * a real `.gezk` with the DAEMON'S OWN embedder (so the semantic two-stage
 * path runs, not the FTS fallback), installs it over HTTP, then measures
 * the Phase-2a/4 gates empirically:
 *
 *   - explicit-search recall@1/@5 + MRR on paraphrased golden queries
 *     (never verbatim, so keyword matching alone cannot carry the score)
 *   - warm explicit-search latency p50/p95 against the 750 ms gate
 *
 * Injection-budget invariants are CI-guarded in
 * packages/service/src/search/project-retrieval.test.ts and the knowledge
 * routes integration test; this bench owns the empirical halves that need
 * the real embedding model.
 */

const LATENCY_ROUNDS = 3;
const LATENCY_GATE_MS = 750;

export interface KnowledgeBenchReport {
  embedModel: string;
  documents: number;
  queries: number;
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  p50Ms: number;
  p95Ms: number;
  ok: boolean;
}

// Module-level singleton — the runner hands setup and successCheck
// different ctx objects (the index-bench lesson).
let lastReport: KnowledgeBenchReport | null = null;

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  lastReport = null;

  const documents = knowledgeBenchDocuments();
  const { embedModel: modelId } = await compileAndInstallCatalog(
    client,
    {
      publisherId: 'gezel-bench',
      catalogId: 'workshop-reference',
      version: '1.0.0',
      name: 'Workshop Reference',
      description: 'Knowledge-bench fixture catalog.',
      topics: KNOWLEDGE_BENCH_TOPICS,
      documents,
    },
    (line) => log(`[knowledge-bench] ${line}`),
  );

  // Warm-up pass (model load + first shard read), then measured rounds.
  await client.searchKnowledge({ query: GOLDEN_QUERIES[0]?.query ?? 'warm' });
  const outcomes: KnowledgeQueryOutcome[] = [];
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    for (const golden of GOLDEN_QUERIES) {
      const started = performance.now();
      const { results } = await client.searchKnowledge({ query: golden.query, maxResults: 10 });
      const latencyMs = performance.now() - started;
      const docRanks = new Map<string, number>();
      for (const r of results) {
        const docId = r.documentId;
        if (docId && !docRanks.has(docId)) docRanks.set(docId, docRanks.size + 1);
      }
      const rank = docRanks.get(golden.expectedDocumentId) ?? null;
      outcomes.push({ query: golden.query, rank, latencyMs });
    }
  }
  const score = scoreKnowledgeOutcomes(outcomes);
  const report: KnowledgeBenchReport = {
    embedModel: modelId,
    documents: documents.length,
    queries: GOLDEN_QUERIES.length,
    ...score,
    ok: score.recallAt5 >= 0.75 && score.p95Ms <= LATENCY_GATE_MS,
  };
  lastReport = report;
  log(
    `[knowledge-bench] R@1=${score.recallAt1.toFixed(2)} R@5=${score.recallAt5.toFixed(2)} MRR=${score.mrr.toFixed(2)} p50=${Math.round(score.p50Ms)}ms p95=${Math.round(score.p95Ms)}ms`,
  );
}

export const knowledgeBenchScenario: EvalScenario = {
  id: 'knowledge-bench',
  requiresEmbeddings: true,
  description:
    'Knowledge-catalog retrieval benchmark (no agent): compiles a catalog with the daemon embedder, installs it, and measures paraphrased-golden-query recall and warm explicit-search latency against the 750 ms p95 gate.',
  prompt: 'Knowledge bench runs entirely in setup; this prompt is never sent.',
  skipInitialPrompt: true,
  timeoutMs: 20 * 60_000,
  setup,
  successCheck: async (): Promise<SuccessCheckResult> => {
    if (!lastReport) {
      return { done: true, success: false, reason: 'setup did not produce a report' };
    }
    const r = lastReport;
    return {
      done: true,
      success: r.ok,
      reason: `R@1=${r.recallAt1.toFixed(2)} R@5=${r.recallAt5.toFixed(2)} MRR=${r.mrr.toFixed(2)} p50=${Math.round(r.p50Ms)}ms p95=${Math.round(r.p95Ms)}ms (gate ${LATENCY_GATE_MS}ms) on ${r.embedModel}`,
    };
  },
};
