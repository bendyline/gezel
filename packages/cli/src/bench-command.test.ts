import type { SystemDiagnostics } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type {
  EvalCatalog,
  EvalJob,
  EvalJobStreamEvent,
  EvalTarget,
  EvalTrialSummary,
} from '@bendyline/gezel/eval';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  type BenchClient,
  createJobFollower,
  describeJobOutcome,
  describePlan,
  describeSubmission,
  formatDuration,
  planBench,
  registerBenchCommands,
  renderResults,
  renderSuiteList,
  renderSuiteReport,
  resolveBenchSuites,
  resolveBenchTarget,
  runBench,
  submitBench,
} from './bench-command.js';

const HOUR = 60 * 60_000;

const catalog: EvalCatalog = {
  schemaVersion: 1,
  scenarios: [],
  suites: [
    {
      id: 'core',
      description: 'The standard 11-scenario model scorecard.',
      scenarioIds: ['tictactoe', 'petshop', 'symptom-debug'],
      authoredCeilingMs: 3 * HOUR,
    },
    {
      id: 'smoke',
      description: 'Fast pulse check. Not a scorecard — use core for that.',
      scenarioIds: ['tictactoe'],
      authoredCeilingMs: 20 * 60_000,
    },
    {
      id: 'productivity',
      description: 'Knowledge-work scorecard.',
      scenarioIds: ['constrained-comms', 'records-intake'],
      authoredCeilingMs: 2 * HOUR,
    },
    {
      id: 'developer',
      description: 'Engineering scorecard.',
      scenarioIds: ['fix-squisq-bugs'],
      authoredCeilingMs: 10 * HOUR,
    },
  ],
  defaultSuiteId: 'core',
  providers: [{ id: 'llama-cpp', category: 'local-engine', defaultModelId: 'qwen3.5-4b-q4' }],
  defaultProvider: 'llama-cpp',
  minTrialsForRate: 3,
};

const targets: EvalTarget[] = [
  {
    provider: 'llama-cpp',
    modelId: 'qwen3.5-4b-q4',
    label: 'Qwen 3.5 (4B, Q4)',
    category: 'local-engine',
    available: true,
    isDefault: true,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    category: 'cloud-sdk',
    available: false,
    unavailableReason: 'No Anthropic key is saved.',
  },
];

const host: SystemDiagnostics = {
  version: '1.2.11',
  sampledAt: '2026-11-01T10:00:00.000Z',
  runtime: {
    nodeVersion: 'v24.0.0',
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0',
    platformKey: 'linux-x64',
  },
  hardware: {
    totalRamBytes: 64 * 1024 ** 3,
    gpuVramBytes: 32 * 1024 ** 3,
    usableBytes: 32 * 1024 ** 3,
    source: 'gpu-vulkan',
    description: 'AMD Radeon AI PRO R9700',
    tier: 'large',
    gpuDevices: [{ name: 'AMD Radeon AI PRO R9700', totalMiB: 32768 }],
  },
  engine: {
    nativeRelease: '0.1.54',
    nativePinned: true,
    installedEngines: [],
    llamaCppBackend: 'vulkan',
  },
  models: { defaultProvider: 'llama-cpp', installed: [] },
  localEngines: [],
} as unknown as SystemDiagnostics;

let seq = 0;
function trial(overrides: Partial<EvalTrialSummary>): EvalTrialSummary {
  seq += 1;
  return {
    trialId: `t-${seq}`,
    scenarioId: 'tictactoe',
    modelId: 'qwen3.5-4b-q4',
    provider: 'llama-cpp',
    jobId: 'job-1',
    startedAt: `2026-11-01T10:${String(seq).padStart(2, '0')}:00.000Z`,
    running: false,
    success: true,
    failureClass: 'pass',
    modelTier: 'small',
    decodeTokensPerSec: 42,
    runDir: `/runs/t-${seq}`,
    ...overrides,
  };
}

function job(overrides: Partial<EvalJob> = {}): EvalJob {
  return {
    id: 'job-1',
    spec: {
      suiteId: 'core',
      count: 1,
      targets: [{ provider: 'llama-cpp', modelId: 'qwen3.5-4b-q4' }],
    },
    status: 'queued',
    createdAt: '2026-11-01T10:00:00.000Z',
    harness: 'compiled',
    targets: [
      {
        provider: 'llama-cpp',
        modelId: 'qwen3.5-4b-q4',
        status: 'pending',
        runDir: '/runs/job-1',
        completedTrials: 0,
        passedTrials: 0,
      },
    ],
    dir: '/runs/job-1',
    ...overrides,
  };
}

function fakeClient(trials: EvalTrialSummary[], events: EvalJobStreamEvent[]) {
  const created = job();
  const finished = events
    .filter((e): e is Exclude<EvalJobStreamEvent, { type: 'log' }> => e.type !== 'log')
    .pop();
  const client = {
    getEvalCatalog: vi.fn().mockResolvedValue(catalog),
    listEvalTargets: vi.fn().mockResolvedValue({
      targets,
      imageModels: [],
      environment: { harness: 'compiled', satisfied: [], runsDir: '/home/me/.gezel/evals' },
    }),
    listEvalJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    createEvalJob: vi.fn().mockResolvedValue(created),
    getEvalJob: vi.fn().mockResolvedValue(finished ? finished.job : created),
    streamEvalJob: vi.fn(async (_id: string, onEvent: (e: EvalJobStreamEvent) => void) => {
      for (const e of events) onEvent(e);
    }),
    listEvalTrials: vi.fn().mockResolvedValue({ trials, total: trials.length }),
    getSystemDiagnostics: vi.fn().mockResolvedValue(host),
  };
  return client as unknown as BenchClient & typeof client;
}

describe('gezel bench planning', () => {
  it('defaults to core on the install default model, one trial', () => {
    const plan = planBench(catalog, targets, {});
    expect(plan.suites.map((s) => s.id)).toEqual(['core']);
    expect(plan.target.modelId).toBe('qwen3.5-4b-q4');
    expect(plan.count).toBe(1);
    expect(plan.worstCaseMs).toBe(3 * HOUR);
    expect(describePlan(plan, catalog).join('\n')).toContain('results show as counts');
  });

  it('runs every scorecard suite the catalog has for --suite all', () => {
    expect(resolveBenchSuites(catalog, { suite: 'all' }).map((s) => s.id)).toEqual([
      'core',
      'productivity',
      'developer',
    ]);
  });

  it('swaps a suite for its smoke variant and refuses when there is none', () => {
    expect(resolveBenchSuites(catalog, { smoke: true }).map((s) => s.id)).toEqual(['smoke']);
    expect(() => resolveBenchSuites(catalog, { suite: 'productivity', smoke: true })).toThrow(
      /no smoke variant/,
    );
    expect(() => resolveBenchSuites(catalog, { suite: 'nope' })).toThrow(/Unknown suite "nope"/);
  });

  it('explains why a requested model cannot run', () => {
    expect(() => resolveBenchTarget(catalog, targets, { model: 'claude-sonnet-5-5' })).toThrow(
      /No Anthropic key is saved/,
    );
    expect(() => resolveBenchTarget(catalog, targets, { model: 'ghost' })).toThrow(
      /No model "ghost"/,
    );
    expect(() => planBench(catalog, targets, { count: 0 })).toThrow(/--count/);
  });

  it('formats durations the way the planner states them', () => {
    expect(formatDuration(20 * 60_000)).toBe('20m');
    expect(formatDuration(3 * HOUR)).toBe('3h');
    expect(formatDuration(3 * HOUR + 25 * 60_000)).toBe('3h 25m');
    expect(describeJobOutcome(job({ status: 'completed' }))).toBeNull();
    expect(describeJobOutcome(job({ status: 'interrupted' }))).toMatch(/service stopped/);
  });
});

describe('gezel bench reporting', () => {
  it('prints per-task claims with the scorecard rules and the decode rate', () => {
    const suite = catalog.suites[0]!;
    const trials = [
      trial({}),
      trial({}),
      trial({ success: false, failureClass: 'model' }),
      trial({ scenarioId: 'petshop', success: false, failureClass: 'infra' }),
      trial({ scenarioId: 'petshop' }),
    ];
    const text = renderSuiteReport(suite, targets[0]!, trials, 3).join('\n');
    expect(text).toContain('General capability (core)');
    expect(text).toMatch(/tictactoe\s+2\/3 \(67%\)/);
    expect(text).toMatch(/petshop\s+1\/1 \(n<3, count not rate\)\s+\(1 not counted/);
    expect(text).toMatch(/symptom-debug\s+not run/);
    expect(text).toContain('A count, not a rate');
    expect(text).toContain('Decode: 42.0 tok/s');
  });

  it('turns job snapshots into one line per change', () => {
    const follower = createJobFollower(catalog.suites[0]!, 1);
    expect(follower.update(job())).toEqual([]);
    const running = job({
      status: 'running',
      targets: [
        {
          ...job().targets[0]!,
          status: 'running',
          plannedTrials: 3,
          preflight: { admitted: true, decodeTokensPerSec: 41.2 },
          currentTrial: {
            scenarioId: 'tictactoe',
            trialId: 't-1',
            trialIndex: 1,
            startedAt: '2026-11-01T10:01:00.000Z',
          },
        },
      ],
    });
    expect(follower.update(running)).toEqual([
      'Fitness check passed · 41.2 tok/s.',
      '  tictactoe (1/3) running…',
    ]);
    // The same snapshot again says nothing new.
    expect(follower.update(running)).toEqual([]);
    const progressed = job({
      status: 'running',
      targets: [
        { ...running.targets[0]!, completedTrials: 1, passedTrials: 1, currentTrial: undefined },
      ],
    });
    expect(follower.update(progressed)).toEqual(['  1/3 done, 1 passed']);
  });

  it('lists suites with the scorecard ones first', () => {
    const text = renderSuiteList(catalog).join('\n');
    const core = text.indexOf('core ');
    const smoke = text.indexOf('smoke ');
    expect(core).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(core);
    expect(text).toContain('General capability');
    expect(text).toContain('not a suite score');
  });
});

describe('gezel bench run', () => {
  it('plans, follows the job, reports, and writes a shard', async () => {
    const finished = job({
      status: 'completed',
      finishedAt: '2026-11-01T11:00:00.000Z',
      targets: [
        {
          ...job().targets[0]!,
          status: 'completed',
          plannedTrials: 3,
          completedTrials: 3,
          passedTrials: 2,
        },
      ],
    });
    const trials = [
      trial({}),
      trial({ scenarioId: 'petshop' }),
      trial({ scenarioId: 'symptom-debug', success: false, failureClass: 'model' }),
    ];
    const client = fakeClient(trials, [
      { type: 'snapshot', job: job({ status: 'running' }), log: [] },
      { type: 'log', line: 'harness noise' },
      { type: 'job', job: finished },
    ]);
    const out: string[] = [];
    const notes: string[] = [];
    const report = await runBench(
      client,
      { yes: true },
      {
        out: (l) => out.push(l),
        note: (l) => notes.push(l),
        cpuModel: () => 'AMD Ryzen 9 7950X3D',
        gildeVersion: () => '0.3.4',
        now: () => new Date('2026-11-01T10:00:00.000Z'),
      },
    );
    expect(client.createEvalJob).toHaveBeenCalledWith({
      suiteId: 'core',
      count: 1,
      targets: [{ provider: 'llama-cpp', modelId: 'qwen3.5-4b-q4' }],
      note: 'gezel bench 2026-11-01-amd-ryzen-9-7950x3d-qwen3-5-4b-q4',
    });
    expect(notes[0]).toBe(
      'AMD Ryzen 9 7950X3D · AMD Radeon AI PRO R9700 · 64 GB · native 0.1.54 (vulkan) · gezel 1.2.11',
    );
    expect(notes.join('\n')).not.toContain('harness noise');
    const text = out.join('\n');
    expect(text).toMatch(/suite\s+2\/3 \(some tasks run once — count not rate\)/);
    expect(text).toContain('1 trial per task');
    expect(text).toContain('catalog 0.3.4');
    expect(report.shard.runs[0]?.provenance.engineBuilds).toEqual({
      native: '0.1.54',
      'llama-cpp-backend': 'vulkan',
    });
    expect(report.results[0]?.cells.map((c) => c.successes)).toEqual([1, 1, 0]);
  });

  it('asks before a long run and refuses without a terminal', async () => {
    const client = fakeClient([], []);
    const io = { out: vi.fn(), note: vi.fn() };
    await expect(runBench(client, { suite: 'developer' }, io)).rejects.toThrow(/Add --yes/);
    const declined = { ...io, confirm: vi.fn().mockResolvedValue(false) };
    await expect(runBench(client, { suite: 'developer' }, declined)).rejects.toThrow(/Not started/);
    expect(declined.confirm).toHaveBeenCalledWith(expect.stringContaining('10h'));
    expect(client.createEvalJob).not.toHaveBeenCalled();
  });

  it('shows finished runs with the subset note where it applies', async () => {
    const client = fakeClient([trial({})], []);
    client.listEvalJobs.mockResolvedValue({
      jobs: [
        job({
          id: 'job-1',
          status: 'completed',
          finishedAt: '2026-11-01T11:30:00.000Z',
          spec: {
            suiteId: 'core',
            scenarioIds: ['tictactoe'],
            count: 1,
            targets: [{ provider: 'llama-cpp', modelId: 'qwen3.5-4b-q4' }],
          },
        }),
        job({ id: 'job-2', status: 'running' }),
      ],
    });
    const lines = await renderResults(client, catalog, 20);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /2026-11-01 11:30\s+qwen3.5-4b-q4\s+core \(subset\)\s+1\/1 \(some tasks run once — count not rate\)/,
    );
    expect(lines[1]).toContain('not a suite score');
  });
});

describe('gezel bench submit', () => {
  const shard = {
    schemaVersion: 1,
    runs: [
      {
        id: '2026-11-01-r9700-qwen',
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
          count: 1,
          judgeModelId: null,
        },
        suites: ['core'],
        scenariosBySuite: { core: ['tictactoe'] },
      },
    ],
    results: [
      {
        modelId: 'qwen3.5-4b-q4',
        label: 'Qwen 3.5 (4B, Q4)',
        engine: 'llama-cpp',
        tier: 'small',
        runId: '2026-11-01-r9700-qwen',
        suiteId: 'core',
        cells: [{ scenarioId: 'tictactoe', trials: 1, successes: 1, nonModelFailures: 0 }],
      },
    ],
  };

  it('writes an issue through gh when it is installed', async () => {
    const out: string[] = [];
    const gh = vi.fn().mockResolvedValue('https://github.com/bendyline/gezel/issues/42\n');
    const result = await submitBench(
      'bench.json',
      { out: (l) => out.push(l), note: vi.fn() },
      { readFile: async () => JSON.stringify(shard), gh },
    );
    expect(result.issueUrl).toBe('https://github.com/bendyline/gezel/issues/42');
    expect(gh.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        'issue',
        'create',
        '--repo',
        'bendyline/gezel',
        '--label',
        'bench-result',
      ]),
    );
    const { title, body } = describeSubmission(shard as never);
    expect(title).toBe('Bench result: qwen3.5-4b-q4 (llama-cpp) on Linux · AMD Ryzen 9 7950X3D');
    expect(body).toContain('- core: 1/1');
    expect(body).toContain('"schemaVersion": 1');
  });

  // What execFile rejects with: the message repeats the command line, label and all.
  const ghFailure = (stderr: string) =>
    Object.assign(new Error(`Command failed: gh issue create --label bench-result\n${stderr}`), {
      stderr,
    });

  it('files the issue without the label when the repository has no such label', async () => {
    const out: string[] = [];
    const gh = vi
      .fn()
      .mockRejectedValueOnce(ghFailure("could not add label: 'bench-result' not found\n"))
      .mockResolvedValueOnce('https://github.com/bendyline/gezel/issues/43\n');
    const result = await submitBench(
      'bench.json',
      { out: (l) => out.push(l), note: vi.fn() },
      { readFile: async () => JSON.stringify(shard), gh },
    );
    expect(result.issueUrl).toBe('https://github.com/bendyline/gezel/issues/43');
    expect(out).toEqual(['Opened https://github.com/bendyline/gezel/issues/43']);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[0]?.[0]).toContain('--label');
    const retry = gh.mock.calls[1]?.[0] as string[];
    expect(retry).not.toContain('--label');
    expect(retry).not.toContain('bench-result');
    expect(retry).toEqual(expect.arrayContaining(['--title', result.title, '--body', result.body]));
  });

  it('does not retry other gh failures, and falls back once a retry fails too', async () => {
    const signedOut = vi
      .fn()
      .mockRejectedValue(ghFailure('To get started with GitHub CLI, please run:  gh auth login\n'));
    const first = await submitBench(
      'bench.json',
      { out: vi.fn(), note: vi.fn() },
      { readFile: async () => JSON.stringify(shard), gh: signedOut },
    );
    expect(first.issueUrl).toBeUndefined();
    expect(signedOut).toHaveBeenCalledTimes(1);

    const out: string[] = [];
    const stillFailing = vi
      .fn()
      .mockRejectedValueOnce(ghFailure("could not add label: 'bench-result' not found\n"))
      .mockRejectedValueOnce(ghFailure('HTTP 502: Bad Gateway\n'));
    const second = await submitBench(
      'bench.json',
      { out: (l) => out.push(l), note: vi.fn() },
      { readFile: async () => JSON.stringify(shard), gh: stillFailing },
    );
    expect(second.issueUrl).toBeUndefined();
    expect(stillFailing).toHaveBeenCalledTimes(2);
    expect(out[0]).toBe('Open this page and attach the file to the issue:');
  });

  it('falls back to the new-issue page when gh is missing, and rejects a non-shard', async () => {
    const out: string[] = [];
    const result = await submitBench(
      'bench.json',
      { out: (l) => out.push(l), note: vi.fn() },
      {
        readFile: async () => JSON.stringify(shard),
        gh: async () => {
          throw new Error('spawn gh ENOENT');
        },
      },
    );
    expect(result.issueUrl).toBeUndefined();
    expect(out.join('\n')).toContain('https://github.com/bendyline/gezel/issues/new?');
    await expect(
      submitBench(
        'x.json',
        { out: vi.fn(), note: vi.fn() },
        { readFile: async () => '{"nope":1}' },
      ),
    ).rejects.toThrow(/not a bench result file/);
  });
});

describe('gezel bench commands', () => {
  it('registers bench, list, results and submit', async () => {
    const client = fakeClient([], []);
    const out: string[] = [];
    const program = new Command().exitOverride();
    registerBenchCommands(program, async () => client as unknown as GezelClient, {
      out: (l) => out.push(l),
      note: vi.fn(),
    });
    await program.parseAsync(['node', 'gezel', 'bench', 'list']);
    expect(out.join('\n')).toContain('core ');
    expect(
      program.commands.find((c) => c.name() === 'bench')?.commands.map((c) => c.name()),
    ).toEqual(['list', 'results', 'submit']);
  });
});
