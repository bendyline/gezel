import {
  SCORECARD_DATA_ATTRS,
  type ScorecardDataset,
  ScorecardDatasetSchema,
} from '@bendyline/gezel';
import { markdownDocToPlainHtml } from '@bendyline/squisq-formats/html';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import {
  MACROS,
  breakModelLabel,
  renderScorecardFilterHtml,
  renderScorecardMarkdown,
  renderScorecardRunsMarkdown,
} from './macros.js';

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

  it('shows output and prefill speed together and annotates a recorded KV cache', () => {
    const md = renderScorecardMarkdown(
      dataset({
        results: [
          {
            modelId: 'qwen',
            label: 'qwen3.8-27b-q4',
            engine: 'llama-cpp',
            tier: 'medium',
            parameterSize: '27B',
            runId: 'r2',
            suiteId: 'core',
            performance: {
              prefillTokensPerSec: 1182,
              decodeTokensPerSec: 78.5,
              samples: 3,
            },
            runtime: {
              contextTokens: 262144,
              peakMemoryMb: 18432,
              kvCacheType: 'q8_0',
            },
            cells: [{ scenarioId: 'tictactoe', trials: 3, successes: 3, nonModelFailures: 0 }],
          },
        ],
      }),
      'core',
      { includeTaskCount: false, breakLabels: true },
    );

    expect(md).toContain('| Model | Size | Tasks passed | Performance | Context | Memory used |');
    expect(md).toContain('qwen3.8-<br>27b-q4 (kv: q8_0)');
    expect(md).toContain('78.5\u00a0tok/s output<br>1,182\u00a0tok/s prefill');
  });

  it('keeps the Performance column when an older round has no speed probe', () => {
    const md = renderScorecardMarkdown(dataset(), 'core', { includeTaskCount: false });
    expect(md).toContain('| Model | Size | Tasks passed | Performance |');
    expect(md).toContain('| Big 27B | 27B | 5/6 (83%) | — |');
    expect(md).not.toContain('(kv:');
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

  it('groups general and productivity tables beneath each shared run', () => {
    const combined = ScorecardDatasetSchema.parse({
      schemaVersion: 1,
      runs: [
        {
          id: 'r2',
          provenance: {
            startedAt: '2026-08-09T00:00:00.000Z',
            device: {
              label: 'Mac Studio (M4 Max)',
              platform: 'darwin',
              arch: 'arm64',
              memoryGb: 64,
            },
            harnessCommit: 'abc1234',
            gildeVersion: '0.1.15',
            count: 3,
            judgeModelId: null,
          },
          suites: ['core', 'productivity'],
          scenariosBySuite: { core: ['general-task'], productivity: ['office-task'] },
        },
        {
          id: 'r1',
          provenance: {
            startedAt: '2026-07-01T00:00:00.000Z',
            device: { label: 'Linux workstation', platform: 'linux', arch: 'x64' },
            harnessCommit: 'old0000',
            gildeVersion: '0.1.10',
            count: 3,
            judgeModelId: null,
          },
          suites: ['core', 'productivity'],
          scenariosBySuite: { core: ['general-task'], productivity: ['office-task'] },
        },
      ],
      results: [
        ...['r2', 'r1'].flatMap((runId) => [
          {
            modelId: `general-${runId}`,
            label: `General ${runId}`,
            engine: 'llama-cpp',
            tier: 'medium',
            runId,
            suiteId: 'core',
            cells: [{ scenarioId: 'general-task', trials: 3, successes: 3, nonModelFailures: 0 }],
          },
          {
            modelId: `office-${runId}`,
            label: `Office ${runId}`,
            engine: 'llama-cpp',
            tier: 'medium',
            runId,
            suiteId: 'productivity',
            cells: [{ scenarioId: 'office-task', trials: 3, successes: 2, nonModelFailures: 0 }],
          },
        ]),
      ],
    });

    const md = renderScorecardRunsMarkdown(combined, ['core', 'productivity'], {
      includeTaskCount: false,
    });
    const latest = md.indexOf('Latest round — 2026-08-09');
    const latestGeneral = md.indexOf('#### General capability', latest);
    const latestOffice = md.indexOf('#### Office and knowledge work', latest);
    const earlier = md.indexOf('Earlier round — 2026-07-01');
    const earlierGeneral = md.indexOf('#### General capability', earlier);
    const earlierOffice = md.indexOf('#### Office and knowledge work', earlier);

    expect(latest).toBeLessThan(latestGeneral);
    expect(latestGeneral).toBeLessThan(latestOffice);
    expect(latestOffice).toBeLessThan(earlier);
    expect(earlier).toBeLessThan(earlierGeneral);
    expect(earlierGeneral).toBeLessThan(earlierOffice);
    expect(md.match(/gezel abc1234/g)).toHaveLength(1);
    expect(md.match(/gezel old0000/g)).toHaveLength(1);
    expect(md).toContain('| General r2 |');
    expect(md).toContain('| Office r2 |');
    expect(md).toContain('| General r1 |');
    expect(md).toContain('| Office r1 |');
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

describe('::handboek-model-scorecard in site mode', () => {
  const twoRounds = (): ScorecardDataset =>
    ScorecardDatasetSchema.parse({
      schemaVersion: 1,
      runs: [
        {
          id: 'mac-latest',
          provenance: {
            startedAt: '2026-08-22T00:00:00.000Z',
            device: { label: 'Mac · Apple M4 Max', platform: 'darwin', arch: 'arm64' },
            harnessCommit: 'aaa1111',
            gildeVersion: '0.1.40',
            count: 3,
            judgeModelId: null,
          },
          suites: ['core', 'productivity'],
          scenariosBySuite: { core: ['general-task'], productivity: ['office-task'] },
        },
        {
          id: 'win-older',
          provenance: {
            startedAt: '2026-08-20T00:00:00.000Z',
            device: { label: 'win32 · Ryzen', platform: 'win32', arch: 'x64' },
            harnessCommit: 'bbb2222',
            gildeVersion: '0.1.39',
            count: 3,
            judgeModelId: null,
          },
          suites: ['core'],
          scenariosBySuite: { core: ['general-task'] },
        },
      ],
      results: [
        {
          modelId: 'gemma4-12b-q4',
          label: 'gemma4-12b-q4',
          engine: 'mlx',
          tier: 'medium',
          parameterSize: '12B',
          runId: 'mac-latest',
          suiteId: 'core',
          cells: [{ scenarioId: 'general-task', trials: 3, successes: 3, nonModelFailures: 0 }],
        },
        {
          modelId: 'qwen3.5-2b-q4',
          label: 'qwen3.5-2b-q4',
          engine: 'mlx',
          tier: 'tiny',
          parameterSize: '2B',
          runId: 'mac-latest',
          suiteId: 'productivity',
          cells: [{ scenarioId: 'office-task', trials: 3, successes: 1, nonModelFailures: 0 }],
        },
        {
          modelId: 'gemma4-12b-q8',
          label: 'gemma4-12b-q8',
          engine: 'llama-cpp',
          tier: 'medium',
          parameterSize: '12B',
          runId: 'win-older',
          suiteId: 'core',
          cells: [{ scenarioId: 'general-task', trials: 3, successes: 2, nonModelFailures: 0 }],
        },
      ],
    });

  it('degrades to a plain sentence before any sweep has been recorded', () => {
    const empty = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [], results: [] });
    const html = renderScorecardFilterHtml(empty, ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html).toContain('No core or productivity results have been recorded yet');
    expect(html).not.toContain('<div');
  });

  it('stamps each round with what a reader can filter it by', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.round}="mac-latest"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.date}="2026-08-22"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.hardware}="mac"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.hardwareLabel}="Mac"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.hardware}="windows"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.models}="gemma4-12b qwen3.5-2b"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.tiers}="medium tiny"`);
  });

  it('flags exactly one round as the default view', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html.match(new RegExp(SCORECARD_DATA_ATTRS.latest, 'g'))).toHaveLength(1);
    // Newest first, and the latest flag rides the newest — the script trusts
    // the flag rather than re-sorting dates in the browser.
    const latest = html.indexOf(SCORECARD_DATA_ATTRS.latest);
    const older = html.indexOf('win-older');
    expect(latest).toBeLessThan(older);
  });

  it('stamps every row with its model family, not its quantization', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    // Both quantizations answer to one pick in the model dropdown, while the
    // cell still names the exact build that was measured.
    expect(html.match(new RegExp(`${SCORECARD_DATA_ATTRS.model}="gemma4-12b"`, 'g'))).toHaveLength(
      2,
    );
    expect(html).toContain('<td>gemma4-12b-q4</td>');
    expect(html).toContain('<td>gemma4-12b-q8</td>');
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.tier}="tiny"`);
  });

  it('keeps each suite in its own hideable block under the shared stamp', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    const round = html.indexOf(`${SCORECARD_DATA_ATTRS.round}="mac-latest"`);
    const core = html.indexOf(`${SCORECARD_DATA_ATTRS.suite}="core"`, round);
    const productivity = html.indexOf(`${SCORECARD_DATA_ATTRS.suite}="productivity"`, round);
    expect(round).toBeLessThan(core);
    expect(core).toBeLessThan(productivity);
    expect(html).toContain('General capability');
    expect(html).toContain('Office and knowledge work');
  });

  it('publishes every recorded round, because a filter cannot reach an elided one', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html.match(new RegExp(`${SCORECARD_DATA_ATTRS.round}="`, 'g'))).toHaveLength(2);
  });

  it('names the machine when two sweeps share a date', () => {
    const dataset = twoRounds();
    const sameDay = ScorecardDatasetSchema.parse({
      ...dataset,
      runs: dataset.runs.map((run) =>
        run.id === 'win-older'
          ? { ...run, provenance: { ...run.provenance, startedAt: '2026-08-22T00:00:00.000Z' } }
          : run,
      ),
    });
    const html = renderScorecardFilterHtml(sameDay, ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.roundLabel}="2026-08-22 · Mac"`);
    expect(html).toContain(`${SCORECARD_DATA_ATTRS.roundLabel}="2026-08-22 · Windows"`);
  });

  it('emits one HTML block, since a blank line would orphan the closing tags', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    expect(html.split('\n').every((line) => line.startsWith('<'))).toBe(true);
    expect(html).not.toContain('\n\n');
  });

  it('survives the markdown pipeline the site renders it through', () => {
    const html = renderScorecardFilterHtml(twoRounds(), ['core', 'productivity'], {
      includeTaskCount: false,
    });
    // squisq drops `select`/`script` and keeps `div`/`table` plus `data-`
    // attributes; the whole design rests on that, so prove it here rather
    // than only in the export.
    const rendered = markdownDocToPlainHtml(parseMarkdown(`## Results\n\n${html}\n`), {
      title: 'scorecard',
    });
    expect(rendered).toContain(`${SCORECARD_DATA_ATTRS.round}="mac-latest"`);
    expect(rendered).toContain(`${SCORECARD_DATA_ATTRS.model}="gemma4-12b"`);
    expect(rendered).toContain('<table>');
  });

  it('keeps the fixed markdown rounds for the app and the agent', async () => {
    for (const mode of ['app', 'agent'] as const) {
      const rendered = await MACROS['model-scorecard']!({ suites: 'core,productivity' }, {
        mode,
      } as never);
      expect(rendered, mode).not.toContain(SCORECARD_DATA_ATTRS.root);
      expect(rendered, mode).toContain('###');
    }
  });
});
