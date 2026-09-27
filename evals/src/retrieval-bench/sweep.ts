import type {
  RelevanceThresholds,
  RetrievalTraceCandidate,
  RetrievalTraceSurface,
} from '@bendyline/gezel';
import { type Interval, meanOf, stratifiedBootstrap } from '../ab-stats.ts';
import type { CandidateRecord } from './drive.ts';
import {
  type JudgedRow,
  injectedAnything,
  keptDecoys,
  ndcgAtK,
  scoreAuc,
  setPrecision,
  strictRecallAtK,
} from './metrics.ts';

/**
 * Offline threshold sweep over an UNCALIBRATED arm. That arm scores every
 * candidate in the relevance window and drops nothing, so its traces carry
 * a model score beside every candidate's fate. Replaying a surface's rules
 * under a candidate threshold — a judged candidate is kept on its score
 * alone, everything else keeps the decision it got — approximates what a
 * calibrated model would keep, for every threshold, from one run. The
 * approximation is only for choosing candidates: the chosen thresholds are
 * then confirmed live, as arms of their own.
 */

/** Decisions a threshold cannot change: they hold whatever the model says. */
const STRUCTURAL = new Set(['other-task', 'reference-list', 'source-policy', 'no-excerpt']);

/** Per-surface caps a replay enforces after reordering. */
export interface ReplayCaps {
  /** Items the surface injects at most — the turn's token budget, the reference limit. */
  items: number;
  /** Turn only: knowledge-catalog chunks per turn (balanced mode). */
  knowledge?: number;
}

/**
 * Activated-score cuts to replay. A cross-encoder's sigmoid saturates, so
 * the useful cuts for ms-marco-style models sit orders of magnitude below
 * 0.1 — the low decades are where the grid has to be dense.
 */
export const SWEEP_GRID = [
  0.000003, 0.00001, 0.00003, 0.0001, 0.0003, 0.001, 0.003, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4,
  0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99,
];

/** The docKeys a surface would keep if a calibrated model cut at `threshold`. */
export function replayKept(
  candidates: readonly RetrievalTraceCandidate[],
  threshold: number,
  caps: ReplayCaps,
): string[] {
  const eligible = candidates.filter((c) => !STRUCTURAL.has(c.reason));
  const judged = eligible
    .filter((c) => c.modelScore !== undefined && c.modelScore >= threshold)
    .sort((a, b) => b.modelScore! - a.modelScore! || a.fusedRank - b.fusedRank);
  const unjudged = eligible
    .filter((c) => c.modelScore === undefined && c.kept)
    .sort((a, b) => a.fusedRank - b.fusedRank);
  const kept: string[] = [];
  let knowledge = 0;
  for (const candidate of [...judged, ...unjudged]) {
    if (kept.length >= caps.items) break;
    if (kept.includes(candidate.docKey)) continue;
    if (candidate.source === 'knowledge' && caps.knowledge !== undefined) {
      if (knowledge >= caps.knowledge) continue;
      knowledge++;
    }
    kept.push(candidate.docKey);
  }
  return kept;
}

export interface SweepPoint {
  threshold: number;
  ndcg5: number | null;
  strictRecall5: number | null;
  setPrecision: number | null;
  falseInjectionStrict: number | null;
  distractorItemRate: number | null;
  meanKept: number;
}

export interface SurfaceSweep {
  surface: RetrievalTraceSurface;
  split: 'dev' | 'test';
  /** Separation of relevant (grade ≥ 1) from irrelevant candidates by model score. */
  auc: number | null;
  /** P(grade ≥ 1) and P(grade 2) per model-score band. */
  reliability: Array<{ low: number; high: number; n: number; relevant: number; answer: number }>;
  points: SweepPoint[];
}

function pointFor(rows: readonly JudgedRow[], threshold: number): SweepPoint {
  const abstain = rows.filter((row) => row.expect === 'abstain');
  const keptTotal = rows.reduce((sum, row) => sum + row.kept.length, 0);
  const decoys = rows.reduce((sum, row) => sum + keptDecoys(row), 0);
  return {
    threshold,
    ndcg5: meanOf(rows.map((row) => ndcgAtK(row, 5))),
    strictRecall5: meanOf(rows.map((row) => strictRecallAtK(row, 5))),
    setPrecision: meanOf(rows.map((row) => setPrecision(row))),
    falseInjectionStrict:
      abstain.length === 0 ? null : abstain.filter(injectedAnything).length / abstain.length,
    distractorItemRate: keptTotal === 0 ? null : decoys / keptTotal,
    meanKept: rows.length === 0 ? 0 : keptTotal / rows.length,
  };
}

const BANDS = [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 0.95, 1.000001];

export function sweepSurface(args: {
  surface: RetrievalTraceSurface;
  split: 'dev' | 'test';
  rows: readonly JudgedRow[];
  traces: readonly CandidateRecord[];
  caps: ReplayCaps;
  grid?: readonly number[];
}): SurfaceSweep {
  const traceOf = new Map(
    args.traces
      .filter((record) => record.surface === args.surface)
      .map((record) => [record.queryId, record.trace]),
  );
  const rows = args.rows.filter((row) => row.surface === args.surface && row.split === args.split);
  const scored: Array<{ score: number; grade: number }> = [];
  for (const row of rows) {
    for (const candidate of traceOf.get(row.queryId)?.candidates ?? []) {
      if (candidate.modelScore === undefined) continue;
      scored.push({ score: candidate.modelScore, grade: row.labels[candidate.docKey] ?? 0 });
    }
  }
  const reliability = BANDS.slice(0, -1).map((low, i) => {
    const high = BANDS[i + 1]!;
    const band = scored.filter((s) => s.score >= low && s.score < high);
    return {
      low,
      high: Math.min(1, high),
      n: band.length,
      relevant: band.length === 0 ? 0 : band.filter((s) => s.grade >= 1).length / band.length,
      answer: band.length === 0 ? 0 : band.filter((s) => s.grade === 2).length / band.length,
    };
  });
  const points = (args.grid ?? SWEEP_GRID).map((threshold) =>
    pointFor(
      rows.map((row) => ({
        ...row,
        kept: replayKept(traceOf.get(row.queryId)?.candidates ?? [], threshold, args.caps),
      })),
      threshold,
    ),
  );
  return {
    surface: args.surface,
    split: args.split,
    auc: scoreAuc(scored.map((s) => ({ score: s.score, relevant: s.grade >= 1 }))),
    reliability: reliability.filter((band) => band.n > 0),
    points,
  };
}

export interface BaselineFloor {
  strictRecall5: number | null;
  setPrecision: number | null;
}

/**
 * The plan's selection rule, on the dev split: the threshold with the lowest
 * false-injection rate whose strict recall stays within two points of the
 * model-off baseline and whose set precision does not fall below it. Ties go
 * to the LOWER threshold — the one that drops less.
 */
export function chooseKeep(sweep: SurfaceSweep, baseline: BaselineFloor): SweepPoint | null {
  const feasible = sweep.points.filter(
    (point) =>
      (baseline.strictRecall5 === null ||
        (point.strictRecall5 ?? 0) >= baseline.strictRecall5 - 0.02) &&
      (baseline.setPrecision === null || (point.setPrecision ?? 0) >= baseline.setPrecision),
  );
  if (feasible.length === 0) return null;
  return feasible.reduce((best, point) =>
    (point.falseInjectionStrict ?? 1) < (best.falseInjectionStrict ?? 1) ? point : best,
  );
}

/** Search reorders; its drop threshold is the highest that costs no strict recall. */
export function chooseDrop(sweep: SurfaceSweep, baseline: BaselineFloor): SweepPoint | null {
  const feasible = sweep.points.filter(
    (point) =>
      baseline.strictRecall5 === null || (point.strictRecall5 ?? 0) >= baseline.strictRecall5,
  );
  return feasible.at(-1) ?? null;
}

/** The lowest score band at which at least `share` of candidates are the answer. */
export function chooseStrong(sweep: SurfaceSweep, share = 0.8): number | null {
  return sweep.reliability.find((band) => band.n >= 5 && band.answer >= share)?.low ?? null;
}

export interface SweepRecommendation {
  thresholds: RelevanceThresholds | null;
  rationale: string[];
}

export function recommendThresholds(args: {
  turn: SurfaceSweep | null;
  references: SurfaceSweep | null;
  search: SurfaceSweep | null;
  baselines: Partial<Record<RetrievalTraceSurface, BaselineFloor>>;
}): SweepRecommendation {
  const rationale: string[] = [];
  const keepPoint = args.turn ? chooseKeep(args.turn, args.baselines.turn ?? nullFloor) : null;
  if (!keepPoint) {
    return { thresholds: null, rationale: ['no turn threshold met the recall/precision floor'] };
  }
  rationale.push(
    `keep ${keepPoint.threshold}: turn dev false injection ${fmt(keepPoint.falseInjectionStrict)}, strict R@5 ${fmt(keepPoint.strictRecall5)}, set precision ${fmt(keepPoint.setPrecision)}`,
  );
  const dropPoint = args.search
    ? chooseDrop(args.search, args.baselines.search ?? nullFloor)
    : null;
  const searchDrop = dropPoint?.threshold;
  const fromSearch = searchDrop !== undefined && searchDrop < keepPoint.threshold;
  const dropValue = fromSearch ? searchDrop : keepPoint.threshold / 3;
  rationale.push(
    fromSearch
      ? `drop ${dropValue}: highest search threshold with no strict-recall loss`
      : `drop ${dropValue}: a third of keep (search's own cut was not below keep)`,
  );
  const strongBand = args.turn ? chooseStrong(args.turn) : null;
  const strong =
    strongBand !== null && strongBand > keepPoint.threshold
      ? strongBand
      : keepPoint.threshold + (1 - keepPoint.threshold) / 2;
  rationale.push(
    strongBand !== null && strongBand > keepPoint.threshold
      ? `strong ${strong}: lowest band where ≥80% of candidates are the answer`
      : `strong ${strong}: midpoint above keep (no band reached 80% answers)`,
  );
  return {
    thresholds: { drop: round2(dropValue), keep: keepPoint.threshold, strong: round2(strong) },
    rationale,
  };
}

const nullFloor: BaselineFloor = { strictRecall5: null, setPrecision: null };

/** Two significant figures: a threshold is a measured cut, not a computed constant. */
function round2(value: number): number {
  return Number(value.toPrecision(2));
}

function fmt(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Paired difference arm − baseline over the queries both judged, with a stratified bootstrap CI. */
export function pairedDelta(
  baseline: readonly JudgedRow[],
  arm: readonly JudgedRow[],
  stat: (row: JudgedRow) => number | null,
  opts: { iterations?: number; seed?: number } = {},
): Interval | null {
  const byKey = new Map(baseline.map((row) => [`${row.queryId}@${row.surface}`, row]));
  const pairs = arm
    .map((row) => ({ row, base: byKey.get(`${row.queryId}@${row.surface}`) }))
    .filter((pair): pair is { row: JudgedRow; base: JudgedRow } => pair.base !== undefined)
    .map(({ row, base }) => ({ class: row.class, a: stat(row), b: stat(base) }))
    .filter((pair) => pair.a !== null && pair.b !== null);
  return stratifiedBootstrap(pairs, (sample) => meanOf(sample.map((pair) => pair.a! - pair.b!)), {
    strata: (pair) => pair.class,
    ...opts,
  });
}

export function renderSweepMarkdown(args: {
  sweeps: readonly SurfaceSweep[];
  recommendation: SweepRecommendation;
  modelId: string;
}): string {
  const lines = [
    `# Relevance threshold sweep — ${args.modelId}`,
    '',
    'Replayed from the uncalibrated arm (scores every windowed candidate, drops nothing). Approximate by design; confirm the chosen thresholds live.',
    '',
    '## Recommendation',
    '',
    args.recommendation.thresholds
      ? `\`drop ${args.recommendation.thresholds.drop} · keep ${args.recommendation.thresholds.keep} · strong ${args.recommendation.thresholds.strong}\``
      : 'No thresholds recommended.',
    '',
    ...args.recommendation.rationale.map((line) => `- ${line}`),
    '',
  ];
  for (const sweep of args.sweeps) {
    lines.push(
      `## ${sweep.surface} — ${sweep.split} split (AUC ${fmt(sweep.auc)})`,
      '',
      '| threshold | nDCG@5 | strict R@5 | set precision | false injection | decoy items | mean kept |',
      '|---:|---:|---:|---:|---:|---:|---:|',
      ...sweep.points.map(
        (p) =>
          `| ${p.threshold} | ${fmt(p.ndcg5)} | ${fmt(p.strictRecall5)} | ${fmt(p.setPrecision)} | ${fmt(p.falseInjectionStrict)} | ${fmt(p.distractorItemRate)} | ${p.meanKept.toFixed(1)} |`,
      ),
      '',
      '| score band | candidates | relevant | answer |',
      '|---|---:|---:|---:|',
      ...sweep.reliability.map(
        (b) =>
          `| ${b.low}–${b.high} | ${b.n} | ${(b.relevant * 100).toFixed(0)}% | ${(b.answer * 100).toFixed(0)}% |`,
      ),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
