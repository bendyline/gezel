import type { ScorecardDataset } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { renderCommunityScorecardMarkdown } from './macros.js';

const empty: ScorecardDataset = { schemaVersion: 1, runs: [], results: [] };

const oneRound = {
  schemaVersion: 1,
  runs: [
    {
      id: 'community-2026-11-01-r9700-qwen',
      provenance: {
        startedAt: '2026-11-01T10:00:00.000Z',
        device: {
          label: 'Linux · AMD Ryzen 9 7950X3D',
          platform: 'linux',
          arch: 'x64',
          memoryGb: 64,
        },
        harnessCommit: '1.2.11',
        gildeVersion: '0.3.4',
        count: 3,
        judgeModelId: null,
      },
      suites: ['core'],
      scenariosBySuite: { core: ['a', 'b'] },
    },
  ],
  results: [
    {
      modelId: 'qwen3.5-4b-q4',
      label: 'Qwen 3.5 (4B, Q4)',
      engine: 'llama-cpp',
      tier: 'small',
      runId: 'community-2026-11-01-r9700-qwen',
      suiteId: 'core',
      cells: [
        { scenarioId: 'a', trials: 3, successes: 3, nonModelFailures: 0 },
        { scenarioId: 'b', trials: 3, successes: 1, nonModelFailures: 0 },
      ],
    },
  ],
} as unknown as ScorecardDataset;

describe('community scorecard', () => {
  it('says how to contribute when nothing has been published', () => {
    const md = renderCommunityScorecardMarkdown(empty, ['core'], 'site');
    expect(md).toContain('No community rounds have been published yet.');
    expect(md).toContain('gezel bench submit result.json');
  });

  it('renders a submitted round with the same counting rules, credited to its submitter', () => {
    const md = renderCommunityScorecardMarkdown(oneRound, ['core'], 'app');
    expect(md).toContain('run and submitted by someone outside Bendyline');
    expect(md).toContain('4/6 (67%)');
    expect(md).toContain('AMD Ryzen 9 7950X3D');
  });
});
