import type {
  EvalCatalog,
  EvalJob,
  EvalTargetsResponse,
  EvalTrialDetail,
  EvalTrialSummary,
} from '@bendyline/gezel/eval';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { BenchmarksView } = await import('./BenchmarksView.js');
const { api } = await import('../api.js');

const CATALOG: EvalCatalog = {
  schemaVersion: 1,
  scenarios: [
    {
      id: 'tictactoe',
      description: 'Single-file game.',
      kind: 'scenario',
      anchored: true,
      timeoutMs: 20 * 60_000,
      suggestedTrials: 1,
      requires: ['chromium'],
      judgeAxes: [],
      suites: ['smoke', 'core'],
    },
    {
      id: 'failing-tests-spec',
      description: 'Tests as the spec.',
      kind: 'scenario',
      anchored: false,
      timeoutMs: 25 * 60_000,
      requires: ['vitest'],
      judgeAxes: [],
      suites: ['core'],
    },
    {
      id: 'craftbook-invoice-run',
      description: 'Invoice run: bill the month.',
      kind: 'craftbook',
      anchored: false,
      timeoutMs: 30 * 60_000,
      requires: [],
      judgeAxes: [],
      suites: [],
    },
  ],
  suites: [
    {
      id: 'smoke',
      description: 'Fast pulse check.',
      scenarioIds: ['tictactoe'],
      authoredCeilingMs: 20 * 60_000,
    },
    {
      id: 'core',
      description: 'The standard scorecard.',
      scenarioIds: ['tictactoe', 'failing-tests-spec'],
      authoredCeilingMs: 45 * 60_000,
    },
  ],
  defaultSuiteId: 'core',
  providers: [
    { id: 'mlx', category: 'local-engine', defaultModelId: 'qwen3.5-4b-q4' },
    { id: 'anthropic', category: 'cloud-sdk', defaultModelId: 'claude-sonnet-4-6' },
  ],
  defaultProvider: 'mlx',
  minTrialsForRate: 3,
};

const TARGETS: EvalTargetsResponse = {
  targets: [
    {
      provider: 'mlx',
      modelId: 'qwen3.5-4b-q4',
      label: 'Qwen 3.5 4B',
      category: 'local-engine',
      available: true,
      isDefault: true,
    },
    {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      label: 'claude-sonnet-4-6',
      category: 'cloud-sdk',
      available: false,
      unavailableReason: 'Add an Anthropic API key in Settings first.',
    },
  ],
  imageModels: [],
  environment: {
    harness: 'compiled',
    satisfied: ['chromium', 'network'],
    runsDir: '/home/u/.gezel/eval-runs',
  },
};

function trial(overrides: Partial<EvalTrialSummary>): EvalTrialSummary {
  return {
    trialId: 't1',
    scenarioId: 'tictactoe',
    modelId: 'qwen3.5-4b-q4',
    provider: 'mlx',
    startedAt: '2026-09-29T10:00:00.000Z',
    running: false,
    success: true,
    failureClass: 'pass',
    durationMs: 600_000,
    composite: 9.1,
    runDir: '/home/u/.gezel/eval-runs/jobs/j/01/tictactoe/t1',
    ...overrides,
  };
}

function job(overrides: Partial<EvalJob>): EvalJob {
  return {
    id: 'job-1',
    spec: { suiteId: 'core', count: 1, targets: [{ provider: 'mlx', modelId: 'qwen3.5-4b-q4' }] },
    status: 'queued',
    createdAt: '2026-09-29T10:00:00.000Z',
    harness: 'compiled',
    dir: '/home/u/.gezel/eval-runs/jobs/job-1',
    targets: [
      {
        provider: 'mlx',
        modelId: 'qwen3.5-4b-q4',
        status: 'pending',
        runDir: '/home/u/.gezel/eval-runs/jobs/job-1/01',
        completedTrials: 0,
        passedTrials: 0,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.getEvalCatalog!).mockResolvedValue(CATALOG);
  vi.mocked(api.listEvalTargets!).mockResolvedValue(TARGETS);
  vi.mocked(api.listEvalJobs!).mockResolvedValue({ jobs: [] });
  vi.mocked(api.listEvalTrials!).mockResolvedValue({ trials: [], total: 0 });
  vi.mocked(api.streamEvalJob!).mockReturnValue(new Promise(() => {}));
});

describe('BenchmarksView', () => {
  it('never shows the old source-checkout gate', async () => {
    render(<BenchmarksView />);
    await screen.findByText('Run an evaluation');
    expect(screen.queryByText(/eval runner unavailable/i)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Start evaluation' })).toBeEnabled();
  });

  it('plans the default suite with the default model and names what cannot be graded', async () => {
    render(<BenchmarksView />);
    const suite = await screen.findByRole('combobox', { name: 'Suite' });
    expect((suite as HTMLSelectElement).value).toBe('core');
    expect(screen.getByRole('checkbox', { name: /Qwen 3.5 4B/ })).toBeChecked();
    const anthropic = screen.getByRole('checkbox', { name: /claude-sonnet-4-6/ });
    expect(anthropic).toBeDisabled();
    expect(screen.getByText('Add an Anthropic API key in Settings first.')).toBeInTheDocument();
    expect(screen.getByText(/2 trials/)).toBeInTheDocument();
    expect(screen.getByText('failing-tests-spec', { selector: 'strong' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /is graded by a test runner that only a gezel source checkout includes, so it will/,
      ),
    ).toBeInTheDocument();
  });

  it('queues a job from the plan', async () => {
    vi.mocked(api.createEvalJob!).mockResolvedValue(job({}));
    render(<BenchmarksView />);
    fireEvent.click(await screen.findByRole('radio', { name: '3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start evaluation' }));
    await waitFor(() =>
      expect(api.createEvalJob).toHaveBeenCalledWith({
        suiteId: 'core',
        count: 3,
        targets: [{ provider: 'mlx', modelId: 'qwen3.5-4b-q4' }],
      }),
    );
    expect(await screen.findByText('In progress')).toBeInTheDocument();
  });

  it('picks individual scenarios, including craftbook recipes', async () => {
    vi.mocked(api.createEvalJob!).mockResolvedValue(job({}));
    render(<BenchmarksView />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Pick scenarios' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Recipes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /craftbook-invoice-run/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start evaluation' }));
    await waitFor(() =>
      expect(api.createEvalJob).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioIds: ['craftbook-invoice-run'], count: 1 }),
      ),
    );
  });

  it('follows a running job and offers to stop it', async () => {
    vi.mocked(api.listEvalJobs!).mockResolvedValue({
      jobs: [
        job({
          status: 'running',
          targets: [
            {
              provider: 'mlx',
              modelId: 'qwen3.5-4b-q4',
              status: 'running',
              runDir: '/r/01',
              plannedTrials: 2,
              completedTrials: 1,
              passedTrials: 1,
              currentTrial: {
                scenarioId: 'failing-tests-spec',
                trialId: 't2',
                trialIndex: 2,
                startedAt: new Date().toISOString(),
              },
            },
          ],
        }),
      ],
    });
    vi.mocked(api.cancelEvalJob!).mockResolvedValue(job({ status: 'cancelled' }));
    render(<BenchmarksView />);
    expect(await screen.findByText('1 of 2 trials · 1 passed')).toBeInTheDocument();
    expect(screen.getByText(/Now running/).textContent).toContain(
      'failing-tests-spec — trial 2 of 2',
    );
    expect(screen.getByRole('button', { name: 'Add to the queue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.cancelEvalJob).toHaveBeenCalledWith('job-1'));
  });

  it('scores results with the scorecard rules and opens a trial', async () => {
    vi.mocked(api.listEvalTrials!).mockResolvedValue({
      trials: [
        trial({ trialId: 'a' }),
        trial({ trialId: 'b', success: false, failureClass: 'infra', composite: 2 }),
        trial({ trialId: 'c', success: false, failureClass: 'model', composite: 4 }),
      ],
      total: 3,
    });
    const detail: EvalTrialDetail = {
      trial: trial({ trialId: 'a', band: 'ship-ready' }),
      rubric: {
        completion: { score: 10, summary: 'gate satisfied' },
        quality: { score: 9, summary: 'full sniff' },
        efficiency: { score: 7.5, summary: 'mild' },
        behavior: { score: 10, summary: 'clean' },
        includedInModelAggregate: true,
      },
      logTail: ['[trial] done'],
      artifacts: [{ path: 'artifacts/p/index.html', bytes: 2048 }],
    };
    vi.mocked(api.getEvalTrial!).mockResolvedValue(detail);
    render(<BenchmarksView />);
    const table = await screen.findByRole('table');
    // Two attributable trials: a count, not a rate; the infra failure is left out.
    expect(within(table).getAllByText('1/2 (n<3, count not rate)').length).toBeGreaterThan(0);
    expect(within(table).getByText('1 not counted')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: /1\/2/ }));
    expect(await screen.findByText('Score 9.1 / 10')).toBeInTheDocument();
    expect(screen.getByText('gate satisfied')).toBeInTheDocument();
    expect(api.getEvalTrial).toHaveBeenCalledWith('a');
  });

  it('explains a catalog that could not load and retries', async () => {
    vi.mocked(api.getEvalCatalog!)
      .mockRejectedValueOnce(new Error('the eval harness could not list its scenarios'))
      .mockResolvedValue(CATALOG);
    render(<BenchmarksView />);
    expect(await screen.findByText(/could not list its scenarios/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Start evaluation' })).toBeInTheDocument();
    expect(api.getEvalCatalog).toHaveBeenLastCalledWith({ refresh: true });
  });
});
