import { describe, expect, it } from 'vitest';
import type { TrialFacts } from './bin/score-trial.ts';
import { scoreTrialFacts, validateScoreEvidence } from './fixed-rubric.ts';

interface FactsOptions {
  scenarioId?: string;
  success?: boolean;
  failureMode?: string;
  reason?: string;
  budget?: number;
  calls?: number;
  firstArtifactMs?: number | null;
  score?: number;
  scoreMax?: number | null;
  bytes?: number;
  failReason?: string | null;
  htmlBytes?: number[];
  imageBytes?: number[];
  redFlags?: TrialFacts['toolUse']['redFlags'];
  missingRoles?: string[];
  autoAnswers?: number;
}

function makeFacts(opts: FactsOptions = {}): TrialFacts {
  const success = opts.success ?? true;
  const latest =
    opts.score === undefined
      ? null
      : {
          filePath: 'workspace/output.txt',
          bytes: opts.bytes ?? 1_000,
          score: opts.score,
          scoreMax: opts.scoreMax ?? null,
          signals: [],
          failReason: opts.failReason ?? null,
        };
  const autoAnswers = opts.autoAnswers ?? 0;
  return {
    trialId: 'trial-1',
    scenarioId: opts.scenarioId ?? 'non-html-task',
    modelId: 'test-model',
    modelTier: 'medium',
    runDir: '/runs/trial-1',
    outcome: {
      success,
      ...(opts.failureMode ? { failureMode: opts.failureMode } : {}),
      reason: opts.reason ?? (success ? 'passed' : 'did not pass'),
      durationMs: 60_000,
      timeoutMs: 600_000,
      budgetUsedFraction: opts.budget ?? 0.1,
    },
    timing: {
      startedAt: '2026-07-10T00:00:00.000Z',
      finishedAt: '2026-07-10T00:01:00.000Z',
      timeToFirstArtifactMs: opts.firstArtifactMs === undefined ? 1_000 : opts.firstArtifactMs,
      timeToLastArtifactWriteMs: 2_000,
      timeToFirstTokenMs: 100,
      firstTurnTtftMs: 50,
      timeToFirstToolCallMs: 500,
    },
    team: {
      totalGezelsCreated: 3,
      rolesCreated: ['Meester', 'Developer'],
      missingExpectedRoles: opts.missingRoles ?? [],
    },
    toolUse: {
      totalToolCalls: opts.calls ?? 5,
      byTool: { writeFile: 1 },
      redFlags: opts.redFlags ?? [],
    },
    artifacts: {
      htmlFiles: (opts.htmlBytes ?? []).map((finalBytes, index) => ({
        path: `workspace/output-${index}.html`,
        finalBytes,
        growth: [],
      })),
      imageFiles: (opts.imageBytes ?? []).map((bytes, index) => ({
        path: `workspace/image-${index}.png`,
        bytes,
      })),
      otherFileCount: 1,
    },
    sniff: {
      progression: latest ? [{ atMs: 1_000, ...latest }] : [],
      latest,
    },
    autoAnswer: {
      total: autoAnswers,
      byKind: { structured: autoAnswers, inline: 0 },
      events: [],
    },
    miscEvents: [],
  };
}

describe('fixed eval-run rubric', () => {
  it('scores a clean successful trial at 10 and validates every citation', () => {
    const facts = makeFacts({ score: 5, scoreMax: 5 });
    const score = scoreTrialFacts(facts, { failureClass: 'pass' });

    expect(score.axes).toMatchObject({
      completion: { score: 10, ruleId: 'C_SUCCESS' },
      quality: { score: 10, ruleId: 'Q_GATE_COMPLETE' },
      efficiency: { score: 10 },
      behavior: { score: 10 },
    });
    expect(score.composite).toBe(10);
    expect(score.band).toBe('ship-ready');
    expect(() => validateScoreEvidence(score, facts, { failureClass: 'pass' })).not.toThrow();
  });

  it('gives watchdog partial credit at half of a measured gate', () => {
    const score = scoreTrialFacts(
      makeFacts({
        success: false,
        failureMode: 'timeout',
        score: 3,
        scoreMax: 6,
      }),
    );

    expect(score.axes.completion).toMatchObject({ score: 3, ruleId: 'C_WATCHDOG_PARTIAL' });
    expect(score.axes.quality).toMatchObject({ score: 5, ruleId: 'Q_GATE_RATIO' });
  });

  it('scores a terminal false verdict without a failureMode and validates its citations', () => {
    const facts = makeFacts({ success: false, score: 3, scoreMax: 5 });
    const score = scoreTrialFacts(facts);

    expect(score.axes.completion).toMatchObject({ score: 6, ruleId: 'C_DONE_FALSE' });
    expect(() => validateScoreEvidence(score, facts, {})).not.toThrow();
  });

  it('scores a critical parse or missing-script failure at zero for completion and quality', () => {
    const score = scoreTrialFacts(
      makeFacts({
        success: false,
        failureMode: 'timeout',
        reason: 'page has no inline <script> and does not parse',
        score: 4,
        scoreMax: 6,
      }),
    );

    expect(score.axes.completion).toMatchObject({ score: 0, ruleId: 'C_CRITICAL_OUTPUT' });
    expect(score.axes.quality).toMatchObject({ score: 0, ruleId: 'Q_CRITICAL_OUTPUT' });
  });

  it('keeps a crash diagnostic score but excludes an infra failure from model aggregates', () => {
    const score = scoreTrialFacts(
      makeFacts({
        success: false,
        failureMode: 'crash',
        firstArtifactMs: null,
      }),
      { failureClass: 'infra', failureClassRule: 'daemon-crash' },
    );

    expect(score.axes.completion.score).toBe(0);
    expect(score.eligibility).toMatchObject({
      failureClass: 'infra',
      includedInModelAggregate: false,
      failureClassRule: 'daemon-crash',
    });
  });

  it('uses conservative midpoint credit when scoreMax is unavailable', () => {
    const score = scoreTrialFacts(
      makeFacts({
        success: false,
        failureMode: 'model-stuck',
        score: 6,
        scoreMax: null,
      }),
    );

    expect(score.axes.completion).toMatchObject({ score: 3, ruleId: 'C_WATCHDOG_PARTIAL' });
    expect(score.axes.quality).toMatchObject({
      score: 5,
      ruleId: 'Q_PARTIAL_UNKNOWN_MAX',
    });
  });

  it('caps successful game HTML below 4 KB at quality 5', () => {
    const score = scoreTrialFacts(
      makeFacts({
        scenarioId: 'tictactoe',
        score: 6,
        scoreMax: null,
        bytes: 3_900,
        htmlBytes: [3_900],
      }),
    );

    expect(score.axes.quality.score).toBe(5);
    expect(score.axes.quality.adjustments).toContainEqual(
      expect.objectContaining({ ruleId: 'Q_HTML_REALISM_CAP' }),
    );
  });

  it('scales a required raster image below 50 KB and prevents full quality credit', () => {
    const score = scoreTrialFacts(
      makeFacts({
        scenarioId: 'petshop',
        score: 5,
        scoreMax: null,
        imageBytes: [25 * 1024],
      }),
    );

    expect(score.axes.quality.score).toBe(5);
    expect(score.axes.quality.adjustments).toContainEqual(
      expect.objectContaining({ ruleId: 'Q_RASTER_REALISM_CAP' }),
    );
  });

  it('implements every efficiency precedence band exactly', () => {
    expect(scoreTrialFacts(makeFacts({ budget: 0.5, calls: 10 })).axes.efficiency.score).toBe(10);
    expect(scoreTrialFacts(makeFacts({ budget: 0.5, calls: 11 })).axes.efficiency.score).toBe(7.5);
    expect(scoreTrialFacts(makeFacts({ budget: 0.7, calls: 10 })).axes.efficiency.score).toBe(7.5);
    expect(scoreTrialFacts(makeFacts({ budget: 0.5, calls: 20 })).axes.efficiency.score).toBe(5);
    expect(scoreTrialFacts(makeFacts({ budget: 0.7, calls: 11 })).axes.efficiency.score).toBe(5);
    expect(scoreTrialFacts(makeFacts({ budget: 1, calls: 10 })).axes.efficiency.score).toBe(2.5);
    expect(scoreTrialFacts(makeFacts({ budget: 0.5, calls: 30 })).axes.efficiency.score).toBe(2.5);
    expect(scoreTrialFacts(makeFacts({ budget: 1, calls: 30 })).axes.efficiency.score).toBe(0);
  });

  it('scores red flags, missing roles, and exactly two interventions deterministically', () => {
    const redFlag: TrialFacts['toolUse']['redFlags'][number] = {
      gezel: 'Builder',
      tool: 'npm_install',
      argsSummary: 'sharp',
      atTurn: 2,
      pattern: 'image-pkg-install-instead-of-tool',
      explanation: 'Used a package instead of the image tool.',
    };
    expect(scoreTrialFacts(makeFacts({ redFlags: [redFlag] })).axes.behavior.score).toBe(0);
    expect(
      scoreTrialFacts(makeFacts({ missingRoles: ['image-generator'] })).axes.behavior.score,
    ).toBe(0);
    expect(scoreTrialFacts(makeFacts({ autoAnswers: 2 })).axes.behavior).toMatchObject({
      score: 7.5,
      ruleId: 'B_TWO_INTERVENTIONS',
    });
  });
});
