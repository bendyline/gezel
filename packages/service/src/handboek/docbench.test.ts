import type { ScorecardDataset, ScorecardDocbench, ScorecardModelResult } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { renderDocbenchScorecardMarkdown } from './docbench.js';
import { MACROS, renderScorecardRoundPages, renderScorecardRunsMarkdown } from './macros.js';

const device = { label: 'Rig', platform: 'win32', arch: 'arm64', memoryGb: 32 };

function round(id: string, startedAt: string, suite: string) {
  return {
    id,
    provenance: {
      startedAt,
      device,
      harnessCommit: 'abc1234',
      gildeVersion: '0.3.8',
      count: 3,
      judgeModelId: 'claude-opus-5-5',
    },
    suites: [suite],
    scenariosBySuite: { [suite]: ['review-general'] },
  };
}

function docbench(score: number, band: number): ScorecardDocbench {
  return {
    packVersion: '0.2.1',
    score,
    ci: [score - 2, score + 2],
    band,
    usableRate: 0.98,
    families: {
      review: { score: score - 10, ci: [score - 13, score - 7] },
      writing: { score: score + 5, ci: [score + 2, score + 8] },
    },
    tasks: {
      'review-general': {
        score: score - 10,
        ci: [score - 13, score - 7],
        usableRate: 1,
        medianOutputTokens: 900,
        findings: { low: 3.5, medium: 1.25, high: 0.5, trivial: 0.25, wrong: 0 },
      },
    },
    judge: { model: 'claude-opus-5-5', promptVersion: 2, validityPassed: true },
  };
}

function row(
  modelId: string,
  label: string,
  runId: string,
  value: ScorecardDocbench,
): ScorecardModelResult {
  return {
    modelId,
    label,
    engine: 'llama-cpp',
    tier: 'small',
    parameterSize: '4B',
    runId,
    suiteId: 'docbench',
    docbench: value,
    cells: [{ scenarioId: 'review-general', trials: 4, successes: 4, nonModelFailures: 0 }],
  };
}

const dataset = {
  schemaVersion: 1,
  runs: [
    round('docbench-new', '2026-11-11T00:00:00.000Z', 'docbench'),
    round('docbench-old', '2026-10-01T00:00:00.000Z', 'docbench'),
  ],
  results: [
    row('small-q4', 'Small', 'docbench-new', docbench(43.2, 2)),
    row('big-q4', 'Big | Model', 'docbench-new', docbench(80.7, 1)),
    row('big-q4', 'Big | Model', 'docbench-old', docbench(61, 1)),
  ],
} as ScorecardDataset;

describe('docbench scorecard', () => {
  it('ranks the newest round by band, with ranges and families', () => {
    const markdown = renderDocbenchScorecardMarkdown(dataset);
    const lines = markdown.split('\n');
    const header = lines.find((line) => line.startsWith('| Band'));
    expect(header).toBe(
      '| Band | Model | Size | Docbench | 95% range | Review | Writing | Usable |',
    );
    const big = lines.findIndex((line) => line.includes('Big \\| Model'));
    const small = lines.findIndex((line) => line.includes('| Small |'));
    expect(big).toBeGreaterThan(0);
    expect(small).toBeGreaterThan(big);
    expect(lines[big]).toBe('| 1 | Big \\| Model | 4B | **81** | 79–83 | 71 | 86 | 98% |');
    expect(markdown).toContain('judged by claude-opus-5-5');
    expect(markdown).toContain('| Big \\| Model | 3.5 | 1.3 | 0.5 | 0.3 | 0.0 |');
    expect(markdown).toContain('### Earlier docbench round — 2026-10-01');
  });

  it('keeps the full round as the headline and shows a focused re-run beneath it', () => {
    const rerun = {
      ...round('docbench-fix', '2026-11-12T00:00:00.000Z', 'docbench'),
      scope: 'subset' as const,
      note: 'Focused re-run of small-q4 beside docbench-new, after fixes to how Gezel serves them',
    };
    const withRerun = {
      ...dataset,
      runs: [rerun, ...dataset.runs],
      results: [...dataset.results, row('small-q4', 'Small', 'docbench-fix', docbench(70.7, 1))],
    } as ScorecardDataset;
    const markdown = renderDocbenchScorecardMarkdown(withRerun);
    // The headline is the full round, even though the re-run is newer.
    const headline = markdown.split('### ')[0]!;
    expect(headline).toContain('| Big \\| Model |');
    // …but says that row has a newer number below.
    expect(headline).toContain('| Small (re-measured below) | 4B | **43** |');
    expect(headline).toContain('| Big \\| Model | 4B |');
    const section = markdown.split('### Focused re-run — 2026-11-12')[1]!.split('### ')[0]!;
    expect(section).toContain('| Small | 4B | **71** |');
    expect(section).not.toContain('Big');
    expect(section).toContain('Focused re-run of small-q4');
    expect(markdown).toContain('### Earlier docbench round — 2026-10-01');
  });

  it('says so when nothing is published', () => {
    expect(renderDocbenchScorecardMarkdown({ schemaVersion: 1, runs: [], results: [] })).toMatch(
      /No docbench round/,
    );
  });

  it('flags a judge that has not passed validity', () => {
    const unvalidated = {
      ...dataset,
      results: dataset.results.map((result) => ({
        ...result,
        docbench: {
          ...result.docbench!,
          judge: { ...result.docbench!.judge, validityPassed: false },
        },
      })),
    } as ScorecardDataset;
    expect(renderDocbenchScorecardMarkdown(unvalidated)).toContain('(judge not yet validated)');
  });

  it('is a registered macro', () => {
    expect(MACROS['docbench-scorecard']).toBeTypeOf('function');
  });

  it('never prints docbench rows as pass rates', () => {
    expect(renderScorecardRoundPages(dataset)).toEqual([]);
    expect(
      renderScorecardRunsMarkdown(dataset, ['docbench'], { includeTaskCount: true }),
    ).not.toMatch(/Big/);
  });
});
