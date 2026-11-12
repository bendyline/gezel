import { ScorecardDatasetSchema } from '@bendyline/gezel';
import type { BenchPackManifest } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import {
  docbenchPublication,
  docbenchScorecardRunId,
  publishRefusals,
  rerunRefusals,
  withDocbenchBenchmark,
} from './publish.ts';
import type { DocbenchSummary, ModelSummary } from './report.ts';

const manifest = {
  schemaVersion: 1,
  id: 'docbench',
  version: '0.2.1',
  families: [
    { id: 'review', label: 'Review', weight: 0.5 },
    { id: 'writing', label: 'Writing', weight: 0.5 },
  ],
  tasks: [
    { id: 'review-general', family: 'review', label: 'General review', trials: 1 },
    { id: 'write-compose', family: 'writing', label: 'Compose', trials: 3 },
  ],
} as unknown as BenchPackManifest;

function model(id: string, docbench: number, band: number): ModelSummary {
  return {
    modelId: id,
    docbench,
    ci: [docbench - 2, docbench + 2],
    band,
    coverage: 1,
    missingFamilies: [],
    usableRate: 0.95,
    judgedShare: 1,
    families: {
      review: { score: 0.712345, ci: [0.68, 0.75], tasks: ['review-general'] },
      writing: { score: 0.9, ci: [0.85, 0.93], tasks: ['write-compose'] },
    },
    tasks: {
      'review-general': {
        score: 0.712345,
        ci: [0.68, 0.75],
        usableRate: 1,
        cases: 4,
        trials: 4,
        infraFailures: 0,
        judgedShare: 1,
        medianOutputTokens: 900,
        findings: {
          outputs: 4,
          perOutput: { low: 3.5, medium: 1.25, high: 0.25, trivial: 0.5, wrong: 0 },
          recallByLevel: { low: 0.8, medium: 0.5, high: 0.1 },
          precision: 0.9,
        },
      },
      'write-compose': {
        score: 0.9,
        ci: [0.85, 0.93],
        usableRate: 0.9,
        cases: 5,
        trials: 10,
        infraFailures: 1,
        judgedShare: 1,
        medianOutputTokens: 600,
      },
    },
    generation: { seconds: 100, outcomes: 14, infraRetried: 1, catalogVersion: '1.0.2' },
  };
}

function summary(overrides: Partial<DocbenchSummary> = {}): DocbenchSummary {
  return {
    schemaVersion: 1,
    runId: 'sweep-0.2.1',
    createdAt: '2026-11-11T02:59:20.255Z',
    pack: { id: 'docbench', version: '0.2.1', fixtures: { id: 'public', sha256: 'a'.repeat(64) } },
    judge: { model: 'claude-opus-5-5', promptVersion: 2, official: true },
    validity: { pass: true, model: 'gemma4-12b-q4', retestSd: 0.2, alpha: 0.8, defectsCaught: 0.9 },
    now: '2026-11-10T12:00:00.000Z',
    launchContext: 32768,
    device: {
      label: 'Test rig',
      platform: 'win32',
      arch: 'arm64',
      memoryGb: 32,
      osRelease: 'win32 10',
    },
    harnessCommit: 'abc1234',
    publishable: true,
    models: [model('big-q4', 80.71, 1), model('small-q4', 43.2, 2)],
    ...overrides,
  };
}

const facts = (modelId: string) =>
  modelId === 'missing'
    ? undefined
    : { label: modelId.toUpperCase(), tier: 'small', parameterSize: '4B', catalogVersion: '9.9.9' };

describe('docbench publication', () => {
  it('builds a scorecard shard the dataset schema accepts', () => {
    const { shard, benchmarks, warnings } = docbenchPublication({
      summary: summary(),
      manifest,
      engine: 'llama-cpp',
      gildeVersion: '0.3.8',
      facts,
    });
    expect(() => ScorecardDatasetSchema.parse(shard)).not.toThrow();
    expect(shard.runs[0]?.id).toBe('docbench-sweep-0.2.1');
    expect(shard.runs[0]?.suites).toEqual(['docbench']);
    const big = shard.results.find((result) => result.modelId === 'big-q4');
    expect(big?.docbench?.score).toBe(80.7);
    expect(big?.docbench?.families.review).toEqual({ score: 71.2, ci: [68, 75] });
    expect(big?.docbench?.tasks['review-general']?.findings).toEqual({
      low: 3.5,
      medium: 1.25,
      high: 0.25,
      trivial: 0.5,
      wrong: 0,
    });
    // Usable replies per task, with infrastructure failures set aside.
    expect(big?.cells).toEqual([
      { scenarioId: 'review-general', trials: 4, successes: 4, nonModelFailures: 0 },
      { scenarioId: 'write-compose', trials: 11, successes: 9, nonModelFailures: 1 },
    ]);
    expect(benchmarks.get('small-q4')).toMatchObject({
      version: '0.2.1',
      score: 43.2,
      band: 2,
      catalogVersion: '1.0.2',
      families: { review: 71.2, writing: 90 },
      runId: 'docbench-sweep-0.2.1',
      judge: 'claude-opus-5-5',
    });
    expect(warnings).toEqual([]);
  });

  it('stamps the catalog version generation recorded, warning when it falls back', () => {
    const fallback = summary({
      models: [{ ...model('big-q4', 80, 1), generation: null }],
    });
    const { benchmarks, warnings } = docbenchPublication({
      summary: fallback,
      manifest,
      engine: 'llama-cpp',
      gildeVersion: '0.3.8',
      facts,
    });
    expect(benchmarks.get('big-q4')?.catalogVersion).toBe('9.9.9');
    expect(warnings[0]).toMatch(/did not record its catalog version/);
  });

  it('refuses rounds that are not publishable, saying why', () => {
    expect(publishRefusals(summary())).toEqual([]);
    const unofficial = summary({
      judge: { model: 'local:qwen3.8-27b-q4', promptVersion: 2, official: false },
      validity: null,
      models: [{ ...model('big-q4', 80, 1), judgedShare: 0.5 }],
    });
    const reasons = publishRefusals(unofficial);
    expect(reasons.join('\n')).toMatch(/not the official judge/);
    expect(reasons.join('\n')).toMatch(/no judge validity study/);
    expect(reasons.join('\n')).toMatch(/big-q4 has unjudged cases \(50% judged\)/);
    expect(() =>
      docbenchPublication({
        summary: unofficial,
        manifest,
        engine: 'llama-cpp',
        gildeVersion: '0.3.8',
        facts,
      }),
    ).toThrow(/not publishable/);
  });

  it('refuses a model the catalog does not know', () => {
    expect(() =>
      docbenchPublication({
        summary: summary({ models: [model('missing', 50, 1)] }),
        manifest,
        engine: 'llama-cpp',
        gildeVersion: '0.3.8',
        facts,
      }),
    ).toThrow(/not in the chat-model catalog/);
  });

  it('names rounds without doubling the prefix', () => {
    expect(docbenchScorecardRunId({ runId: 'docbench-x' })).toBe('docbench-x');
    expect(docbenchScorecardRunId({ runId: 'x' })).toBe('docbench-x');
  });
});

describe('a focused re-run', () => {
  // The published round: big-q4 at 80.7 (band 1), small-q4 at 43.2 (band 2).
  const against = summary();
  // After a fix, small-q4 and an unchanged anchor are measured again.
  const rerunRound = summary({
    runId: 'fixes-0.2.2',
    pack: { id: 'docbench', version: '0.2.2', fixtures: { id: 'public', sha256: 'a'.repeat(64) } },
    models: [
      { ...model('small-q4', 79, 1), ci: [77, 81] },
      { ...model('anchor-q4', 70, 1), ci: [68, 72] },
    ],
  });
  const publish = (round: DocbenchSummary, models: string[]) =>
    docbenchPublication({
      summary: round,
      manifest,
      engine: 'llama-cpp',
      gildeVersion: '0.3.8',
      facts,
      rerun: { models, against },
    });

  it('publishes only the named models, as a subset beside the headline round', () => {
    const { shard, benchmarks } = publish(rerunRound, ['small-q4']);
    expect(() => ScorecardDatasetSchema.parse(shard)).not.toThrow();
    expect(shard.runs[0]).toMatchObject({ id: 'docbench-fixes-0.2.2', scope: 'subset' });
    expect(shard.runs[0]?.note).toContain('Focused re-run of small-q4 beside docbench-sweep-0.2.1');
    expect(shard.results.map((result) => result.modelId)).toEqual(['small-q4']);
    expect([...benchmarks.keys()]).toEqual(['small-q4']);
    expect(benchmarks.get('small-q4')).toMatchObject({ score: 79, runId: 'docbench-fixes-0.2.2' });
  });

  it('bands each model within the published field, not within its own small round', () => {
    // Its 77–81 overlaps big-q4's 78.7–82.7, so it joins band 1 of the
    // published field; alone with the anchor it would be band 1 regardless.
    const { benchmarks, shard } = publish(rerunRound, ['small-q4']);
    expect(benchmarks.get('small-q4')?.band).toBe(1);
    expect(shard.results[0]?.docbench?.band).toBe(1);
    const weaker = summary({
      ...rerunRound,
      models: [{ ...model('small-q4', 60, 1), ci: [58, 62] }],
    });
    expect(publish(weaker, ['small-q4']).benchmarks.get('small-q4')?.band).toBe(2);
  });

  it('refuses a re-run that would not compare with the published round', () => {
    expect(rerunRefusals(rerunRound, against, ['small-q4'])).toEqual([]);
    const otherJudge = summary({
      ...rerunRound,
      judge: { model: 'claude-opus-5-5', promptVersion: 3, official: true },
    });
    expect(rerunRefusals(otherJudge, against, ['small-q4']).join('\n')).toMatch(/judge differs/);
    const otherDate = summary({ ...rerunRound, now: '2026-12-01T00:00:00.000Z' });
    expect(rerunRefusals(otherDate, against, ['small-q4']).join('\n')).toMatch(/prompt date/);
    const nextLine = summary({
      ...rerunRound,
      pack: { ...rerunRound.pack, version: '0.3.0' },
    });
    expect(rerunRefusals(nextLine, against, ['small-q4']).join('\n')).toMatch(/pack line/);
    expect(rerunRefusals(rerunRound, against, ['anchor-q4']).join('\n')).toMatch(
      /anchor-q4 is not in the published round/,
    );
    expect(() => publish(otherJudge, ['small-q4'])).toThrow(/cannot stand beside/);
  });
});

describe('withDocbenchBenchmark', () => {
  const score = {
    version: '0.2.1',
    score: 70,
    ci: [68, 72] as [number, number],
    band: 1,
    families: { review: 60 },
    usableRate: 1,
    catalogVersion: '1.0.0',
    runId: 'docbench-r',
    measuredAt: '2026-11-11T00:00:00Z',
    judge: 'claude-opus-5-5',
  };

  it('places a new block before the provider blocks, where Gilde assembly puts it', () => {
    const out = withDocbenchBenchmark(
      { id: 'm', tuning: {}, yankedVersions: ['1.0.0'], llamaCpp: {} },
      'llama-cpp',
      score,
    );
    expect(Object.keys(out)).toEqual(['id', 'tuning', 'benchmarks', 'yankedVersions', 'llamaCpp']);
    expect(out.benchmarks).toEqual({ docbench: { 'llama-cpp': score } });
  });

  it('replaces only this engine, keeping the others', () => {
    const mlx = { ...score, score: 50 };
    const out = withDocbenchBenchmark(
      { id: 'm', benchmarks: { docbench: { mlx, 'llama-cpp': { ...score, score: 10 } } } },
      'llama-cpp',
      score,
    );
    expect(out.benchmarks).toEqual({ docbench: { mlx, 'llama-cpp': score } });
  });
});
