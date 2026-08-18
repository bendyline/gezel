import { type ScorecardDataset, ScorecardDatasetSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { breakModelLabel, renderScorecardMarkdown } from './macros.js';

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
    expect(md).toContain('llama-cpp');
    expect(md).toContain('3 trials per task');
    expect(md).toContain('2026-08-09');
    expect(md).toContain('gezel abc1234');
  });

  it('renders a rate once the sample supports it', () => {
    const md = renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: true });
    expect(md).toContain('| Big 27B | 27B | 5/6 (83%) |');
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
    expect(md).toContain('1/1 (some tasks run once — count not rate)');
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
    // The dedicated column is gone (it read as an empty cell far more often
    // than it carried information); the discard still shows in the ratio,
    // which is 3/4 rather than 3/6.
    expect(md).toContain('3/4 (75%)');
    expect(md).not.toContain('Not measured');
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
    const headline = md.slice(0, md.indexOf('Earlier round'));
    expect(headline).not.toContain('Legacy');
    expect(md).toContain('different gezel build');
    expect(md).toContain('different catalog version');
  });

  it('omits the device-specific task count in site mode', () => {
    expect(renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: false })).not.toContain(
      'Tasks in this set',
    );
  });

  it('leaves model ids whole when nothing will render the break', () => {
    const md = renderScorecardMarkdown(
      dataset({
        results: [
          {
            modelId: 'qwen',
            label: 'qwen3.6-35b-a3b-q4',
            engine: 'llama-cpp',
            tier: 'medium',
            runId: 'r2',
            suiteId: 'core',
            cells: [{ scenarioId: 'tictactoe', trials: 3, successes: 3, nonModelFailures: 0 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: true },
    );
    expect(md).toContain('| qwen3.6-35b-a3b-q4 |');
    expect(md).not.toContain('<br>');
  });

  it('breaks a model id before its size so the column stays narrow', () => {
    const md = renderScorecardMarkdown(
      dataset({
        results: [
          {
            modelId: 'qwen',
            label: 'qwen3.6-35b-a3b-q4',
            engine: 'llama-cpp',
            tier: 'medium',
            runId: 'r2',
            suiteId: 'core',
            cells: [{ scenarioId: 'tictactoe', trials: 3, successes: 3, nonModelFailures: 0 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: true, breakLabels: true },
    );
    expect(md).toContain('| qwen3.6-<br>35b-a3b-q4 |');
  });
});

describe('breakModelLabel', () => {
  it('breaks before the size segment, not at the first hyphen', () => {
    expect(breakModelLabel('nemotron3.5-lightning-30b-q4')).toBe(
      'nemotron3.5-lightning-<br>30b-q4',
    );
    expect(breakModelLabel('muse-glimmer-30b-q4')).toBe('muse-glimmer-<br>30b-q4');
    expect(breakModelLabel('talkie-1930-13b-q4')).toBe('talkie-1930-<br>13b-q4');
  });

  it('leaves a label with no size segment alone', () => {
    expect(breakModelLabel('Big 27B')).toBe('Big 27B');
    expect(breakModelLabel('gpt-5')).toBe('gpt-5');
    expect(breakModelLabel('claude-sonnet')).toBe('claude-sonnet');
  });
});
