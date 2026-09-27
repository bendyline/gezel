import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';
import {
  buildSuiteScoreboard,
  describeProvenance,
  formatPassClaim,
  hardwareSummary,
  provenanceDifferences,
  scoreModel,
  scorecardMemoryCoverage,
} from './report.js';
import { type ScorecardDataset, ScorecardDatasetSchema, ScorecardRunSchema } from './schema.js';

function run(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    provenance: {
      startedAt: `2026-08-0${id.at(-1)}T00:00:00.000Z`,
      device: { label: 'Mac Studio (M4 Max)', platform: 'darwin', arch: 'arm64', memoryGb: 64 },
      harnessCommit: 'abc1234',
      gildeVersion: '0.1.15',
      count: 3,
      judgeModelId: 'claude-sonnet-4-6',
      ...(over.provenance as object),
    },
    suites: ['core'],
    scenariosBySuite: { core: ['tictactoe', 'petshop'] },
  };
}

function result(modelId: string, runId: string, cells: Array<[string, number, number, number]>) {
  return {
    modelId,
    label: modelId,
    engine: 'llama-cpp',
    tier: 'medium',
    runId,
    suiteId: 'core',
    cells: cells.map(([scenarioId, trials, successes, nonModelFailures]) => ({
      scenarioId,
      trials,
      successes,
      nonModelFailures,
    })),
  };
}

describe('formatPassClaim', () => {
  it('refuses to quote a rate below the minimum sample', () => {
    expect(formatPassClaim(1, 1)).toBe('1/1 (n<3, count not rate)');
    expect(formatPassClaim(2, 2)).toBe('2/2 (n<3, count not rate)');
  });

  it('quotes a rate once the sample supports it', () => {
    expect(formatPassClaim(3, 3)).toBe('3/3 (100%)');
    expect(formatPassClaim(4, 6)).toBe('4/6 (67%)');
  });

  it('says so plainly when nothing was measured', () => {
    expect(formatPassClaim(0, 0)).toBe('not measured');
  });
});

describe('scoreModel', () => {
  it('excludes non-model failures from the denominator', () => {
    // 6 trials, 3 passed, 2 died to a wedged engine. The model was on trial
    // 4 times and passed 3 — publishing 3/6 would blame it for the engine.
    const score = scoreModel(result('m', 'r1', [['tictactoe', 6, 3, 2]]));
    expect(score.attributableTrials).toBe(4);
    expect(score.discardedTrials).toBe(2);
    expect(score.claim).toBe('3/4 (75%)');
  });

  it('flags a scenario that measured nothing rather than scoring it zero', () => {
    const score = scoreModel(
      result('m', 'r1', [
        ['tictactoe', 3, 3, 0],
        ['petshop', 3, 0, 3],
      ]),
    );
    expect(score.unmeasuredScenarios).toEqual(['petshop']);
    expect(score.claim).toBe('3/3 (100%)');
  });

  it('has no rate at all when every trial was discarded', () => {
    const score = scoreModel(result('m', 'r1', [['tictactoe', 3, 0, 3]]));
    expect(score.passRate).toBeNull();
    expect(score.claim).toBe('not measured');
  });
});

describe('sample-size discipline across scenarios', () => {
  it('refuses a rate when each task was run only once', () => {
    // Three different tasks run once each is three samples of one, not a
    // sample of three: nothing here shows whether any result reproduces.
    const score = scoreModel(
      result('m', 'r1', [
        ['tictactoe', 1, 1, 0],
        ['petshop', 1, 1, 0],
        ['tankcombat', 1, 0, 0],
      ]),
      1,
    );
    expect(score.passRate).toBeNull();
    expect(score.claim).toBe('2/3 (some tasks run once — count not rate)');
  });

  it('quotes a rate once every task has been repeated', () => {
    const score = scoreModel(
      result('m', 'r1', [
        ['tictactoe', 3, 3, 0],
        ['petshop', 3, 1, 0],
      ]),
      3,
    );
    expect(score.claim).toBe('4/6 (67%)');
  });
});

describe('per-scenario repeat gating', () => {
  it('refuses a rate when ANY task ran once, however large the aggregate', () => {
    // Wild-caught on the first real sweep: `--count 3` silently ran ONE
    // trial for every craftbook scenario (suggestedTrials caps it), so six
    // of thirteen productivity tasks were unrepeated while the requested
    // count still said 3. Trusting the requested count would have printed
    // a confident percentage over a half-unrepeated suite.
    const score = scoreModel(
      result('m', 'r1', [
        ['repeated-a', 3, 3, 0],
        ['repeated-b', 3, 2, 0],
        ['craftbook-once', 1, 1, 0],
      ]),
      3,
    );
    expect(score.passRate).toBeNull();
    expect(score.weakestCellTrials).toBe(1);
    expect(score.underRepeatedScenarios).toEqual(['craftbook-once']);
    expect(score.claim).toBe('6/7 (some tasks run once — count not rate)');
  });

  it('quotes a rate only when every task cleared the threshold', () => {
    const score = scoreModel(
      result('m', 'r1', [
        ['a', 3, 3, 0],
        ['b', 3, 1, 0],
      ]),
      3,
    );
    expect(score.weakestCellTrials).toBe(3);
    expect(score.claim).toBe('4/6 (67%)');
  });
});

describe('buildSuiteScoreboard', () => {
  const dataset: ScorecardDataset = ScorecardDatasetSchema.parse({
    schemaVersion: 1,
    runs: [run('r2'), run('r1')],
    results: [
      result('fast', 'r2', [
        ['tictactoe', 3, 3, 0],
        ['petshop', 3, 2, 0],
      ]),
      result('slow', 'r2', [
        ['tictactoe', 3, 1, 0],
        ['petshop', 3, 0, 0],
      ]),
      result('older', 'r1', [
        ['tictactoe', 3, 3, 0],
        ['petshop', 3, 3, 0],
      ]),
    ],
  });

  it('uses the newest run covering the suite as the headline', () => {
    const board = buildSuiteScoreboard(dataset, 'core');
    expect(board?.run.id).toBe('r2');
    expect(board?.scores.map((s) => s.result.modelId)).toEqual(['fast', 'slow']);
  });

  it('never merges a model measured under different provenance', () => {
    // `older` scored a perfect 6/6 but in an earlier sweep. Merging it into
    // the headline table would put it top of a leaderboard it never ran in.
    const board = buildSuiteScoreboard(dataset, 'core');
    expect(board?.scores.some((s) => s.result.modelId === 'older')).toBe(false);
    expect(board?.otherRunScores.map((s) => s.result.modelId)).toEqual(['older']);
  });

  it('pins the scenario list from the run, not the live registry', () => {
    expect(buildSuiteScoreboard(dataset, 'core')?.scenarioIds).toEqual(['tictactoe', 'petshop']);
  });

  it('returns null for a suite nothing has covered', () => {
    expect(buildSuiteScoreboard(dataset, 'productivity')).toBeNull();
  });
});

describe('provenance', () => {
  it('stamps a table with device, sample size, date, and code versions', () => {
    expect(describeProvenance(run('r1'))).toBe(
      'Mac Studio (M4 Max) · 64 GB · 3 trials per task · 2026-08-01 · gezel abc1234 · catalog 0.1.15',
    );
  });

  it('names why two runs are not comparable', () => {
    const other = run('r2', { provenance: { harnessCommit: 'def5678', count: 1 } });
    expect(provenanceDifferences(run('r1'), other)).toEqual([
      'different gezel build',
      'different trial count',
    ]);
  });

  it('identifies an unknown high-memory Linux arm64 host as DGX Spark class', () => {
    expect(
      hardwareSummary({
        label: 'linux · unknown',
        platform: 'linux',
        arch: 'arm64',
        memoryGb: 122,
        cpuModel: 'unknown',
      }),
    ).toBe('DGX Spark Class · 122 GB');
  });

  it('does not apply the DGX Spark class below the high-memory threshold', () => {
    expect(
      hardwareSummary({
        label: 'linux · unknown',
        platform: 'linux',
        arch: 'arm64',
        memoryGb: 100,
        cpuModel: 'unknown',
      }),
    ).toBe('linux · unknown · 100 GB');
  });
});

describe('scorecardMemoryCoverage', () => {
  const runOn = (device: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ScorecardRunSchema.parse({
      ...run('r1'),
      provenance: {
        ...run('r1').provenance,
        device: { label: 'x', platform: 'linux', arch: 'x64', ...device },
      },
      ...extra,
    });
  const coverageOf = (device: Record<string, unknown>) => scorecardMemoryCoverage(runOn(device));

  it('trusts Apple Silicon, where Metal buffers count against the process', () => {
    expect(
      coverageOf({ platform: 'darwin', arch: 'arm64', gpuModel: 'Apple M2 (integrated GPU)' }),
    ).toBe('full');
  });

  it('hides DGX Spark rounds, including the first one recorded without a GPU name', () => {
    expect(coverageOf({ label: 'DGX Spark Class', arch: 'arm64', gpuModel: 'NVIDIA GB10' })).toBe(
      'incomplete',
    );
    expect(
      coverageOf({ label: 'linux · unknown', arch: 'arm64', memoryGb: 122, cpuModel: 'unknown' }),
    ).toBe('incomplete');
  });

  it('marks a discrete graphics card as system memory only', () => {
    expect(coverageOf({ platform: 'win32', gpuModel: 'AMD Radeon AI PRO R9700' })).toBe(
      'system-only',
    );
    expect(
      coverageOf({ platform: 'win32', gpuModel: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' }),
    ).toBe('system-only');
  });

  it('treats PC integrated graphics as shared memory the probe cannot see', () => {
    expect(coverageOf({ platform: 'win32', gpuModel: 'AMD Radeon 8060S Graphics' })).toBe(
      'incomplete',
    );
  });

  it('counts a machine with no graphics card as the whole footprint', () => {
    expect(coverageOf({})).toBe('full');
  });

  it('lets an explicit value on the run win over the derivation', () => {
    const explicit = runOn(
      { platform: 'win32', gpuModel: 'AMD Radeon AI PRO R9700' },
      { memoryCoverage: 'full' },
    );
    expect(scorecardMemoryCoverage(explicit)).toBe('full');
  });

  it('classifies every checked-in round the way its numbers demand', () => {
    for (const entry of SCORECARD.runs) {
      const { device } = entry.provenance;
      const coverage = scorecardMemoryCoverage(entry);
      if (device.platform === 'darwin') expect(coverage, entry.id).toBe('full');
      else if (device.platform === 'linux' && device.arch === 'arm64') {
        expect(coverage, entry.id).toBe('incomplete');
      } else if (device.gpuModel) expect(coverage, entry.id).toBe('system-only');
    }
    // The finding that motivated this: a 180B model shown at single-digit GB.
    const spark = SCORECARD.runs.filter((entry) => /dgx|gb10/.test(entry.id));
    expect(spark.length).toBeGreaterThan(0);
    for (const entry of spark) expect(scorecardMemoryCoverage(entry), entry.id).toBe('incomplete');
  });
});

describe('dataset validation', () => {
  it('rejects a result naming an unknown run', () => {
    const parsed = ScorecardDatasetSchema.safeParse({
      schemaVersion: 1,
      runs: [run('r1')],
      results: [result('m', 'nope', [['tictactoe', 3, 3, 0]])],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a duplicated model/suite/run cell', () => {
    const parsed = ScorecardDatasetSchema.safeParse({
      schemaVersion: 1,
      runs: [run('r1')],
      results: [
        result('m', 'r1', [['tictactoe', 3, 3, 0]]),
        result('m', 'r1', [['tictactoe', 3, 0, 0]]),
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
