import type { RetrievalTraceSurface } from '@bendyline/gezel';
import { type Interval, meanOf, quantile, stratifiedBootstrap } from '../ab-stats.ts';
import type { Expectation, Grade, QueryClass } from './corpus/queries.ts';

/**
 * Retrieval-bench scoring. A row is one (query, surface, arm) judgment: the
 * docKeys the surface kept, in order, against the query's graded labels.
 * Grades: 2 = the answer, 1 = related, 0 = irrelevant (everything unlabeled).
 */

export interface JudgedRow {
  queryId: string;
  class: QueryClass;
  split: 'dev' | 'test';
  surface: RetrievalTraceSurface;
  expect: Expectation;
  /** Kept docKeys, in the surface's order, deduplicated. */
  kept: string[];
  labels: Readonly<Record<string, Grade>>;
  decoys: readonly string[];
  /** Grades of every labeled document this surface can reach, for the ideal ranking. */
  reachableGrades: readonly Grade[];
  /** Tokens the surface put into the prompt (turn and references). */
  tokens?: number;
  latencyMs: number;
  /** The embedder or relevance model was cold, so the vector/model path was skipped. */
  coldSkipped?: boolean;
  timedOut?: boolean;
}

const gradeOf = (row: JudgedRow, key: string): Grade => row.labels[key] ?? 0;

export function precisionAtK(row: JudgedRow, k: number, minGrade: 1 | 2 = 1): number {
  const top = row.kept.slice(0, k);
  return top.filter((key) => gradeOf(row, key) >= minGrade).length / k;
}

/** Share of kept documents that are relevant; null when the surface kept nothing. */
export function setPrecision(row: JudgedRow, minGrade: 1 | 2 = 1): number | null {
  if (row.kept.length === 0) return null;
  return row.kept.filter((key) => gradeOf(row, key) >= minGrade).length / row.kept.length;
}

/** Graded nDCG@k with gain 2^g − 1; null when nothing relevant is reachable. */
export function ndcgAtK(row: JudgedRow, k: number): number | null {
  const ideal = [...row.reachableGrades].sort((a, b) => b - a).slice(0, k);
  const idcg = discounted(ideal);
  if (idcg === 0) return null;
  return discounted(row.kept.slice(0, k).map((key) => gradeOf(row, key))) / idcg;
}

function discounted(grades: readonly number[]): number {
  return grades.reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
}

/** Reciprocal rank of the first document at `minGrade` or better, within `cutoff`. */
export function reciprocalRank(row: JudgedRow, minGrade: 1 | 2 = 2, cutoff = 10): number | null {
  if (!row.reachableGrades.some((grade) => grade >= minGrade)) return null;
  const index = row.kept.slice(0, cutoff).findIndex((key) => gradeOf(row, key) >= minGrade);
  return index < 0 ? 0 : 1 / (index + 1);
}

/** Share of reachable grade-2 documents among the first k kept. */
export function strictRecallAtK(row: JudgedRow, k: number): number | null {
  const total = row.reachableGrades.filter((grade) => grade === 2).length;
  if (total === 0) return null;
  return row.kept.slice(0, k).filter((key) => gradeOf(row, key) === 2).length / total;
}

export const injectedAnything = (row: JudgedRow) => row.kept.length > 0;
export const injectedIrrelevant = (row: JudgedRow) =>
  row.kept.some((key) => gradeOf(row, key) === 0);
export const keptDecoys = (row: JudgedRow) =>
  row.kept.filter((key) => row.decoys.includes(key)).length;

export interface SurfaceSummary {
  surface: RetrievalTraceSurface;
  rows: number;
  ndcg5: Interval | null;
  ndcg10: Interval | null;
  mrr: Interval | null;
  strictRecall5: Interval | null;
  precision5: Interval | null;
  setPrecision: Interval | null;
  /** Abstain queries on which the surface kept anything at all. */
  falseInjectionStrict: Interval | null;
  /** Abstain queries on which the surface kept something irrelevant. */
  falseInjectionLenient: Interval | null;
  /** Answer queries on which the surface kept something. */
  answerCoverage: number | null;
  /** Mean of answer coverage and abstain accuracy. */
  abstentionBalancedAccuracy: number | null;
  /** Share of kept items that are decoys. */
  distractorItemRate: number | null;
  /** Share of queries whose kept set contains a decoy. */
  distractorQueryRate: Interval | null;
  tokensPerRelevantHit: number | null;
  wastedTokensPerQuery: number | null;
  latencyP50Ms: number;
  latencyP95Ms: number;
  coldSkipRate: number;
  timeoutRate: number;
}

export function summarizeSurface(
  surface: RetrievalTraceSurface,
  rows: readonly JudgedRow[],
  opts: { iterations?: number; seed?: number } = {},
): SurfaceSummary {
  const boot = (stat: (sample: readonly JudgedRow[]) => number | null) =>
    stratifiedBootstrap(rows, stat, { strata: (row) => row.class, ...opts });
  const answerRows = rows.filter((row) => row.expect === 'answer');
  const abstainRows = rows.filter((row) => row.expect === 'abstain');
  const rate = (sample: readonly JudgedRow[], pick: (row: JudgedRow) => boolean) => {
    const eligible = sample.filter((row) => row.expect === 'abstain');
    return eligible.length === 0 ? null : eligible.filter(pick).length / eligible.length;
  };
  const coverage =
    answerRows.length === 0 ? null : answerRows.filter(injectedAnything).length / answerRows.length;
  const abstainAccuracy =
    abstainRows.length === 0
      ? null
      : abstainRows.filter((row) => !injectedAnything(row)).length / abstainRows.length;
  const keptTotal = rows.reduce((sum, row) => sum + row.kept.length, 0);
  const decoyTotal = rows.reduce((sum, row) => sum + keptDecoys(row), 0);
  const withTokens = rows.filter((row) => row.tokens !== undefined);
  const relevantKept = withTokens.reduce(
    (sum, row) => sum + row.kept.filter((key) => gradeOf(row, key) >= 1).length,
    0,
  );
  const tokenTotal = withTokens.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const wasted = withTokens.map((row) =>
    row.kept.length === 0
      ? 0
      : ((row.tokens ?? 0) * row.kept.filter((key) => gradeOf(row, key) === 0).length) /
        row.kept.length,
  );
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  return {
    surface,
    rows: rows.length,
    ndcg5: boot((sample) => meanOf(sample.map((row) => ndcgAtK(row, 5)))),
    ndcg10: boot((sample) => meanOf(sample.map((row) => ndcgAtK(row, 10)))),
    mrr: boot((sample) => meanOf(sample.map((row) => reciprocalRank(row)))),
    strictRecall5: boot((sample) => meanOf(sample.map((row) => strictRecallAtK(row, 5)))),
    precision5: boot((sample) =>
      meanOf(sample.filter((row) => row.expect === 'answer').map((row) => precisionAtK(row, 5))),
    ),
    setPrecision: boot((sample) => meanOf(sample.map((row) => setPrecision(row)))),
    falseInjectionStrict: boot((sample) => rate(sample, injectedAnything)),
    falseInjectionLenient: boot((sample) => rate(sample, injectedIrrelevant)),
    answerCoverage: coverage,
    abstentionBalancedAccuracy:
      coverage === null || abstainAccuracy === null ? null : (coverage + abstainAccuracy) / 2,
    distractorItemRate: keptTotal === 0 ? null : decoyTotal / keptTotal,
    distractorQueryRate: boot((sample) =>
      sample.length === 0
        ? null
        : sample.filter((row) => keptDecoys(row) > 0).length / sample.length,
    ),
    tokensPerRelevantHit: relevantKept === 0 ? null : tokenTotal / relevantKept,
    wastedTokensPerQuery: meanOf(wasted),
    latencyP50Ms: quantile(latencies, 0.5),
    latencyP95Ms: quantile(latencies, 0.95),
    coldSkipRate:
      rows.length === 0 ? 0 : rows.filter((row) => row.coldSkipped).length / rows.length,
    timeoutRate: rows.length === 0 ? 0 : rows.filter((row) => row.timedOut).length / rows.length,
  };
}

/**
 * Area under the ROC curve of a score for relevant (grade ≥ 1) versus
 * irrelevant candidates — how well a relevance model separates them,
 * independent of any threshold. Null when either class is empty.
 */
export function scoreAuc(
  pairs: ReadonlyArray<{ score: number; relevant: boolean }>,
): number | null {
  const positives = pairs.filter((p) => p.relevant).map((p) => p.score);
  const negatives = pairs.filter((p) => !p.relevant).map((p) => p.score);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}
