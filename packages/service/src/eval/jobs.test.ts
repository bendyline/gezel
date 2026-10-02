import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalJob, EvalJobSpec } from '@bendyline/gezel/eval';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalHarness } from './harness.js';
import { EvalJobManager, type EvalJobManagerOptions, harnessArgs } from './jobs.js';

/**
 * A stand-in harness that speaks the `--events` protocol. Behavior comes
 * from FAKE_MODE; it records its argv beside the target's run dir.
 */
const FAKE_HARNESS = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const runsDir = args[args.indexOf('--runs-dir') + 1];
mkdirSync(runsDir, { recursive: true });
writeFileSync(join(runsDir, 'argv.json'), JSON.stringify(args));
const emit = (e) => console.log('[eval-event] ' + JSON.stringify(e));
const mode = process.env.FAKE_MODE;
if (mode === 'setup-error') {
  console.error('[evals] fatal: Error: model not installed');
  for (let i = 0; i < 12; i++) console.error('    at frame' + i + ' (all.js:' + i + ')');
  console.error('}');
  process.exit(2);
}
if (mode === 'preflight') { console.log('[preflight] refused'); process.exit(3); }
emit({ type: 'plan', modelId: 'm', provider: 'mlx', scenarios: [{ scenarioId: 's', trials: 2 }], totalTrials: 2 });
emit({ type: 'preflight', admitted: true, decodeTokensPerSec: 21.5 });
const start = (n) => emit({ type: 'trial-start', scenarioId: 's', trialId: 't' + n, runDir: join(runsDir, 't' + n), trialIndex: n, totalTrials: 2, startedAt: new Date().toISOString() });
const end = (n, success) => emit({ type: 'trial-end', scenarioId: 's', trialId: 't' + n, runDir: join(runsDir, 't' + n), success, reason: success ? 'ok' : 'nope', failureClass: success ? 'pass' : 'model', durationMs: 5, composite: success ? 9 : 3 });
if (mode === 'hang') {
  start(1);
  console.log('[trial] working');
  process.on('SIGTERM', () => { console.log('[trial] interrupted'); process.exit(130); });
  setInterval(() => {}, 1000);
} else {
  start(1); console.log('[trial] a human log line'); end(1, true);
  start(2); end(2, false);
  emit({ type: 'matrix-end', status: 'complete', totalTrials: 2, totalSuccesses: 1 });
  process.exit(1);
}
`;

const SPEC: EvalJobSpec = {
  suiteId: 'smoke',
  count: 1,
  targets: [{ provider: 'mlx', modelId: 'qwen3.5-4b-q4' }],
};

function waitFor(
  manager: EvalJobManager,
  id: string,
  done: (job: EvalJob) => boolean,
  timeoutMs = 20_000,
): Promise<EvalJob> {
  const started = Date.now();
  return new Promise((resolveJob, rejectJob) => {
    const tick = async () => {
      const job = await manager.get(id);
      if (job && done(job)) return resolveJob(job);
      if (Date.now() - started > timeoutMs) {
        return rejectJob(new Error(`timed out; last status ${job?.status}`));
      }
      setTimeout(tick, 50);
    };
    void tick();
  });
}

const terminal = (job: EvalJob) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status);

/**
 * The live record turns terminal before its final write lands, so a read
 * straight after `waitFor` can see the previous write on a slow runner.
 */
async function waitForPersisted(
  dir: string,
  status: EvalJob['status'],
  timeoutMs = 5_000,
): Promise<EvalJob> {
  const started = Date.now();
  for (;;) {
    const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as EvalJob;
    if (job.status === status || Date.now() - started > timeoutMs) return job;
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

describe('EvalJobManager', () => {
  let root: string;
  let script: string;
  let history: Array<{ kind: string; details?: Record<string, unknown> }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gezel-eval-jobs-'));
    script = join(root, 'fake-harness.cjs');
    writeFileSync(script, FAKE_HARNESS);
    history = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manager(mode: string, overrides: Partial<EvalJobManagerOptions> = {}): EvalJobManager {
    const harness: EvalHarness = {
      mode: 'compiled',
      launch: (_command, args) => ({
        command: process.execPath,
        args: [script, ...args],
        cwd: root,
        env: {},
      }),
    };
    return new EvalJobManager({
      runsDir: join(root, 'eval-runs'),
      harness: () => harness,
      prepareTarget: async () => ({
        args: ['--source-home', '/home/u/.gezel'],
        env: { FAKE_MODE: mode },
        needsDevice: false,
      }),
      history: {
        log: async (entry) => {
          history.push(entry);
        },
      },
      stopGraceMs: 2_000,
      devicePollMs: 20,
      ...overrides,
    });
  }

  it('runs a target to completion from the event channel and persists the record', async () => {
    const jobs = manager('ok');
    const created = await jobs.create(SPEC);
    expect(created.status).toBe('queued');
    const job = await waitFor(jobs, created.id, terminal);

    expect(job.status).toBe('completed');
    const target = job.targets[0];
    expect(target).toMatchObject({
      status: 'completed',
      plannedTrials: 2,
      completedTrials: 2,
      passedTrials: 1,
      preflight: { admitted: true, decodeTokensPerSec: 21.5 },
    });
    expect(target?.currentTrial).toBeUndefined();

    const argv = JSON.parse(readFileSync(join(target?.runDir ?? '', 'argv.json'), 'utf8'));
    expect(argv).toEqual(
      expect.arrayContaining(['--suite', 'smoke', '--events', '--write-reports']),
    );
    expect(argv).toEqual(expect.arrayContaining(['--source-home', '/home/u/.gezel']));

    const persisted = await waitForPersisted(job.dir, 'completed');
    expect(persisted.status).toBe('completed');
    expect(readFileSync(join(job.dir, 'harness.log'), 'utf8')).toContain('a human log line');
    expect(history.map((h) => h.kind)).toEqual([
      'eval.trial.started',
      'eval.trial.completed',
      'eval.trial.started',
      'eval.trial.completed',
    ]);
    expect(history[1]?.details).toMatchObject({ success: true, composite: 9, jobId: job.id });
  });

  it('streams a snapshot, then human log lines without the raw event lines', async () => {
    const jobs = manager('ok');
    const created = await jobs.create(SPEC);
    const lines: string[] = [];
    const statuses: string[] = [];
    jobs.subscribe(created.id, (event) => {
      if (event.type === 'log') lines.push(event.line);
      else statuses.push(event.job.status);
    });
    await waitFor(jobs, created.id, terminal);
    expect(lines).toContain('[trial] a human log line');
    expect(lines.some((line) => line.includes('[eval-event]'))).toBe(false);
    expect(statuses.at(-1)).toBe('completed');
  });

  it('names a preflight refusal instead of reporting a bare exit code', async () => {
    const jobs = manager('preflight');
    const job = await waitFor(jobs, (await jobs.create(SPEC)).id, terminal);
    expect(job.status).toBe('failed');
    expect(job.targets[0]?.error).toMatch(/preflight check refused/);
  });

  it('surfaces the harness’s own error line for a setup failure', async () => {
    const jobs = manager('setup-error');
    const job = await waitFor(jobs, (await jobs.create(SPEC)).id, terminal);
    expect(job.status).toBe('failed');
    expect(job.targets[0]?.error).toBe('model not installed');
  });

  it('fails a target the service cannot prepare, and still runs the next one', async () => {
    let calls = 0;
    const jobs = manager('ok', {
      prepareTarget: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Add an Anthropic API key in Settings first.');
        return { args: [], env: { FAKE_MODE: 'ok' }, needsDevice: false };
      },
    });
    const job = await waitFor(
      jobs,
      (
        await jobs.create({
          ...SPEC,
          targets: [
            { provider: 'anthropic', modelId: 'claude' },
            { provider: 'mlx', modelId: 'qwen3.5-4b-q4' },
          ],
        })
      ).id,
      terminal,
    );
    expect(job.targets.map((t) => t.status)).toEqual(['failed', 'completed']);
    expect(job.targets[0]?.error).toBe('Add an Anthropic API key in Settings first.');
    expect(job.status).toBe('completed');
  });

  it('stops a running harness on cancel and records the job as cancelled', async () => {
    const jobs = manager('hang');
    const created = await jobs.create(SPEC);
    await waitFor(jobs, created.id, (job) => job.targets[0]?.currentTrial !== undefined);
    expect(jobs.liveTrialIds()).toEqual(new Set(['t1']));
    await jobs.cancel(created.id);
    const job = await waitFor(jobs, created.id, terminal);
    expect(job.status).toBe('cancelled');
    expect(job.targets[0]?.status).toBe('cancelled');
    expect(jobs.liveTrialIds().size).toBe(0);
  });

  it('runs one job at a time and cancels a queued one without starting it', async () => {
    const jobs = manager('hang');
    const first = await jobs.create(SPEC);
    const second = await jobs.create(SPEC);
    await waitFor(jobs, first.id, (job) => job.status === 'running');
    expect((await jobs.get(second.id))?.status).toBe('queued');
    const cancelled = await jobs.cancel(second.id);
    expect(cancelled?.status).toBe('cancelled');
    await jobs.cancel(first.id);
    await waitFor(jobs, first.id, terminal);
    expect(existsSync(join(second.dir, '01-mlx-qwen3.5-4b-q4', 'argv.json'))).toBe(false);
  });

  it('waits while another eval holds the device, then runs', async () => {
    let holder: string | null = 'another eval (pid 42)';
    const jobs = manager('ok', {
      prepareTarget: async () => ({ args: [], env: { FAKE_MODE: 'ok' }, needsDevice: true }),
      deviceLockHolder: () => holder,
    });
    const created = await jobs.create(SPEC);
    const waiting = await waitFor(jobs, created.id, (job) => job.status === 'waiting-for-device');
    expect(waiting.waitingOn).toBe('another eval (pid 42)');
    holder = null;
    const job = await waitFor(jobs, created.id, terminal);
    expect(job.status).toBe('completed');
    expect(job.waitingOn).toBeUndefined();
  });

  it('marks a job that was running when the daemon stopped as interrupted', async () => {
    const runsDir = join(root, 'eval-runs');
    const dir = join(runsDir, 'jobs', 'j1');
    await mkdir(dir, { recursive: true });
    const stale: EvalJob = {
      id: 'j1',
      spec: SPEC,
      status: 'running',
      createdAt: '2026-09-29T00:00:00.000Z',
      harness: 'compiled',
      dir,
      targets: [
        {
          provider: 'mlx',
          modelId: 'm',
          status: 'running',
          runDir: join(dir, '01'),
          completedTrials: 1,
          passedTrials: 1,
          currentTrial: {
            scenarioId: 's',
            trialId: 't2',
            trialIndex: 2,
            startedAt: '2026-09-29T00:01:00.000Z',
          },
        },
      ],
    };
    await writeFile(join(dir, 'job.json'), JSON.stringify(stale));
    const jobs = manager('ok');
    const [job] = await jobs.list();
    expect(job?.status).toBe('interrupted');
    expect(job?.targets[0]?.status).toBe('interrupted');
    expect(job?.targets[0]?.currentTrial).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')).status).toBe('interrupted');
  });
});

describe('harnessArgs', () => {
  it('maps a job spec to eval:all flags for one target', () => {
    const args = harnessArgs(
      {
        suiteId: 'core',
        scenarioIds: ['tictactoe', 'petshop'],
        count: 3,
        countStrict: true,
        targets: [{ provider: 'llama-cpp', modelId: 'gemma4-e4b-q4' }],
        imageModelId: 'sdxl-lightning-4step',
        generalistMode: 'off',
        timeoutMs: 600_000,
        skipPreflight: true,
      },
      {
        provider: 'llama-cpp',
        modelId: 'gemma4-e4b-q4',
        status: 'pending',
        runDir: '/runs/01',
        completedTrials: 0,
        passedTrials: 0,
      },
    );
    expect(args).toEqual([
      '--suite',
      'core',
      '--scenarios',
      'tictactoe,petshop',
      '--count',
      '3',
      '--count-strict',
      '--provider',
      'llama-cpp',
      '--model',
      'gemma4-e4b-q4',
      '--runs-dir',
      '/runs/01',
      '--write-reports',
      '--events',
      '--image-model',
      'sdxl-lightning-4step',
      '--generalist',
      'off',
      '--timeout',
      '600000',
      '--skip-preflight',
    ]);
  });
});
