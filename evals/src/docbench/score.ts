/**
 * Docbench scoring: from case outcomes and judgements to one number per model.
 *
 * - A **case** scores 0 when the product would have shown the person nothing
 *   (`usable: false`). Otherwise it blends the pack's deterministic checks
 *   with the judge, by the task's `scoring` weights. A matcher judge's part
 *   is the F1 of its labels (recall over the answer key, precision over the
 *   model's items), blended with its axes.
 * - Infrastructure failures (the endpoint, not the model) are excluded, never
 *   scored as zero.
 * - A **task** is the mean over its cases of each case's mean over trials.
 * - A **family** is the mean of its tasks; **docbench** is the weighted mean
 *   of the families present, renormalized, times 100. `coverage` says how
 *   much of the pack's declared weight was present.
 * - **Intervals** come from one nested bootstrap: cases are resampled within
 *   each task and trials within each case, so repeats of one case are never
 *   treated as independent evidence. Ranks are reported as bands of models
 *   whose intervals overlap.
 */

import type {
  BenchCaseOutcome,
  BenchComplexity,
  BenchJudgeSpec,
  BenchPackManifest,
} from '@bendyline/gezel/eval';

/** One complexity level's share of a matcher verdict. */
export interface LevelCounts {
  /** Answer-key issues at this level, and how many the output found. */
  readonly keyTotal: number;
  readonly found: number;
  /** The output's valid items the judge put at this level. */
  readonly valid: number;
}

/** What a matcher judge labelled, counted. */
export interface MatchCounts {
  /** Answer-key issues the output found. */
  readonly found: number;
  readonly keyTotal: number;
  readonly valid: number;
  readonly trivial: number;
  readonly wrong: number;
  /** By complexity, when the task labels levels. */
  readonly levels?: Readonly<Record<BenchComplexity, LevelCounts>>;
}

/**
 * How much finding an issue of each level counts toward recall: a review that
 * catches the buried conclusion did more than one that catches a typo.
 */
export const LEVEL_WEIGHTS: Readonly<Record<BenchComplexity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

/** One judge verdict on one case outcome. */
export interface CaseJudgement {
  readonly rubricId: string;
  readonly promptVersion: number;
  readonly judgeModel: string;
  /** Judged by the pinned official judge; anything else is a diagnostic. */
  readonly official: boolean;
  /** Axis scores, 0–10. */
  readonly axes: Readonly<Record<string, number>>;
  readonly match?: MatchCounts;
  readonly reasons: string;
  /** The judge could not be run or parsed; the case counts as unjudged. */
  readonly error?: string;
}

export interface MatchScore {
  readonly recall: number;
  readonly precision: number;
  readonly f1: number;
  /** The share of the matcher's score: F1, or for a decoy, the absence of false alarms. */
  readonly score: number;
}

/** False alarms that take a decoy (a document with nothing to find) to zero. */
export const DECOY_FALSE_POSITIVES = 3;

/**
 * F1 over the matcher's labels. Trivial and wrong items are false positives:
 * a review that praises the text or restates it is as unhelpful as a wrong
 * one. When the key has levels, recall weights each issue by
 * {@link LEVEL_WEIGHTS}. With no answer key (a decoy), the score is how few
 * false alarms it raised.
 */
export function matchScore(counts: MatchCounts): MatchScore {
  const items = counts.valid + counts.trivial + counts.wrong;
  if (counts.keyTotal === 0) {
    const falsePositives = counts.trivial + counts.wrong;
    const score = 1 - Math.min(1, falsePositives / DECOY_FALSE_POSITIVES);
    return { recall: 1, precision: items === 0 ? 1 : counts.valid / items, f1: score, score };
  }
  const levels = counts.levels ? Object.entries(counts.levels) : [];
  const weightedKey = levels.reduce(
    (sum, [level, value]) => sum + LEVEL_WEIGHTS[level as BenchComplexity] * value.keyTotal,
    0,
  );
  const recall =
    weightedKey > 0
      ? Math.min(
          1,
          levels.reduce(
            (sum, [level, value]) => sum + LEVEL_WEIGHTS[level as BenchComplexity] * value.found,
            0,
          ) / weightedKey,
        )
      : Math.min(1, counts.found / counts.keyTotal);
  const precision = items === 0 ? 0 : counts.valid / items;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { recall, precision, f1, score: f1 };
}

/** Weighted mean of a case's checks, 0–1; full marks when it has none. */
export function checkScore(outcome: Pick<BenchCaseOutcome, 'checks'>): number {
  const weight = outcome.checks.reduce((sum, check) => sum + check.weight, 0);
  if (weight === 0) return 1;
  return outcome.checks.reduce((sum, check) => sum + check.score * check.weight, 0) / weight;
}

/** The judge's part of a case, 0–1, or null when there is no usable verdict. */
export function judgeScore(
  judgement: CaseJudgement | null | undefined,
  spec: BenchJudgeSpec,
): number | null {
  if (!judgement || judgement.error) return null;
  const axisValues = spec.axes
    .map((axis) => judgement.axes[axis.id])
    .filter((value): value is number => typeof value === 'number');
  const axisMean =
    axisValues.length === 0
      ? null
      : axisValues.reduce((sum, value) => sum + value, 0) / axisValues.length / 10;
  if (spec.mode === 'matcher') {
    if (!judgement.match) return null;
    const match = matchScore(judgement.match).score;
    const weight = axisMean === null ? 1 : (spec.matchWeight ?? 1);
    return weight * match + (1 - weight) * (axisMean ?? 0);
  }
  return axisMean;
}

export interface CaseScore {
  readonly score: number;
  /**
   * The score is final: the task needs no judge, the case was unusable, or a
   * verdict contributed. False only when a verdict the task needs is missing.
   */
  readonly judged: boolean;
}

export interface TaskScoring {
  readonly scoring: { readonly checks: number; readonly judge: number };
  readonly judge: BenchJudgeSpec | null;
}

/**
 * One outcome's score, 0–1. Without a verdict for a judged task the checks
 * stand alone, and `judged` says so: a report must not present that as a
 * docbench score.
 */
export function caseScore(
  outcome: Pick<BenchCaseOutcome, 'usable' | 'checks'>,
  task: TaskScoring,
  judgement: CaseJudgement | null | undefined,
): CaseScore {
  // Nothing reached the person: zero is final, with or without a verdict.
  if (!outcome.usable) return { score: 0, judged: true };
  const checks = checkScore(outcome);
  if (!task.judge) return { score: checks, judged: true };
  const judged = judgeScore(judgement, task.judge);
  if (judged === null) return { score: checks, judged: false };
  const total = task.scoring.checks + task.scoring.judge;
  return {
    score: (task.scoring.checks * checks + task.scoring.judge * judged) / (total || 1),
    judged: true,
  };
}

/** A deterministic PRNG, so a report's intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = readonly [number, number];

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index] ?? Number.NaN;
}

function interval(values: number[]): Interval {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return [percentile(sorted, 0.025), percentile(sorted, 0.975)];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export interface TaskResult {
  readonly score: number;
  readonly ci: Interval;
  /** Scored trials (infrastructure failures excluded) the product could use. */
  readonly usableRate: number;
  readonly cases: number;
  readonly trials: number;
  readonly infraFailures: number;
  /** Share of scored trials a judge verdict contributed to. */
  readonly judgedShare: number;
  /** Median completion tokens per case: what one use of the feature costs in output. */
  readonly medianOutputTokens: number | null;
  /** For a matcher task: what its findings were made of, per judged output. */
  readonly findings?: FindingProfile;
}

/**
 * A review's depth, from matcher verdicts: how many valid suggestions of each
 * complexity a document got on average, how many were trivial or wrong, and
 * the share of seeded issues found at each level.
 */
export interface FindingProfile {
  /** Judged outputs the averages are over. */
  readonly outputs: number;
  readonly perOutput: Readonly<Record<BenchComplexity | 'trivial' | 'wrong', number>>;
  /** Null for a level the answer keys have no issues at. */
  readonly recallByLevel: Readonly<Record<BenchComplexity, number | null>>;
  readonly precision: number;
}

function findingProfile(matches: readonly MatchCounts[]): FindingProfile | undefined {
  if (matches.length === 0) return undefined;
  const sum = (pick: (match: MatchCounts) => number) =>
    matches.reduce((total, match) => total + pick(match), 0);
  const level = (name: BenchComplexity, field: keyof LevelCounts) =>
    sum((match) => match.levels?.[name]?.[field] ?? 0);
  const recall = (name: BenchComplexity) => {
    const total = level(name, 'keyTotal');
    return total === 0 ? null : level(name, 'found') / total;
  };
  const items = sum((match) => match.valid + match.trivial + match.wrong);
  return {
    outputs: matches.length,
    perOutput: {
      low: level('low', 'valid') / matches.length,
      medium: level('medium', 'valid') / matches.length,
      high: level('high', 'valid') / matches.length,
      trivial: sum((match) => match.trivial) / matches.length,
      wrong: sum((match) => match.wrong) / matches.length,
    },
    recallByLevel: { low: recall('low'), medium: recall('medium'), high: recall('high') },
    precision: items === 0 ? 0 : sum((match) => match.valid) / items,
  };
}

export interface FamilyResult {
  readonly score: number;
  readonly ci: Interval;
  readonly tasks: readonly string[];
}

export interface ModelScore {
  /** 0–100. */
  readonly docbench: number;
  readonly ci: Interval;
  /** Share of the pack's declared family weight this score covers. */
  readonly coverage: number;
  readonly missingFamilies: readonly string[];
  readonly usableRate: number;
  readonly judgedShare: number;
  readonly families: Readonly<Record<string, FamilyResult>>;
  readonly tasks: Readonly<Record<string, TaskResult>>;
}

export interface ScoreOptions {
  readonly iterations?: number;
  readonly seed?: number;
}

/** The key a judgement is stored under. */
export function outcomeKey(outcome: Pick<BenchCaseOutcome, 'taskId' | 'caseId' | 'trial'>): string {
  return `${outcome.taskId}/${outcome.caseId}#${String(outcome.trial)}`;
}

/** Score one model's outcomes against the pack that produced them. */
export function scoreModel(
  manifest: BenchPackManifest,
  outcomes: readonly BenchCaseOutcome[],
  judgements: ReadonlyMap<string, CaseJudgement>,
  options: ScoreOptions = {},
): ModelScore {
  // task → case → trial scores
  const byTask = new Map<string, Map<string, number[]>>();
  const stats = new Map<
    string,
    {
      usable: number;
      scored: number;
      infra: number;
      judged: number;
      tokens: number[];
      matches: MatchCounts[];
    }
  >();
  for (const task of manifest.tasks) {
    byTask.set(task.id, new Map());
    stats.set(task.id, { usable: 0, scored: 0, infra: 0, judged: 0, tokens: [], matches: [] });
  }
  for (const outcome of outcomes) {
    const task = manifest.tasks.find((item) => item.id === outcome.taskId);
    const cases = byTask.get(outcome.taskId);
    const stat = stats.get(outcome.taskId);
    if (!task || !cases || !stat) continue;
    if (outcome.error?.class === 'infra') {
      stat.infra += 1;
      continue;
    }
    const judgement = judgements.get(outcomeKey(outcome));
    const scored = caseScore(outcome, task, judgement);
    if (outcome.usable && judgement?.match && !judgement.error) stat.matches.push(judgement.match);
    const trials = cases.get(outcome.caseId) ?? [];
    trials.push(scored.score);
    cases.set(outcome.caseId, trials);
    stat.scored += 1;
    if (outcome.usable) stat.usable += 1;
    if (scored.judged) stat.judged += 1;
    const tokens = outcome.calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);
    if (outcome.calls.length > 0) stat.tokens.push(tokens);
  }

  const presentTasks = manifest.tasks.filter((task) => (byTask.get(task.id)?.size ?? 0) > 0);
  const presentFamilies = manifest.families.filter((family) =>
    presentTasks.some((task) => task.family === family.id),
  );
  const familyWeight = presentFamilies.reduce((sum, family) => sum + family.weight, 0);
  const declaredWeight = manifest.families.reduce((sum, family) => sum + family.weight, 0);

  const point = (taskScores: ReadonlyMap<string, number>) => {
    const families: Record<string, number> = {};
    for (const family of presentFamilies) {
      // A family is the weighted mean of its tasks; a task weighs 1 unless the pack says otherwise.
      const members = presentTasks.filter((task) => task.family === family.id);
      const total = members.reduce((sum, task) => sum + (task.weight ?? 1), 0);
      families[family.id] =
        total === 0
          ? Number.NaN
          : members.reduce(
              (sum, task) => sum + (task.weight ?? 1) * (taskScores.get(task.id) ?? Number.NaN),
              0,
            ) / total;
    }
    const docbench =
      familyWeight === 0
        ? Number.NaN
        : (100 *
            presentFamilies.reduce(
              (sum, family) => sum + family.weight * (families[family.id] ?? 0),
              0,
            )) /
          familyWeight;
    return { families, docbench };
  };

  const taskPoint = new Map<string, number>();
  for (const task of presentTasks) {
    const cases = [...(byTask.get(task.id)?.values() ?? [])];
    taskPoint.set(task.id, mean(cases.map(mean)));
  }
  const estimate = point(taskPoint);

  // One bootstrap for every level, so the intervals agree with each other.
  const random = mulberry32(options.seed ?? 0x5eed);
  const iterations = options.iterations ?? 2000;
  const draws = {
    docbench: [] as number[],
    families: new Map<string, number[]>(presentFamilies.map((family) => [family.id, []])),
    tasks: new Map<string, number[]>(presentTasks.map((task) => [task.id, []])),
  };
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error('bootstrap drew from an empty sample');
    return value;
  };
  for (let i = 0; i < iterations; i += 1) {
    const resampled = new Map<string, number>();
    for (const task of presentTasks) {
      const cases = [...(byTask.get(task.id)?.values() ?? [])];
      const caseMeans = cases.map(() => {
        const trials = pick(cases);
        return mean(trials.map(() => pick(trials)));
      });
      const value = mean(caseMeans);
      resampled.set(task.id, value);
      draws.tasks.get(task.id)?.push(value);
    }
    const drawn = point(resampled);
    draws.docbench.push(drawn.docbench);
    for (const family of presentFamilies) {
      draws.families.get(family.id)?.push(drawn.families[family.id] ?? Number.NaN);
    }
  }

  const tasks: Record<string, TaskResult> = {};
  let usable = 0;
  let scored = 0;
  let judged = 0;
  for (const task of manifest.tasks) {
    const stat = stats.get(task.id);
    const cases = byTask.get(task.id);
    if (!stat || !cases || cases.size === 0) continue;
    usable += stat.usable;
    scored += stat.scored;
    judged += stat.judged;
    tasks[task.id] = {
      score: taskPoint.get(task.id) ?? Number.NaN,
      ci: interval(draws.tasks.get(task.id) ?? []),
      usableRate: stat.scored === 0 ? 0 : stat.usable / stat.scored,
      cases: cases.size,
      trials: stat.scored,
      infraFailures: stat.infra,
      judgedShare: stat.scored === 0 ? 0 : stat.judged / stat.scored,
      medianOutputTokens: median(stat.tokens),
      ...(stat.matches.length > 0 ? { findings: findingProfile(stat.matches) } : {}),
    };
  }
  const families: Record<string, FamilyResult> = {};
  for (const family of presentFamilies) {
    families[family.id] = {
      score: estimate.families[family.id] ?? Number.NaN,
      ci: interval(draws.families.get(family.id) ?? []),
      tasks: presentTasks.filter((task) => task.family === family.id).map((task) => task.id),
    };
  }
  const ci = interval(draws.docbench);
  return {
    docbench: estimate.docbench,
    ci,
    coverage: declaredWeight === 0 ? 0 : familyWeight / declaredWeight,
    missingFamilies: manifest.families
      .filter((family) => !presentFamilies.includes(family))
      .map((family) => family.id),
    usableRate: scored === 0 ? 0 : usable / scored,
    judgedShare: scored === 0 ? 0 : judged / scored,
    families,
    tasks,
  };
}

/**
 * Rank bands: models sorted by score share a band while their intervals
 * overlap the band leader's. Band 1 is the best. A model whose interval sits
 * wholly below its band leader's starts the next band.
 */
export function assignBands(
  models: readonly { readonly id: string; readonly score: number; readonly ci: Interval }[],
): Map<string, number> {
  const sorted = [...models].sort((a, b) => b.score - a.score);
  const bands = new Map<string, number>();
  let band = 0;
  let leader: (typeof sorted)[number] | undefined;
  for (const model of sorted) {
    if (!leader || model.ci[1] < leader.ci[0]) {
      band += 1;
      leader = model;
    }
    bands.set(model.id, band);
  }
  return bands;
}
