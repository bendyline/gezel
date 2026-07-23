#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface TrialFactsSummary {
  trialId?: string;
  scenarioId?: string;
  modelId?: string;
  modelTier?: string;
  timing?: {
    startedAt?: string;
  };
  outcome?: {
    success?: boolean;
    durationMs?: number;
  };
}

interface TrialResultSummary {
  scenarioId?: string;
  modelId?: string;
  modelTier?: string;
  startedAt?: string;
  success?: boolean;
  failureClass?: string;
  durationMs?: number;
}

export interface ScoredTrial {
  dir: string;
  modelId: string;
  scenarioId: string;
  startedAt: string;
  composite: number;
  success: boolean;
  /** From failure-class.json sidecar or result.json (absent on legacy trials). */
  failureClass?: string;
  /** Model capability tier (Theme E / E1-B); absent on pre-tier trials. */
  modelTier?: string;
  /** Trial wall-clock (ms); denominator for the completions/tier/hour metric (Theme F/F4.3). */
  durationMs?: number;
}

export interface ComparisonPair {
  key: string;
  modelId: string;
  scenarioId: string;
  pre: ScoredTrial;
  post: ScoredTrial;
  delta: number;
  /** `reference` pairs are excluded from the headline aggregate (see REFERENCE_CANONICAL_MODELS). */
  cohort: 'primary' | 'reference';
}

export interface ScoreComparison {
  cutoffIso: string;
  sourceCount: number;
  comparablePairs: ComparisonPair[];
  /** Headline aggregate over the PRIMARY cohort only (reference models excluded). */
  averagePre: number;
  averagePost: number;
  averageDelta: number;
  relativeLift: number;
  passingPre: number;
  passingPost: number;
  /** Primary-cohort pair count (denominator for the headline). */
  primaryPairCount: number;
  /** Reference cohort — tracked separately, not in the headline. */
  referencePairCount: number;
  referenceAveragePost: number;
  referencePassingPost: number;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function walk(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

function parseComposite(postmortem: string): number | null {
  const match = postmortem.match(/\*\*Composite:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*10\*\*/);
  if (!match) return null;
  return Number(match[1]);
}

function latestByStart(trials: ScoredTrial[]): ScoredTrial | null {
  return trials.reduce<ScoredTrial | null>((latest, trial) => {
    if (!latest) return trial;
    return Date.parse(trial.startedAt) > Date.parse(latest.startedAt) ? trial : latest;
  }, null);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmt1(value: number): string {
  return value.toFixed(1);
}

function signed1(value: number): string {
  return `${value >= 0 ? '+' : ''}${fmt1(value)}`;
}

export function discoverScoredTrials(runsDir: string): ScoredTrial[] {
  // basename match (not endsWith('/postmortem.md')) — `walk` builds paths
  // with the platform separator, so a forward-slash suffix check finds
  // nothing on Windows. Non-trial postmortems (e.g. a workspace
  // deliverable `postmortem.md`) still get filtered out below by the
  // missing facts.json/result.json metadata guard.
  const postmortemPaths = walk(runsDir).filter((path) => basename(path) === 'postmortem.md');
  const trials: ScoredTrial[] = [];
  for (const postmortemPath of postmortemPaths) {
    const dir = dirname(postmortemPath);
    const factsPath = join(dir, 'facts.json');
    const resultPath = join(dir, 'result.json');

    const facts = readJson<TrialFactsSummary>(factsPath);
    const result = facts ? null : readJson<TrialResultSummary>(resultPath);
    const modelId = facts?.modelId ?? result?.modelId;
    const scenarioId = facts?.scenarioId ?? result?.scenarioId;
    const startedAt = facts?.timing?.startedAt ?? result?.startedAt;
    if (!modelId || !scenarioId || !startedAt) continue;

    const composite = parseComposite(readFileSync(postmortemPath, 'utf8'));
    if (composite === null || !Number.isFinite(composite)) continue;

    // Failure-class accountability: prefer the backfilled sidecar, fall
    // back to the field the runner writes into result.json. Trials whose
    // failure was infra/operator/grader must not pollute model-vs-model
    // score comparisons (the scoreboard-trust work).
    const sidecar = readJson<{ failureClass?: string }>(join(dir, 'failure-class.json'));
    const resultForClass = result ?? readJson<TrialResultSummary>(resultPath);
    const failureClass = sidecar?.failureClass ?? resultForClass?.failureClass;

    const modelTier = facts?.modelTier ?? resultForClass?.modelTier;
    trials.push({
      dir: resolve(dir),
      modelId,
      scenarioId,
      startedAt,
      composite,
      success: (facts?.outcome?.success ?? result?.success) === true,
      ...(failureClass ? { failureClass } : {}),
      ...(modelTier ? { modelTier } : {}),
      ...(typeof (facts?.outcome?.durationMs ?? result?.durationMs) === 'number'
        ? { durationMs: facts?.outcome?.durationMs ?? result?.durationMs }
        : {}),
    });
  }
  return trials.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/**
 * Drop trials whose recorded failure class is not the model's fault
 * (infra, operator interrupt, grader artifact). Passing trials and
 * unclassified legacy trials are kept. Returns the kept set plus the
 * number excluded so reports can disclose the filtering.
 */
export function filterToModelAttributableTrials(trials: ScoredTrial[]): {
  kept: ScoredTrial[];
  excluded: number;
} {
  const NON_MODEL = new Set(['infra', 'operator', 'grader']);
  const kept = trials.filter((t) => !t.failureClass || !NON_MODEL.has(t.failureClass));
  return { kept, excluded: trials.length - kept.length };
}

export function canonicalModelId(modelId: string): string {
  const withoutQuant = modelId.replace(/-q\d+(?:_[a-z0-9]+)?$/i, '');
  const historicalAliases: Record<string, string> = {
    'mistral-7b': 'mistral',
    'qwen3.6-27b': 'qwen3.6',
  };
  return historicalAliases[withoutQuant] ?? withoutQuant;
}

/**
 * Reference models are TRACKED but excluded from the headline aggregate, so a
 * single model doesn't define the framework's quality number when its failures
 * aren't framework gaps:
 *  - `mistral` (Mistral-7B-Instruct-v0.3) — a dated 7B that a newer 4B
 *    out-classes; its 0/11 sweep is weak-base behavior, not a fixable framework gap.
 *  - `nemotron3-super-120b` — GPU-bound on the gx10 host; its misses are
 *    timeouts, not capability.
 * Keyed by `canonicalModelId` (quant-stripped). See evals/runs/sweep-v2/V2-REPORT.md
 * and the eval-single-trial-noise note. Use the primary-cohort number as the headline.
 */
export const REFERENCE_CANONICAL_MODELS: ReadonlySet<string> = new Set([
  'mistral', // mistral-7b-q4 → canonical 'mistral'
  'nemotron3-super-120b',
]);

export function isReferenceModel(modelId: string): boolean {
  return REFERENCE_CANONICAL_MODELS.has(canonicalModelId(modelId));
}

export function compareScores(trials: ScoredTrial[], cutoffIso: string): ScoreComparison {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) throw new Error(`invalid cutoff: ${cutoffIso}`);

  const byKey = new Map<string, ScoredTrial[]>();
  for (const trial of trials) {
    const key = `${canonicalModelId(trial.modelId)}\u0000${trial.scenarioId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), trial]);
  }

  const comparablePairs: ComparisonPair[] = [];
  for (const [key, grouped] of byKey) {
    const pre = latestByStart(grouped.filter((trial) => Date.parse(trial.startedAt) < cutoffMs));
    const post = latestByStart(grouped.filter((trial) => Date.parse(trial.startedAt) >= cutoffMs));
    if (!pre || !post) continue;
    comparablePairs.push({
      key,
      modelId: post.modelId,
      scenarioId: post.scenarioId,
      pre,
      post,
      delta: round1(post.composite - pre.composite),
      cohort: isReferenceModel(post.modelId) ? 'reference' : 'primary',
    });
  }
  comparablePairs.sort((a, b) => b.delta - a.delta || a.modelId.localeCompare(b.modelId));

  // Headline aggregate excludes reference models so a dated/host-bound model
  // doesn't define the framework number.
  const primary = comparablePairs.filter((pair) => pair.cohort === 'primary');
  const reference = comparablePairs.filter((pair) => pair.cohort === 'reference');
  const averagePre = primary.length ? round1(mean(primary.map((p) => p.pre.composite))) : 0;
  const averagePost = primary.length ? round1(mean(primary.map((p) => p.post.composite))) : 0;
  const averageDelta = round1(averagePost - averagePre);
  const relativeLift = averagePre === 0 ? 0 : round1((averageDelta / averagePre) * 100);

  return {
    cutoffIso,
    sourceCount: trials.length,
    comparablePairs,
    averagePre,
    averagePost,
    averageDelta,
    relativeLift,
    passingPre: primary.filter((pair) => pair.pre.composite >= 8).length,
    passingPost: primary.filter((pair) => pair.post.composite >= 8).length,
    primaryPairCount: primary.length,
    referencePairCount: reference.length,
    referenceAveragePost: reference.length
      ? round1(mean(reference.map((p) => p.post.composite)))
      : 0,
    referencePassingPost: reference.filter((pair) => pair.post.composite >= 8).length,
  };
}

export function renderMarkdownReport(comparison: ScoreComparison): string {
  const date = comparison.cutoffIso.slice(0, 10);
  const lines = [
    `# Current score comparison - ${date}`,
    '',
    `Source: ${comparison.sourceCount} scored trial directories from \`evals/runs\`, compared by latest pre-\`${comparison.cutoffIso}\` run vs latest post-cutoff run for matching \`(modelId, scenarioId)\` pairs.`,
    '',
    '## Aggregate (primary cohort)',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Primary pairs | ${comparison.primaryPairCount} |`,
    `| Average pre score | ${fmt1(comparison.averagePre)} |`,
    `| Average post score | ${fmt1(comparison.averagePost)} |`,
    `| Average delta | ${signed1(comparison.averageDelta)} |`,
    `| Relative score lift | ${signed1(comparison.relativeLift)}% |`,
    `| Passing pairs pre | ${comparison.passingPre} / ${comparison.primaryPairCount} |`,
    `| Passing pairs post | ${comparison.passingPost} / ${comparison.primaryPairCount} |`,
    '',
    '## Reference models (tracked separately, excluded from headline)',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Reference pairs | ${comparison.referencePairCount} |`,
    `| Average post score | ${comparison.referencePairCount ? fmt1(comparison.referenceAveragePost) : 'n/a'} |`,
    `| Passing pairs post | ${comparison.referencePassingPost} / ${comparison.referencePairCount} |`,
    '',
    '## Pairs',
    '',
    '| Model | Tier | Cohort | Scenario | Pre | Post | Delta | Pass pre -> post |',
    '|---|---|---|---|---:|---:|---:|---|',
  ];

  for (const pair of comparison.comparablePairs) {
    const passPre = pair.pre.composite >= 8 ? 'yes' : 'no';
    const passPost = pair.post.composite >= 8 ? 'yes' : 'no';
    const tier = pair.post.modelTier ?? pair.pre.modelTier ?? '?';
    lines.push(
      `| ${pair.modelId} | ${tier} | ${pair.cohort} | ${pair.scenarioId} | ${fmt1(pair.pre.composite)} | ${fmt1(pair.post.composite)} | ${signed1(pair.delta)} | ${passPre} -> ${passPost} |`,
    );
  }

  lines.push(
    '',
    '## Notes',
    '',
    '- This report is generated from trial directories that contain a scored trial `postmortem.md` plus sibling `facts.json` or `result.json` metadata.',
    '- Passing means the fixed-rubric composite is at least 8.0.',
    '- The headline aggregate is the PRIMARY cohort; reference models (dated weak base / host-bound giant) are tracked separately so they do not define the framework number. See `REFERENCE_CANONICAL_MODELS`.',
    '- This is a comparable-pair report, not proof that every downloaded model has been rerun. Each pair is a SINGLE pre vs SINGLE post trial (n=1 per side) — read `tiny`-tier pairs especially as anecdotes, not rates (single-trial noise is ±7pp; at tiny tier the base rate is a coin flip).',
    '- Tier `?` means the trial predates the Theme E modelTier stamp; re-run to populate.',
    '',
  );
  return lines.join('\n');
}

function defaultRunsDir(): string {
  if (existsSync('runs')) return 'runs';
  return 'evals/runs';
}

function main(): void {
  const args = process.argv.slice(2);
  let cutoffIso = '2026-06-05T00:00:00Z';
  let runsDir = defaultRunsDir();
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--cutoff') {
      cutoffIso = args[++i] ?? '';
    } else if (arg === '--out') {
      outPath = args[++i] ?? '';
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: compare-scores.ts [--cutoff ISO] [--out FILE] [runsDir]\n');
      return;
    } else if (arg !== '--') {
      runsDir = arg;
    }
  }
  const discovered = discoverScoredTrials(runsDir);
  const { kept, excluded } = filterToModelAttributableTrials(discovered);
  if (excluded > 0) {
    process.stdout.write(
      `<!-- ${excluded} trial(s) excluded from comparison: failure class infra/operator/grader (not model-attributable) -->\n`,
    );
  }
  const comparison = compareScores(kept, cutoffIso);
  const report = renderMarkdownReport(comparison);
  process.stdout.write(report);
  if (outPath) {
    writeFileSync(outPath, report.endsWith('\n') ? report : `${report}\n`);
    process.stderr.write(`\n[compare-scores] wrote ${outPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
