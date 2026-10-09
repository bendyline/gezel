import { createHash } from 'node:crypto';
import {
  KNOWLEDGE_FILTER_MIN_RELEVANCE,
  MODEL_RELEVANCE_ANCHORS,
  type RelevanceModelOverride,
  type RelevanceThresholds,
  type RetrievalRelevanceSummary,
  type RetrievalTraceSurface,
  type UnifiedSearchResult,
  compareSearchResults,
  relevanceFromModelScore,
  scoreResult,
} from '@bendyline/gezel';
import type { ResolvedRelevanceModel } from '../relevance/relevance-core.js';
import type { RelevanceRunStatus, RelevanceScorer } from '../relevance/relevance-model.js';

/**
 * The relevance-model stage of a search: re-judge the top of the fused order
 * with a cross-encoder, then reorder (and, for a calibrated model, drop) by
 * what it says. Everything the search arms report is rank-derived, so this
 * is the one place an absolute "is this on topic?" enters retrieval.
 *
 * Two rules keep it safe to leave on. It never holds a caller for a model
 * load: a cold model answers `cold`, starts warming, and the results pass
 * through untouched. And a model without calibrated thresholds may reorder
 * but never drop — its raw scores have not been measured against anything.
 */

/** The model a surface scores with, as resolved from the setting or a preview override. */
export interface ActiveRelevance {
  model: ResolvedRelevanceModel;
  thresholds: RelevanceThresholds | null;
  budgetMs: number;
  /** `flat`: order by model relevance across corpora instead of the weighted score. */
  order: 'weighted' | 'flat';
  /** Filter surfaces: the relevance a knowledge passage needs (default KNOWLEDGE_FILTER_MIN_RELEVANCE). */
  knowledgeKeep?: number;
}

/** What SearchService needs from the relevance model manager. */
export interface RelevanceStageProvider {
  readonly scorer: RelevanceScorer;
  forSurface(
    surface: RetrievalTraceSurface,
    override?: RelevanceModelOverride,
  ): Promise<ActiveRelevance | null>;
}

/**
 * `filter` drops what a calibrated model scores below keep — the injection
 * surfaces, where noise costs the model's attention. `reorder` drops only
 * below drop — the search tool, where a weak lead is still a lead.
 */
export type RelevanceStageMode = 'filter' | 'reorder';

export interface RelevanceStageRequest {
  surface: RetrievalTraceSurface;
  mode: RelevanceStageMode;
  /** The text passages are judged against; the search query when absent. */
  query?: string;
  /** How many candidates, from the top of the fused order, are scored. */
  window?: number;
  /** Resolved already, or a preview's override. Absent: resolve for the surface. Null: off. */
  active?: ActiveRelevance | null;
  /** Wait for a cold model to load rather than pass through (calibration, warm previews). */
  waitForLoad?: boolean;
}

export interface RelevanceStageReport {
  modelId: string;
  status: RelevanceRunStatus;
  calibrated: boolean;
  /** At least one candidate carries a model score, so the order is the model's. */
  applied: boolean;
  ms: number;
  /** Every candidate in fused order, before the stage — what traces rank against. */
  fused: UnifiedSearchResult[];
  /** Activated model score per candidate id. */
  scores: Map<string, number>;
  /** Scored below the mode's cutoff and removed. */
  hidden: UnifiedSearchResult[];
}

export const RELEVANCE_WINDOW: Record<RetrievalTraceSurface, number> = {
  turn: 24,
  references: 20,
  search: 24,
};

/**
 * Characters of passage sent per candidate. A cross-encoder's cost grows
 * with every token of every pair; a heading plus a chunk's opening is what
 * says whether the chunk is on topic.
 */
const PASSAGE_CHARS = 1_000;
const CACHE_ENTRIES = 4_096;
const scoreCache = new Map<string, number>();

function cacheKey(modelId: string, query: string, id: string, passage: string): string {
  return createHash('sha1')
    .update(modelId)
    .update('\0')
    .update(query)
    .update('\0')
    .update(id)
    .update('\0')
    .update(passage)
    .digest('hex');
}

function cacheGet(key: string): number | undefined {
  const value = scoreCache.get(key);
  if (value !== undefined) {
    scoreCache.delete(key);
    scoreCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: number): void {
  scoreCache.set(key, value);
  while (scoreCache.size > CACHE_ENTRIES) {
    const oldest = scoreCache.keys().next().value;
    if (oldest === undefined) break;
    scoreCache.delete(oldest);
  }
}

/** Test seam: forget cached scores. */
export function clearRelevanceScoreCache(): void {
  scoreCache.clear();
}

/** The text a candidate is judged on: its title, then the fullest body at hand. */
export function relevancePassage(result: UnifiedSearchResult, chunkText?: string): string {
  const snippet = result.snippet ?? '';
  const body = chunkText && chunkText.length > snippet.length ? chunkText : snippet;
  const text = body || result.subtitle || '';
  return `${result.title}\n${text}`.slice(0, PASSAGE_CHARS);
}

/**
 * The cutoff in calibrated-relevance space, or null when the model may not
 * drop. On a filter surface a knowledge passage has to clear the stricter
 * knowledge bar: "not off topic" is enough for the user's own project, not
 * for an encyclopedia that always has a plausible-looking neighbour.
 */
function cutoffFor(
  mode: RelevanceStageMode,
  thresholds: RelevanceThresholds | null,
  kind: UnifiedSearchResult['kind'],
  knowledgeKeep: number,
) {
  if (!thresholds) return null;
  if (mode === 'reorder') return MODEL_RELEVANCE_ANCHORS.drop;
  return kind === 'knowledge'
    ? Math.max(MODEL_RELEVANCE_ANCHORS.keep, knowledgeKeep)
    : MODEL_RELEVANCE_ANCHORS.keep;
}

export async function applyRelevanceModel(args: {
  results: UnifiedSearchResult[];
  query: string;
  active: ActiveRelevance;
  scorer: RelevanceScorer;
  mode: RelevanceStageMode;
  window: number;
  passages: (window: UnifiedSearchResult[]) => Promise<string[]>;
  waitForLoad?: boolean;
}): Promise<{ results: UnifiedSearchResult[]; report: RelevanceStageReport }> {
  const started = performance.now();
  const { model, thresholds } = args.active;
  const report = (
    status: RelevanceRunStatus,
    scores = new Map<string, number>(),
    hidden: UnifiedSearchResult[] = [],
  ): RelevanceStageReport => ({
    modelId: model.id,
    status,
    calibrated: thresholds !== null,
    applied: scores.size > 0,
    ms: Math.round(performance.now() - started),
    fused: args.results,
    scores,
    hidden,
  });

  const readiness = args.scorer.status(model.id);
  if (readiness === 'disabled' || readiness === 'unavailable') {
    return { results: args.results, report: report(readiness) };
  }
  if (readiness !== 'ready' && !args.waitForLoad) {
    if (readiness === 'cold') void args.scorer.warm(model);
    return { results: args.results, report: report('cold') };
  }

  const windowed = args.results.slice(0, args.window);
  const tail = args.results.slice(args.window);
  // A text judge cannot see pixels or sound: a media hit that cleared its
  // modality's vector floor keeps its fused place rather than being judged
  // on a caption that may be one word.
  const toJudge = windowed.filter((result) => !isVectorMediaHit(result));
  const texts = await args.passages(toJudge);
  const keys = toJudge.map((result, i) =>
    cacheKey(model.id, args.query, result.id, texts[i] ?? ''),
  );
  const scores = new Map<string, number>();
  const missing: number[] = [];
  keys.forEach((key, i) => {
    const cached = cacheGet(key);
    if (cached === undefined) missing.push(i);
    else scores.set(toJudge[i]!.id, cached);
  });

  let status: RelevanceRunStatus = 'scored';
  if (missing.length > 0) {
    const spent = performance.now() - started;
    const run = await args.scorer.score({
      model,
      query: args.query,
      passages: missing.map((i) => texts[i] ?? ''),
      budgetMs: Math.max(1, args.active.budgetMs - spent),
      ...(args.waitForLoad ? { waitForLoad: true } : {}),
    });
    status = run.status;
    run.scores?.forEach((score, j) => {
      if (score === null || score === undefined) return;
      const i = missing[j]!;
      scores.set(toJudge[i]!.id, score);
      cacheSet(keys[i]!, score);
    });
  }
  if (scores.size === 0) return { results: args.results, report: report(status) };

  const knowledgeKeep = args.active.knowledgeKeep ?? KNOWLEDGE_FILTER_MIN_RELEVANCE;
  const judged: UnifiedSearchResult[] = [];
  const unscored: UnifiedSearchResult[] = [];
  const hidden: UnifiedSearchResult[] = [];
  for (const result of windowed) {
    if (isVectorMediaHit(result)) {
      judged.push(result);
      continue;
    }
    const score = scores.get(result.id);
    if (score === undefined) {
      unscored.push(result);
      continue;
    }
    const relevance = relevanceFromModelScore(score, thresholds);
    const cutoff = cutoffFor(args.mode, thresholds, result.kind, knowledgeKeep);
    if (cutoff !== null && relevance < cutoff) {
      hidden.push(result);
      continue;
    }
    const rescored = scoreResult(result.kind, relevance);
    judged.push({
      ...result,
      ...rescored,
      ...(args.active.order === 'flat' ? { score: rescored.relevance } : {}),
    });
  }
  judged.sort(compareSearchResults);
  return {
    results: [...judged, ...unscored, ...tail],
    report: report(status, scores, hidden),
  };
}

/** A media row found by its own vector arm, past its modality's measured floor. */
function isVectorMediaHit(result: UnifiedSearchResult): boolean {
  return result.media !== undefined && result.arm === 'vector';
}

/** The trace/history summary of a stage run. */
export function relevanceSummary(report: RelevanceStageReport): RetrievalRelevanceSummary {
  return {
    modelId: report.modelId,
    status: report.status,
    calibrated: report.calibrated,
    scored: report.scores.size,
    hidden: report.hidden.length,
    ms: report.ms,
  };
}
