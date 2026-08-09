import {
  MIN_TRIALS_FOR_RATE,
  type ScorecardCell,
  type ScorecardDataset,
  type ScorecardModelResult,
  type ScorecardRun,
} from './schema.js';

/**
 * Turning a recorded sweep into the numbers an article may print.
 *
 * Every rule here exists to stop a true-looking number that the data does
 * not support. They are enforced in one place so the handboek macro, the
 * CLI report, and any future surface cannot disagree about what a score
 * means.
 */

export interface ModelScore {
  result: ScorecardModelResult;
  /** Scenarios where the model was actually on trial. */
  attributableTrials: number;
  successes: number;
  /** Trials thrown out as infra/operator/grader failures. */
  discardedTrials: number;
  /** null when the sample is too small to quote as a rate. */
  passRate: number | null;
  /** Rendered claim, always safe to print verbatim. */
  claim: string;
  /** Scenarios with zero attributable trials — measured nothing. */
  unmeasuredScenarios: string[];
}

/**
 * Attributable trials only: a cell's non-model failures are removed from
 * BOTH numerator and denominator. A wedged engine is not evidence about a
 * model, and letting it depress a pass rate publishes a claim about the
 * wrong thing.
 */
export function cellAttributableTrials(cell: ScorecardCell): number {
  return Math.max(0, cell.trials - cell.nonModelFailures);
}

/** Render a pass fraction, refusing to quote a rate the sample can't support. */
export function formatPassClaim(successes: number, trials: number): string {
  if (trials <= 0) return 'not measured';
  if (trials < MIN_TRIALS_FOR_RATE) {
    return `${successes}/${trials} (n<${MIN_TRIALS_FOR_RATE}, count not rate)`;
  }
  return `${successes}/${trials} (${Math.round((100 * successes) / trials)}%)`;
}

/**
 * Score one model.
 *
 * `trialsPerScenario` is the run's `count`, and it gates rate-quoting
 * independently of the aggregate. Three DIFFERENT tasks run once each is
 * not a sample of three — it is three samples of one, and it says nothing
 * about whether any of them reproduce. Without this, a `--count 1` sweep
 * over thirteen scenarios printed a confident percentage off thirteen
 * unrepeated attempts. Wild-caught on the first verify run.
 */
export function scoreModel(
  result: ScorecardModelResult,
  trialsPerScenario = MIN_TRIALS_FOR_RATE,
): ModelScore {
  let attributableTrials = 0;
  let successes = 0;
  let discardedTrials = 0;
  const unmeasuredScenarios: string[] = [];

  for (const cell of result.cells) {
    const attributable = cellAttributableTrials(cell);
    attributableTrials += attributable;
    successes += cell.successes;
    discardedTrials += cell.nonModelFailures;
    if (attributable === 0) unmeasuredScenarios.push(cell.scenarioId);
  }

  const repeated = trialsPerScenario >= MIN_TRIALS_FOR_RATE;
  const quotable = repeated && attributableTrials >= MIN_TRIALS_FOR_RATE;
  return {
    result,
    attributableTrials,
    successes,
    discardedTrials,
    passRate: quotable ? successes / attributableTrials : null,
    claim:
      attributableTrials === 0
        ? 'not measured'
        : quotable
          ? formatPassClaim(successes, attributableTrials)
          : repeated
            ? formatPassClaim(successes, attributableTrials)
            : `${successes}/${attributableTrials} (each task run once — count not rate)`,
    unmeasuredScenarios,
  };
}

/**
 * The run whose numbers a suite's headline table should show: the newest
 * run that covered that suite. `runs` is newest-first by contract, but sort
 * defensively — a hand-edited dataset should not silently reorder history.
 */
export function headlineRunForSuite(
  dataset: ScorecardDataset,
  suiteId: string,
): ScorecardRun | null {
  const covering = dataset.runs
    .filter((run) => run.suites.includes(suiteId))
    .sort((a, b) => b.provenance.startedAt.localeCompare(a.provenance.startedAt));
  return covering[0] ?? null;
}

export interface SuiteScoreboard {
  suiteId: string;
  run: ScorecardRun;
  /** Models measured in the headline run, best first. */
  scores: ModelScore[];
  /**
   * Models present in the dataset for this suite but measured under
   * DIFFERENT provenance. Never merged into `scores` — rendered separately
   * so a reader can see they are not directly comparable.
   */
  otherRunScores: Array<ModelScore & { run: ScorecardRun }>;
  /** Scenario ids as run, for the "what was measured" list. */
  scenarioIds: string[];
}

/**
 * Build one suite's scoreboard.
 *
 * Sorting is by successes-per-attributable-trial with the raw success
 * count as the tiebreak, so a model that ran fewer attributable trials
 * cannot outrank one that ran the full set on the same ratio.
 */
export function buildSuiteScoreboard(
  dataset: ScorecardDataset,
  suiteId: string,
): SuiteScoreboard | null {
  const run = headlineRunForSuite(dataset, suiteId);
  if (!run) return null;

  const forSuite = dataset.results.filter((result) => result.suiteId === suiteId);
  const runsById = new Map(dataset.runs.map((entry) => [entry.id, entry]));

  const scores = forSuite
    .filter((result) => result.runId === run.id)
    .map((result) => scoreModel(result, run.provenance.count))
    .sort((a, b) => {
      const ratioA = a.attributableTrials > 0 ? a.successes / a.attributableTrials : -1;
      const ratioB = b.attributableTrials > 0 ? b.successes / b.attributableTrials : -1;
      return (
        ratioB - ratioA || b.successes - a.successes || a.result.label.localeCompare(b.result.label)
      );
    });

  const otherRunScores = forSuite
    .filter((result) => result.runId !== run.id)
    .map((result) => {
      const own = runsById.get(result.runId);
      return { ...scoreModel(result, own?.provenance.count), run: own! };
    })
    .filter((entry) => !!entry.run)
    .sort((a, b) => b.run.provenance.startedAt.localeCompare(a.run.provenance.startedAt));

  return {
    suiteId,
    run,
    scores,
    otherRunScores,
    scenarioIds: run.scenariosBySuite[suiteId] ?? [],
  };
}

/**
 * One-line provenance stamp. Every published table needs this next to it —
 * a score without its device, date, and code version is not a measurement,
 * it is a rumour.
 */
export function describeProvenance(run: ScorecardRun): string {
  const p = run.provenance;
  const parts = [
    p.device.label,
    `${p.count} trial${p.count === 1 ? '' : 's'} per task`,
    p.startedAt.slice(0, 10),
    `gezel ${p.harnessCommit}`,
    `catalog ${p.gildeVersion}`,
  ];
  return parts.join(' · ');
}

/**
 * Whether two runs measured the same thing. Used to explain, in the
 * article, exactly why an off-run result is footnoted rather than merged.
 */
export function provenanceDifferences(a: ScorecardRun, b: ScorecardRun): string[] {
  const out: string[] = [];
  if (a.provenance.device.label !== b.provenance.device.label) out.push('different device');
  if (a.provenance.harnessCommit !== b.provenance.harnessCommit) out.push('different gezel build');
  if (a.provenance.gildeVersion !== b.provenance.gildeVersion)
    out.push('different catalog version');
  if (a.provenance.count !== b.provenance.count) out.push('different trial count');
  return out;
}
