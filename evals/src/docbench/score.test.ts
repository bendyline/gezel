import type { BenchCaseOutcome, BenchPackManifest } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import {
  type CaseJudgement,
  assignBands,
  caseScore,
  checkScore,
  matchScore,
  outcomeKey,
  scoreModel,
} from './score.ts';

const matcher = {
  rubricId: 'review-matcher@1',
  mode: 'matcher' as const,
  matchWeight: 0.8,
  instructions: 'match',
  axes: [{ id: 'helpfulness', label: 'Helpfulness', description: 'helps' }],
};

const rubric = {
  rubricId: 'illustration-vision@1',
  mode: 'rubric' as const,
  instructions: 'judge',
  axes: [
    { id: 'subject', label: 'Subject', description: 'shows it' },
    { id: 'legibility', label: 'Legible', description: 'reads' },
  ],
};

const manifest: BenchPackManifest = {
  schemaVersion: 1,
  id: 'docbench',
  version: '0.1.0',
  families: [
    { id: 'review', label: 'Review', weight: 0.5 },
    { id: 'visuals', label: 'Visuals', weight: 0.3 },
    { id: 'study', label: 'Study', weight: 0.2 },
  ],
  tasks: [
    {
      id: 'review-resume',
      family: 'review',
      label: 'Resume',
      description: '',
      trials: 1,
      scoring: { checks: 0.2, judge: 0.8 },
      judge: matcher,
      cases: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
    },
    {
      id: 'illustration-svg',
      family: 'visuals',
      label: 'SVG',
      description: '',
      trials: 2,
      scoring: { checks: 0.5, judge: 0.5 },
      judge: rubric,
      cases: [{ id: 'c', label: 'c' }],
    },
  ],
};

function outcome(overrides: Partial<BenchCaseOutcome>): BenchCaseOutcome {
  return {
    schemaVersion: 1,
    packVersion: '0.1.0',
    taskId: 'review-resume',
    caseId: 'a',
    trial: 0,
    seed: 1,
    model: 'llama-cpp:m',
    contextWindow: 32768,
    usable: true,
    checks: [{ id: 'ok', label: 'ok', score: 1, weight: 1 }],
    artifact: null,
    judgeInput: null,
    calls: [{ promptTokens: 10, completionTokens: 100, finishReason: 'stop', ms: 5 }],
    error: null,
    notes: [],
    ms: 5,
    ...overrides,
  };
}

function verdict(overrides: Partial<CaseJudgement>): CaseJudgement {
  return {
    rubricId: 'r',
    promptVersion: 1,
    judgeModel: 'claude-opus-5-5',
    official: true,
    axes: {},
    reasons: '',
    ...overrides,
  };
}

describe('matchScore', () => {
  it('takes F1 over the answer key, counting trivial and wrong findings against precision', () => {
    const perfect = matchScore({ found: 4, keyTotal: 4, valid: 4, trivial: 0, wrong: 0 });
    expect(perfect.f1).toBe(1);
    const padded = matchScore({ found: 2, keyTotal: 4, valid: 2, trivial: 2, wrong: 0 });
    expect(padded.recall).toBe(0.5);
    expect(padded.precision).toBe(0.5);
    expect(padded.f1).toBeCloseTo(0.5);
  });

  it('gives a review of "This is a correct sentence" nothing', () => {
    const useless = matchScore({ found: 0, keyTotal: 9, valid: 0, trivial: 6, wrong: 0 });
    expect(useless.score).toBe(0);
    const silent = matchScore({ found: 0, keyTotal: 9, valid: 0, trivial: 0, wrong: 0 });
    expect(silent.score).toBe(0);
  });

  it('weights recall by complexity when the key has levels', () => {
    const levels = {
      low: { keyTotal: 3, found: 3, valid: 3 },
      medium: { keyTotal: 3, found: 0, valid: 0 },
      high: { keyTotal: 2, found: 0, valid: 0 },
    };
    // Every typo found, nothing deeper: 3 of a weighted 3 + 6 + 6 = 15.
    const shallow = matchScore({ found: 3, keyTotal: 8, valid: 3, trivial: 0, wrong: 0, levels });
    expect(shallow.recall).toBeCloseTo(3 / 15);
    const deep = matchScore({
      found: 2,
      keyTotal: 8,
      valid: 2,
      trivial: 0,
      wrong: 0,
      levels: {
        ...levels,
        low: { keyTotal: 3, found: 0, valid: 0 },
        high: { keyTotal: 2, found: 2, valid: 2 },
      },
    });
    // Two buried-point issues found: 6 of 15, more than three typos.
    expect(deep.recall).toBeCloseTo(6 / 15);
    expect(deep.f1).toBeGreaterThan(shallow.f1);
  });

  it('scores a decoy by the false alarms it raised', () => {
    expect(matchScore({ found: 0, keyTotal: 0, valid: 0, trivial: 0, wrong: 0 }).score).toBe(1);
    expect(matchScore({ found: 0, keyTotal: 0, valid: 1, trivial: 1, wrong: 0 }).score).toBeCloseTo(
      2 / 3,
    );
    expect(matchScore({ found: 0, keyTotal: 0, valid: 0, trivial: 2, wrong: 5 }).score).toBe(0);
  });
});

describe('caseScore', () => {
  const task = manifest.tasks[0]!;

  it('scores an unusable case zero, final with or without a verdict', () => {
    expect(caseScore(outcome({ usable: false }), task, null)).toEqual({ score: 0, judged: true });
  });

  it('blends checks with the matcher verdict by the task weights', () => {
    const scored = caseScore(
      outcome({
        checks: [
          { id: 'a', label: 'a', score: 1, weight: 1 },
          { id: 'b', label: 'b', score: 0, weight: 1 },
        ],
      }),
      task,
      verdict({
        axes: { helpfulness: 5 },
        match: { found: 4, keyTotal: 4, valid: 4, trivial: 0, wrong: 0 },
      }),
    );
    // checks 0.5; judge 0.8·1 + 0.2·0.5 = 0.9; case 0.2·0.5 + 0.8·0.9 = 0.82
    expect(scored.judged).toBe(true);
    expect(scored.score).toBeCloseTo(0.82);
  });

  it('falls back to the checks, flagged unjudged, when the verdict is missing or failed', () => {
    expect(caseScore(outcome({}), task, null)).toEqual({ score: 1, judged: false });
    expect(caseScore(outcome({}), task, verdict({ error: 'timeout' }))).toEqual({
      score: 1,
      judged: false,
    });
  });

  it('weights checks by their weight', () => {
    expect(
      checkScore({
        checks: [
          { id: 'a', label: 'a', score: 1, weight: 3 },
          { id: 'b', label: 'b', score: 0, weight: 1 },
        ],
      }),
    ).toBe(0.75);
    expect(checkScore({ checks: [] })).toBe(1);
  });
});

describe('scoreModel', () => {
  const svg = (caseId: string, trial: number, usable: boolean) =>
    outcome({ taskId: 'illustration-svg', caseId, trial, usable });

  it('weights the families present, reports coverage, and excludes infrastructure failures', () => {
    const outcomes = [
      outcome({ caseId: 'a' }),
      outcome({ caseId: 'b', usable: false }),
      svg('c', 0, true),
      svg('c', 1, true),
      outcome({
        taskId: 'illustration-svg',
        caseId: 'c',
        trial: 2,
        usable: false,
        error: { class: 'infra', message: 'HTTP 503' },
      }),
    ];
    const judgements = new Map<string, CaseJudgement>([
      [
        outcomeKey({ taskId: 'review-resume', caseId: 'a', trial: 0 }),
        verdict({
          axes: { helpfulness: 10 },
          match: { found: 9, keyTotal: 9, valid: 9, trivial: 0, wrong: 0 },
        }),
      ],
      [
        outcomeKey({ taskId: 'illustration-svg', caseId: 'c', trial: 0 }),
        verdict({ axes: { subject: 6, legibility: 4 } }),
      ],
      [
        outcomeKey({ taskId: 'illustration-svg', caseId: 'c', trial: 1 }),
        verdict({ axes: { subject: 8, legibility: 6 } }),
      ],
    ]);
    const result = scoreModel(manifest, outcomes, judgements, { iterations: 200 });
    // review: case a = 1, case b = 0 → 0.5; visuals: trials 0.75 and 0.85 → 0.8
    expect(result.tasks['review-resume']?.score).toBeCloseTo(0.5);
    expect(result.tasks['illustration-svg']?.score).toBeCloseTo(0.8);
    expect(result.tasks['illustration-svg']?.infraFailures).toBe(1);
    expect(result.tasks['illustration-svg']?.trials).toBe(2);
    // (0.5·0.5 + 0.3·0.8) / 0.8 · 100
    expect(result.docbench).toBeCloseTo(61.25);
    expect(result.coverage).toBeCloseTo(0.8);
    expect(result.missingFamilies).toEqual(['study']);
    expect(result.usableRate).toBeCloseTo(3 / 4);
    expect(result.judgedShare).toBe(1);
    expect(result.ci[0]).toBeLessThanOrEqual(result.docbench);
    expect(result.ci[1]).toBeGreaterThanOrEqual(result.docbench);
    expect(result.tasks['review-resume']?.medianOutputTokens).toBe(100);
  });

  it('profiles a review task by complexity from its matcher verdicts', () => {
    const levels = (low: number, medium: number, high: number) => ({
      low: { keyTotal: 2, found: low, valid: low },
      medium: { keyTotal: 2, found: medium, valid: medium },
      high: { keyTotal: 1, found: high, valid: high },
    });
    const judgements = new Map<string, CaseJudgement>([
      [
        outcomeKey({ taskId: 'review-resume', caseId: 'a', trial: 0 }),
        verdict({
          axes: { helpfulness: 6 },
          match: { found: 3, keyTotal: 5, valid: 3, trivial: 1, wrong: 0, levels: levels(2, 1, 0) },
        }),
      ],
      [
        outcomeKey({ taskId: 'review-resume', caseId: 'b', trial: 0 }),
        verdict({
          axes: { helpfulness: 8 },
          match: { found: 3, keyTotal: 5, valid: 3, trivial: 0, wrong: 1, levels: levels(0, 2, 1) },
        }),
      ],
    ]);
    const result = scoreModel(
      manifest,
      [outcome({ caseId: 'a' }), outcome({ caseId: 'b' })],
      judgements,
      { iterations: 50 },
    );
    expect(result.tasks['review-resume']?.findings).toEqual({
      outputs: 2,
      perOutput: { low: 1, medium: 1.5, high: 0.5, trivial: 0.5, wrong: 0.5 },
      recallByLevel: { low: 0.5, medium: 0.75, high: 0.5 },
      precision: 6 / 8,
    });
  });

  it('weights tasks within a family by the weight the pack gives them', () => {
    const weighted: BenchPackManifest = {
      ...manifest,
      tasks: [
        { ...manifest.tasks[0]!, weight: 3 },
        { ...manifest.tasks[0]!, id: 'review-other', cases: [{ id: 'z', label: 'z' }] },
      ],
    };
    const result = scoreModel(
      weighted,
      [outcome({ caseId: 'a' }), outcome({ taskId: 'review-other', caseId: 'z', usable: false })],
      new Map(),
      { iterations: 50 },
    );
    // (3 · 1 + 1 · 0) / 4
    expect(result.families.review?.score).toBeCloseTo(0.75);
  });

  it('is reproducible: the same seed gives the same interval', () => {
    const outcomes = [outcome({ caseId: 'a' }), outcome({ caseId: 'b', usable: false })];
    const first = scoreModel(manifest, outcomes, new Map(), { iterations: 300, seed: 7 });
    const second = scoreModel(manifest, outcomes, new Map(), { iterations: 300, seed: 7 });
    expect(first.ci).toEqual(second.ci);
    expect(first.judgedShare).toBe(0.5);
  });
});

describe('assignBands', () => {
  it('keeps overlapping models in one band and starts a new one below it', () => {
    const bands = assignBands([
      { id: 'big', score: 80, ci: [74, 86] },
      { id: 'mid', score: 76, ci: [70, 82] },
      { id: 'small', score: 50, ci: [44, 56] },
      { id: 'tiny', score: 46, ci: [40, 52] },
      { id: 'broken', score: 5, ci: [1, 9] },
    ]);
    expect(Object.fromEntries(bands)).toEqual({ big: 1, mid: 1, small: 2, tiny: 2, broken: 3 });
  });
});
