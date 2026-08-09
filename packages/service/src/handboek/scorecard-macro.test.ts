import { type ScorecardDataset, ScorecardDatasetSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { renderScorecardMarkdown } from './macros.js';

function dataset(
  over: {
    runs?: unknown[];
    results?: unknown[];
  } = {},
): ScorecardDataset {
  return ScorecardDatasetSchema.parse({
    schemaVersion: 1,
    runs: over.runs ?? [
      {
        id: 'r2',
        provenance: {
          startedAt: '2026-08-09T00:00:00.000Z',
          device: { label: 'Mac Studio (M4 Max)', platform: 'darwin', arch: 'arm64', memoryGb: 64 },
          harnessCommit: 'abc1234',
          gildeVersion: '0.1.15',
          count: 3,
          judgeModelId: 'claude-sonnet-4-6',
        },
        suites: ['core'],
        scenariosBySuite: { core: ['tictactoe', 'petshop'] },
      },
    ],
    results: over.results ?? [
      {
        modelId: 'big',
        label: 'Big 27B',
        engine: 'llama-cpp',
        tier: 'medium',
        parameterSize: '27B',
        runId: 'r2',
        suiteId: 'core',
        cells: [
          { scenarioId: 'tictactoe', trials: 3, successes: 3, nonModelFailures: 0 },
          { scenarioId: 'petshop', trials: 3, successes: 2, nonModelFailures: 0 },
        ],
      },
    ],
  });
}

describe('::handboek-model-scorecard', () => {
  it('degrades to a plain sentence before any sweep has been recorded', () => {
    const empty = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [], results: [] });
    const md = renderScorecardMarkdown(empty, 'core', { includeTaskCount: true });
    expect(md).toContain('No core results have been recorded yet');
    expect(md).not.toContain('|');
  });

  it('stamps the table with the device, sample size, date, and versions', () => {
    const md = renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: true });
    expect(md).toContain('Mac Studio (M4 Max)');
    expect(md).toContain('3 trials per task');
    expect(md).toContain('2026-08-09');
    expect(md).toContain('gezel abc1234');
  });

  it('renders a rate once the sample supports it', () => {
    const md = renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: true });
    expect(md).toContain('| Big 27B | 27B | 5/6 (83%) | — |');
  });

  it('prints a count, never a percentage, below three trials', () => {
    const md = renderScorecardMarkdown(
      dataset({
        results: [
          {
            modelId: 'thin',
            label: 'Thin',
            engine: 'llama-cpp',
            tier: 'small',
            runId: 'r2',
            suiteId: 'core',
            cells: [{ scenarioId: 'tictactoe', trials: 1, successes: 1, nonModelFailures: 0 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: true },
    );
    expect(md).toContain('1/1 (n<3, count not rate)');
    expect(md).not.toMatch(/100%/);
  });

  it('shows trials lost to the machine rather than silently dropping them', () => {
    const md = renderScorecardMarkdown(
      dataset({
        results: [
          {
            modelId: 'unlucky',
            label: 'Unlucky',
            engine: 'llama-cpp',
            tier: 'medium',
            runId: 'r2',
            suiteId: 'core',
            cells: [{ scenarioId: 'tictactoe', trials: 6, successes: 3, nonModelFailures: 2 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: true },
    );
    expect(md).toContain('3/4 (75%)');
    expect(md).toContain('2 runs lost to the machine');
  });

  it('lists an earlier round apart, and says why it is not comparable', () => {
    const md = renderScorecardMarkdown(
      dataset({
        runs: [
          ...dataset().runs,
          {
            id: 'r1',
            provenance: {
              startedAt: '2026-07-01T00:00:00.000Z',
              device: { label: 'Mac Studio (M4 Max)', platform: 'darwin', arch: 'arm64' },
              harnessCommit: 'old0000',
              gildeVersion: '0.1.10',
              count: 3,
              judgeModelId: null,
            },
            suites: ['core'],
            scenariosBySuite: { core: ['tictactoe', 'petshop'] },
          },
        ],
        results: [
          ...dataset().results,
          {
            modelId: 'legacy',
            label: 'Legacy',
            engine: 'llama-cpp',
            tier: 'medium',
            runId: 'r1',
            suiteId: 'core',
            cells: [{ scenarioId: 'tictactoe', trials: 3, successes: 3, nonModelFailures: 0 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: true },
    );
    // A perfect score from an older build must not join the headline table.
    const headline = md.slice(0, md.indexOf('Measured in an earlier round'));
    expect(headline).not.toContain('Legacy');
    expect(md).toContain('different gezel build');
    expect(md).toContain('different catalog version');
  });

  it('omits the device-specific task count in site mode', () => {
    expect(renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: false })).not.toContain(
      'Tasks in this set',
    );
  });
});
