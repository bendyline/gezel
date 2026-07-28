import type { TrialFacts } from './bin/score-trial.ts';

export const FIXED_RUBRIC_VERSION = 'eval-run-fixed-v1' as const;

export type RubricBand = 'ship-ready' | 'needs-tuning' | 'framework-gap';
export type EvidenceSource = 'facts' | 'result';

export interface EvidenceRef {
  source: EvidenceSource;
  /** Dot path into facts.json or result.json. */
  path: string;
  /** Exact value observed at the path when the score was computed. */
  value: unknown;
}

export interface AxisScore {
  score: number;
  ruleId: string;
  summary: string;
  evidence: EvidenceRef[];
  adjustments?: Array<{
    ruleId: string;
    summary: string;
  }>;
}

export interface QualityProfile {
  /** Cap quality at 5 when the primary game HTML is below this byte floor. */
  gameHtmlMinBytes?: number;
  /** Require at least one generated raster image and scale it to this byte floor. */
  requiredRasterMinBytes?: number;
}

export interface TrialResultMetadata {
  failureClass?: string;
  failureClassRule?: string;
  failureClassEvidence?: string;
}

export interface FixedRubricScore {
  rubricVersion: typeof FIXED_RUBRIC_VERSION;
  trialId: string;
  scenarioId: string;
  modelId: string;
  eligibility: {
    failureClass: string;
    includedInModelAggregate: boolean;
    failureClassRule?: string;
    evidence: EvidenceRef[];
  };
  qualityProfile: QualityProfile;
  axes: {
    completion: AxisScore;
    quality: AxisScore;
    efficiency: AxisScore;
    behavior: AxisScore;
  };
  composite: number;
  band: RubricBand;
}

const CRITICAL_OUTPUT_RE =
  /no inline\s*<script|no script tag|does not parse|parse error|(?:html|javascript|json|ya?ml)\s+(?:is\s+)?invalid|syntax error/i;

const WATCHDOG_FAILURES = new Set(['timeout', 'no-progress', 'chat-stalled', 'model-stuck']);
const NON_MODEL_FAILURE_CLASSES = new Set(['infra', 'grader', 'operator']);
const RASTER_IMAGE_RE = /\.(?:png|jpe?g|webp)$/i;

const BUILTIN_QUALITY_PROFILES: Readonly<Record<string, QualityProfile>> = {
  tictactoe: { gameHtmlMinBytes: 4 * 1024 },
  tankcombat: { gameHtmlMinBytes: 4 * 1024 },
  'arcade-deluxe': { gameHtmlMinBytes: 4 * 1024 },
  petshop: { requiredRasterMinBytes: 50 * 1024 },
  'tool-routing-image': { requiredRasterMinBytes: 50 * 1024 },
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function factsEvidence(path: string, value: unknown): EvidenceRef {
  return { source: 'facts', path, value };
}

function resultEvidence(path: string, value: unknown): EvidenceRef {
  return { source: 'result', path, value };
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.source}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function criticalOutputText(facts: TrialFacts): string {
  return `${facts.outcome.reason}\n${facts.sniff.latest?.failReason ?? ''}`;
}

function hasProducedOutput(facts: TrialFacts): boolean {
  return (
    facts.outcome.success ||
    facts.timing.timeToFirstArtifactMs !== null ||
    (facts.sniff.latest?.bytes ?? 0) > 0
  );
}

/**
 * A normalized scenario-gate ratio when the denominator is observable.
 * A successful terminal verdict is authoritative even for legacy sniff
 * lines that did not log a denominator. Failed null-denominator sniffs stay
 * unknown; signals.length is not a substitute because some gates omit their
 * signal list while still reporting a score.
 */
function sniffRatio(facts: TrialFacts): number | null {
  const latest = facts.sniff.latest;
  if (latest && typeof latest.scoreMax === 'number' && latest.scoreMax > 0) {
    return clamp(latest.score / latest.scoreMax);
  }
  return facts.outcome.success ? 1 : null;
}

export function qualityProfileForScenario(scenarioId: string): QualityProfile {
  return { ...(BUILTIN_QUALITY_PROFILES[scenarioId] ?? {}) };
}

function scoreCompletion(facts: TrialFacts): AxisScore {
  const baseEvidence = [factsEvidence('outcome.success', facts.outcome.success)];
  if (facts.outcome.success) {
    return {
      score: 10,
      ruleId: 'C_SUCCESS',
      summary: 'The scenario reached a successful terminal verdict.',
      evidence: baseEvidence,
    };
  }

  if (facts.outcome.failureMode !== undefined) {
    baseEvidence.push(factsEvidence('outcome.failureMode', facts.outcome.failureMode));
  }
  if (CRITICAL_OUTPUT_RE.test(criticalOutputText(facts))) {
    return {
      score: 0,
      ruleId: 'C_CRITICAL_OUTPUT',
      summary: 'The terminal evidence reports an unparseable or structurally missing output.',
      evidence: dedupeEvidence([
        ...baseEvidence,
        factsEvidence('outcome.reason', facts.outcome.reason),
        ...(facts.sniff.latest
          ? [factsEvidence('sniff.latest.failReason', facts.sniff.latest.failReason)]
          : []),
      ]),
    };
  }

  if (
    facts.outcome.failureMode === undefined ||
    facts.outcome.failureMode === 'success-check-false'
  ) {
    return {
      score: 6,
      ruleId: 'C_DONE_FALSE',
      summary: 'The scenario completed its terminal check but did not satisfy it.',
      evidence: [...baseEvidence, factsEvidence('outcome.reason', facts.outcome.reason)],
    };
  }

  if (WATCHDOG_FAILURES.has(facts.outcome.failureMode)) {
    const ratio = sniffRatio(facts);
    const unknownMaxPartial =
      ratio === null &&
      hasProducedOutput(facts) &&
      facts.sniff.latest !== null &&
      facts.sniff.latest.score > 0;
    const partial = (ratio !== null && ratio >= 0.5) || unknownMaxPartial;
    return {
      score: partial ? 3 : 0,
      ruleId: partial ? 'C_WATCHDOG_PARTIAL' : 'C_WATCHDOG_LOW_OR_NONE',
      summary: partial
        ? 'A watchdog ended the trial after at least half of a measured gate, or after observable progress with an unavailable denominator.'
        : 'A watchdog ended the trial without evidence that at least half of the gate was reached.',
      evidence: dedupeEvidence([
        ...baseEvidence,
        factsEvidence('outcome.reason', facts.outcome.reason),
        factsEvidence('timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs),
        factsEvidence('sniff.latest', facts.sniff.latest),
      ]),
    };
  }

  return {
    score: 0,
    ruleId: 'C_NONTERMINAL_FAILURE',
    summary: 'The trial crashed, was interrupted, or failed before a terminal deliverable verdict.',
    evidence: [...baseEvidence, factsEvidence('outcome.reason', facts.outcome.reason)],
  };
}

function scoreQuality(facts: TrialFacts, profile: QualityProfile): AxisScore {
  const latest = facts.sniff.latest;
  const evidence: EvidenceRef[] = [
    factsEvidence('outcome.success', facts.outcome.success),
    factsEvidence('timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs),
    factsEvidence('sniff.latest', latest),
  ];

  if (CRITICAL_OUTPUT_RE.test(criticalOutputText(facts))) {
    return {
      score: 0,
      ruleId: 'Q_CRITICAL_OUTPUT',
      summary: 'The available output is unparseable or lacks a required structural script surface.',
      evidence: dedupeEvidence([
        ...evidence,
        factsEvidence('outcome.reason', facts.outcome.reason),
      ]),
    };
  }

  if (!hasProducedOutput(facts)) {
    return {
      score: 0,
      ruleId: 'Q_NO_PRODUCED_OUTPUT',
      summary: 'No authored artifact event or scored sniff output was observed.',
      evidence,
    };
  }

  const ratio = sniffRatio(facts);
  let score: number;
  let ruleId: string;
  let summary: string;
  if (ratio !== null) {
    score = round1(10 * ratio);
    ruleId = ratio === 1 ? 'Q_GATE_COMPLETE' : 'Q_GATE_RATIO';
    summary =
      ratio === 1
        ? 'The scenario gate is complete.'
        : `The latest scenario gate reached ${round1(ratio * 100)}% of its measured signals.`;
  } else if (latest && latest.score <= 0) {
    score = 0;
    ruleId = 'Q_ZERO_SCORE_UNKNOWN_MAX';
    summary = 'The gate denominator is unavailable and the observed gate score is zero.';
  } else {
    score = 5;
    ruleId = latest ? 'Q_PARTIAL_UNKNOWN_MAX' : 'Q_UNGRADED_AUTHORED_OUTPUT';
    summary = latest
      ? 'An authored, scored output exists, but the gate denominator is unavailable; partial credit is capped at the rubric midpoint.'
      : 'An authored output exists without a sniff verdict; quality is capped at the rubric midpoint.';
  }

  const adjustments: NonNullable<AxisScore['adjustments']> = [];
  if (profile.gameHtmlMinBytes !== undefined) {
    const primaryBytes =
      latest?.bytes ?? Math.max(0, ...facts.artifacts.htmlFiles.map((file) => file.finalBytes));
    evidence.push(
      latest
        ? factsEvidence('sniff.latest.bytes', primaryBytes)
        : factsEvidence('artifacts.htmlFiles', facts.artifacts.htmlFiles),
    );
    if (primaryBytes < profile.gameHtmlMinBytes) {
      score = Math.min(score, 5);
      adjustments.push({
        ruleId: 'Q_HTML_REALISM_CAP',
        summary: `Primary game HTML is ${primaryBytes} bytes, below the ${profile.gameHtmlMinBytes}-byte realism floor; quality is capped at 5.`,
      });
    }
  }

  if (profile.requiredRasterMinBytes !== undefined) {
    const qualifying = facts.artifacts.imageFiles.filter(
      (file) => RASTER_IMAGE_RE.test(file.path) && file.real !== false,
    );
    const largestBytes = Math.max(0, ...qualifying.map((file) => file.bytes));
    const imageScore = round1(10 * clamp(largestBytes / profile.requiredRasterMinBytes));
    score = Math.min(score, imageScore);
    evidence.push(factsEvidence('artifacts.imageFiles', facts.artifacts.imageFiles));
    if (imageScore < 10) {
      adjustments.push({
        ruleId: 'Q_RASTER_REALISM_CAP',
        summary: `Largest qualifying raster is ${largestBytes} bytes against a ${profile.requiredRasterMinBytes}-byte realism floor; image quality contributes a cap of ${imageScore}.`,
      });
    }
  }

  return {
    score: round1(score),
    ruleId,
    summary,
    evidence: dedupeEvidence(evidence),
    ...(adjustments.length > 0 ? { adjustments } : {}),
  };
}

function scoreEfficiency(facts: TrialFacts): AxisScore {
  const budget = facts.outcome.budgetUsedFraction;
  const calls = facts.toolUse.totalToolCalls;
  const severeBudget = Number.isFinite(budget) && budget >= 1;
  const severeCalls = calls >= 30;
  const efficientBudget = Number.isFinite(budget) && budget <= 0.5;
  const efficientCalls = calls <= 10;
  const evidence = [
    factsEvidence('outcome.budgetUsedFraction', budget),
    factsEvidence('toolUse.totalToolCalls', calls),
    factsEvidence('timing.timeToFirstArtifactMs', facts.timing.timeToFirstArtifactMs),
    factsEvidence('outcome.durationMs', facts.outcome.durationMs),
  ];

  if (severeBudget && severeCalls) {
    return {
      score: 0,
      ruleId: 'E_BOTH_SEVERE',
      summary: 'The trial exhausted its budget while making at least thirty tool calls.',
      evidence,
    };
  }
  if (severeBudget || severeCalls) {
    return {
      score: 2.5,
      ruleId: 'E_ONE_SEVERE',
      summary: 'Exactly one efficiency dimension reached the severe threshold.',
      evidence,
    };
  }
  if (efficientBudget && efficientCalls) {
    return {
      score: 10,
      ruleId: 'E_LOW_BUDGET_LOW_CALLS',
      summary: 'The trial used at most half its budget and no more than ten tool calls.',
      evidence,
    };
  }
  if (
    (efficientBudget && calls >= 11 && calls <= 19) ||
    (budget > 0.5 && budget < 1 && efficientCalls)
  ) {
    return {
      score: 7.5,
      ruleId: 'E_ONE_MILD_INTERMEDIATE',
      summary: 'One efficiency dimension is efficient and the other is mildly intermediate.',
      evidence,
    };
  }
  return {
    score: 5,
    ruleId: 'E_MODERATE',
    summary:
      'The non-severe efficiency evidence is moderate, including a 20-29 call trace or two intermediate dimensions.',
    evidence,
  };
}

function scoreBehavior(facts: TrialFacts): AxisScore {
  const redFlags = facts.toolUse.redFlags;
  const missingRoles = facts.team.missingExpectedRoles;
  const autoAnswers = facts.autoAnswer.total;
  const evidence = [
    factsEvidence('toolUse.redFlags', redFlags),
    factsEvidence('team.missingExpectedRoles', missingRoles),
    factsEvidence('autoAnswer.total', autoAnswers),
  ];

  if (redFlags.length > 0 || missingRoles.length > 0) {
    return {
      score: 0,
      ruleId: 'B_RED_FLAG_OR_MISSING_ROLE',
      summary: 'At least one red-flag behavior fired or an expected role was missing.',
      evidence,
    };
  }
  if (autoAnswers <= 1) {
    return {
      score: 10,
      ruleId: 'B_CLEAN_LOW_INTERVENTION',
      summary: 'No red flags or missing roles were observed, with at most one intervention.',
      evidence,
    };
  }
  if (autoAnswers === 2) {
    return {
      score: 7.5,
      ruleId: 'B_TWO_INTERVENTIONS',
      summary:
        'No red flags or missing roles were observed; two interventions receive the midpoint between the fixed low/high-intervention anchors.',
      evidence,
    };
  }
  return {
    score: 5,
    ruleId: 'B_CLEAN_HIGH_INTERVENTION',
    summary:
      'No red flags or missing roles were observed, but the team needed at least three interventions.',
    evidence,
  };
}

function bandFor(composite: number): RubricBand {
  if (composite >= 8) return 'ship-ready';
  if (composite >= 5) return 'needs-tuning';
  return 'framework-gap';
}

export function scoreTrialFacts(
  facts: TrialFacts,
  result: TrialResultMetadata = {},
  profile: QualityProfile = qualityProfileForScenario(facts.scenarioId),
): FixedRubricScore {
  const completion = scoreCompletion(facts);
  const quality = scoreQuality(facts, profile);
  const efficiency = scoreEfficiency(facts);
  const behavior = scoreBehavior(facts);
  const composite = round1(
    0.4 * completion.score + 0.25 * quality.score + 0.2 * efficiency.score + 0.15 * behavior.score,
  );
  const failureClass = result.failureClass ?? (facts.outcome.success ? 'pass' : 'unclassified');
  const eligibilityEvidence = result.failureClass
    ? [resultEvidence('failureClass', result.failureClass)]
    : [factsEvidence('outcome.success', facts.outcome.success)];

  return {
    rubricVersion: FIXED_RUBRIC_VERSION,
    trialId: facts.trialId,
    scenarioId: facts.scenarioId,
    modelId: facts.modelId,
    eligibility: {
      failureClass,
      includedInModelAggregate: !NON_MODEL_FAILURE_CLASSES.has(failureClass),
      ...(result.failureClassRule ? { failureClassRule: result.failureClassRule } : {}),
      evidence: eligibilityEvidence,
    },
    qualityProfile: { ...profile },
    axes: { completion, quality, efficiency, behavior },
    composite,
    band: bandFor(composite),
  };
}

function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Fail loudly if a rendered citation no longer resolves to its scored value. */
export function validateScoreEvidence(
  score: FixedRubricScore,
  facts: TrialFacts,
  result: TrialResultMetadata,
): void {
  const refs = [
    ...score.eligibility.evidence,
    ...Object.values(score.axes).flatMap((axis) => axis.evidence),
  ];
  for (const ref of refs) {
    const root = ref.source === 'facts' ? facts : result;
    const observed = valueAtPath(root, ref.path);
    if (observed === undefined) {
      throw new Error(`rubric evidence path does not resolve: ${ref.source}.${ref.path}`);
    }
    if (JSON.stringify(observed) !== JSON.stringify(ref.value)) {
      throw new Error(`rubric evidence value drifted: ${ref.source}.${ref.path}`);
    }
  }
}
