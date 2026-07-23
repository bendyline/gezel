import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isEvalNativeGpuProcessText,
  isSuccessfulBatch,
  isSuccessfulMatrix,
  parseGpuComputeApps,
  runBatch,
  runMatrix,
} from './batch.ts';
import { runTrial } from './runner.ts';
import type { EvalScenario, TrialResult } from './types.ts';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.find(
      (arg): arg is (error: Error | null, stdout?: string, stderr?: string) => void =>
        typeof arg === 'function',
    );
    callback?.(new Error('nvidia-smi unavailable'), '', '');
  }),
}));

vi.mock('./runner.ts', () => ({
  runTrial: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const runTrialMock = vi.mocked(runTrial);

const scenario = (id: string): EvalScenario => ({
  id,
  description: id,
  prompt: id,
  successCheck: async () => ({ done: false }),
});

const trialResult = (scenarioId: string, overrides: Partial<TrialResult> = {}): TrialResult => ({
  trialId: `${scenarioId}-trial`,
  scenarioId,
  modelId: 'gemma4-e4b-q8',
  startedAt: '2026-06-03T00:00:00.000Z',
  finishedAt: '2026-06-03T00:00:01.000Z',
  durationMs: 1000,
  success: false,
  reason: 'interrupted (SIGINT/SIGTERM); cleanup ran',
  failureMode: 'interrupted',
  runDir: '',
  ...overrides,
});

/** A daemon-boot spawn timeout: the exact infra flake §9.1 fixes. */
const spawnTimeout = (scenarioId: string): TrialResult =>
  trialResult(scenarioId, {
    success: false,
    failureMode: 'spawn-error',
    reason: 'daemon spawn failed: Timed out after 120000ms waiting for gezeld to start.',
  });

/**
 * A model-class deterministic failure (non-null `trialSignature`). Unlike
 * the default `trialResult` (which is `interrupted`/operator → null and so
 * never clusters), these form a triage streak.
 */
const modelFail = (scenarioId: string, o: Partial<TrialResult> = {}): TrialResult =>
  trialResult(scenarioId, {
    success: false,
    failureMode: 'no-progress',
    reason: 'no real progress',
    failureClass: 'model',
    failureClassRule: 'model-default',
    finalSniff: {
      key: `${scenarioId}.html:sniff`,
      score: 3,
      bytes: 900,
      failReason: 'inline JS is only 342 bytes',
    },
    ...o,
  });

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-evals-batch-test-'));
  execFileMock.mockClear();
  runTrialMock.mockReset();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('batch abort handling', () => {
  it('treats a pre-aborted zero-trial batch as non-passing', async () => {
    const ac = new AbortController();
    ac.abort();

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(runTrialMock).not.toHaveBeenCalled();
    expect(summary.trials).toBe(0);
    expect(summary.successes).toBe(0);
    expect(summary.status).toBe('interrupted');
    expect(summary.requestedTrials).toBe(1);
    expect(isSuccessfulBatch(summary)).toBe(false);
  });

  it('does not start another trial after the signal aborts', async () => {
    const ac = new AbortController();
    runTrialMock.mockImplementation(async (s) => {
      ac.abort();
      return trialResult(s.id);
    });

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 3,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(1);
    expect(summary.trials).toBe(1);
    expect(summary.perTrial[0]?.failureMode).toBe('interrupted');
    expect(summary.status).toBe('interrupted');
  });

  it('does not treat an all-pass prefix from an aborted batch as passing', async () => {
    const ac = new AbortController();
    runTrialMock.mockImplementation(async (s) => {
      ac.abort();
      return trialResult(s.id, { success: true, failureMode: undefined, reason: 'passed' });
    });

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 2,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(summary.trials).toBe(1);
    expect(summary.successes).toBe(1);
    expect(summary.status).toBe('interrupted');
    expect(isSuccessfulBatch(summary)).toBe(false);
  });

  it('does not treat an all-pass prefix after an unexpected rejection as passing', async () => {
    runTrialMock
      .mockResolvedValueOnce(
        trialResult('tictactoe', { success: true, failureMode: undefined, reason: 'passed' }),
      )
      .mockRejectedValueOnce(new Error('unexpected runner rejection'));

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 2,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(summary.trials).toBe(1);
    expect(summary.successes).toBe(1);
    expect(summary.status).toBe('incomplete');
    expect(isSuccessfulBatch(summary)).toBe(false);
  });

  it('accepts a non-empty all-pass batch', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined, reason: 'passed' }),
    );

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 2,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(summary.trials).toBe(2);
    expect(summary.successes).toBe(2);
    expect(summary.status).toBe('complete');
    expect(isSuccessfulBatch(summary)).toBe(true);
  });

  it('does not start another scenario after the signal aborts', async () => {
    const ac = new AbortController();
    runTrialMock.mockImplementation(async (s) => {
      ac.abort();
      return trialResult(s.id, { success: true, failureMode: undefined, reason: 'passed' });
    });

    const summary = await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(1);
    expect(summary.scenarios.map((s) => s.scenarioId)).toEqual(['tictactoe']);
    expect(summary.totalTrials).toBe(1);
    // The completed prefix is 1/1, but the requested matrix was 2
    // scenarios. It must never look green merely because 1 === 1.
    expect(summary.totalSuccesses).toBe(summary.totalTrials);
    expect(summary.status).toBe('interrupted');
    expect(summary.requestedScenarios).toEqual([
      { scenarioId: 'tictactoe', trials: 1 },
      { scenarioId: 'petshop', trials: 1 },
    ]);
    expect(isSuccessfulMatrix(summary)).toBe(false);

    const persisted = JSON.parse(await readFile(join(tempRoot, 'summary.json'), 'utf8'));
    expect(persisted.status).toBe('interrupted');
    expect(persisted.requestedScenarios).toEqual(summary.requestedScenarios);
  });

  it('marks a pre-aborted zero-trial matrix interrupted and non-passing', async () => {
    const ac = new AbortController();
    ac.abort();

    const summary = await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(runTrialMock).not.toHaveBeenCalled();
    expect(summary.status).toBe('interrupted');
    expect(summary.totalTrials).toBe(0);
    expect(summary.totalSuccesses).toBe(0);
    expect(summary.scenarios).toEqual([]);
    expect(summary.requestedScenarios.map((entry) => entry.scenarioId)).toEqual([
      'tictactoe',
      'petshop',
    ]);
    expect(isSuccessfulMatrix(summary)).toBe(false);
  });

  it('marks an unexpectedly short all-pass cell incomplete', async () => {
    runTrialMock
      .mockResolvedValueOnce(
        trialResult('tictactoe', { success: true, failureMode: undefined, reason: 'passed' }),
      )
      .mockRejectedValueOnce(new Error('unexpected runner rejection'));

    const summary = await runMatrix([scenario('tictactoe')], {
      modelId: 'gemma4-e4b-q8',
      count: 2,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(summary.totalTrials).toBe(1);
    expect(summary.totalSuccesses).toBe(1);
    expect(summary.status).toBe('incomplete');
    expect(isSuccessfulMatrix(summary)).toBe(false);
  });

  it('accepts a fully covered all-pass matrix', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined, reason: 'passed' }),
    );

    const summary = await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      engine: 'codex-cli',
      modelId: 'gpt-5.5',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(summary.status).toBe('complete');
    expect(isSuccessfulMatrix(summary)).toBe(true);
  });
});

describe('daemon-spawn timeout retry', () => {
  // Drop the inter-attempt settle so the retry path runs instantly.
  beforeEach(() => {
    process.env.GEZEL_EVAL_SPAWN_RETRY_SETTLE_MS = '0';
  });
  afterEach(() => {
    delete process.env.GEZEL_EVAL_SPAWN_RETRY_SETTLE_MS;
  });

  it('retries a daemon-spawn timeout once and records the retry result', async () => {
    runTrialMock
      .mockResolvedValueOnce(spawnTimeout('petshop'))
      .mockResolvedValueOnce(trialResult('petshop', { success: true, failureMode: undefined }));

    const summary = await runBatch(scenario('petshop'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(2);
    expect(summary.trials).toBe(1);
    expect(summary.successes).toBe(1);
    expect(summary.perTrial[0]?.success).toBe(true);
  });

  it('records the failure when the retry also spawn-times-out (only one retry)', async () => {
    runTrialMock.mockResolvedValue(spawnTimeout('tankcombat'));

    const summary = await runBatch(scenario('tankcombat'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(2);
    expect(summary.trials).toBe(1);
    expect(summary.successes).toBe(0);
    expect(summary.perTrial[0]?.failureMode).toBe('spawn-error');
  });

  it('does not retry a non-spawn failure (e.g. capability)', async () => {
    runTrialMock.mockResolvedValue(
      trialResult('tictactoe', { failureMode: 'success-check-false', reason: 'no artifact' }),
    );

    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(1);
    expect(summary.perTrial[0]?.failureMode).toBe('success-check-false');
  });

  it('does not retry a deterministic spawn-error (auth/binary/warm)', async () => {
    runTrialMock.mockResolvedValue(
      trialResult('tictactoe', {
        failureMode: 'spawn-error',
        reason: 'model warm failed: no valid manifest+weights',
      }),
    );

    await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(1);
  });

  it('does not start the retry after the signal aborts', async () => {
    const ac = new AbortController();
    runTrialMock.mockImplementation(async (s) => {
      ac.abort();
      return spawnTimeout(s.id);
    });

    const summary = await runBatch(scenario('petshop'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      signal: ac.signal,
      skipPreflight: true,
    });

    expect(runTrialMock).toHaveBeenCalledTimes(1);
    expect(summary.perTrial[0]?.failureMode).toBe('spawn-error');
  });
});

describe('batch auto-triage (E2)', () => {
  const base = { modelId: 'gemma4-e4b-q8', skipPreflight: true as const };

  it('stops a cell after exactly k identical failures and surfaces the cluster', async () => {
    runTrialMock.mockImplementation(async (s) => modelFail(s.id, { trialId: `${s.id}-x` }));
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 10,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(3);
    expect(summary.trials).toBe(3);
    expect(summary.triage).toBeDefined();
    expect(summary.triage!.count).toBe(3);
    expect(summary.triage!.stopped).toBe(true);
    expect(summary.triage!.skipped).toBe(7);
    expect(summary.triage!.trialIds).toHaveLength(3);
    expect(summary.triage!.signature).toMatch(/^model\/model-default#/);
  });

  it('still clusters across byte-churn (digit-blinded)', async () => {
    let n = 0;
    runTrialMock.mockImplementation(async (s) =>
      modelFail(s.id, {
        finalSniff: {
          key: `${s.id}.html:sniff`,
          score: 3,
          bytes: 300 + n,
          failReason: `inline JS is only ${300 + n++} bytes`,
        },
      }),
    );
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 10,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(3);
    expect(summary.triage).toBeDefined();
  });

  it('a changed signature resets the streak — no early stop', async () => {
    const keys = ['missing grid', 'missing click', 'missing grid', 'missing click'];
    let i = 0;
    runTrialMock.mockImplementation(async (s) =>
      modelFail(s.id, {
        finalSniff: { key: `${s.id}:sniff`, score: 3, bytes: 900, failReason: keys[i++]! },
      }),
    );
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 4,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(4);
    expect(summary.triage).toBeUndefined();
  });

  it('a pass breaks the run', async () => {
    let i = 0;
    const outcomes = ['fail', 'fail', 'pass', 'fail', 'fail'];
    runTrialMock.mockImplementation(async (s) => {
      const o = outcomes[i++];
      return o === 'pass'
        ? trialResult(s.id, { success: true, failureMode: undefined })
        : modelFail(s.id);
    });
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 5,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(5);
    expect(summary.triage).toBeUndefined();
  });

  it('passes never cluster', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined }),
    );
    const summary = await runBatch(scenario('tictactoe'), {
      ...base,
      count: 5,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(5);
    expect(summary.triage).toBeUndefined();
  });

  it('does not stop when k is not reached', async () => {
    runTrialMock.mockImplementation(async (s) => modelFail(s.id));
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 2,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(2);
    expect(summary.triage).toBeUndefined();
  });

  it('the matrix continues to the next scenario after a cell is triaged', async () => {
    runTrialMock.mockImplementation(async (s) =>
      s.id === 'bookstore-openapi'
        ? modelFail(s.id)
        : trialResult(s.id, { success: true, failureMode: undefined }),
    );
    const summary = await runMatrix([scenario('bookstore-openapi'), scenario('petshop')], {
      ...base,
      count: 5,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(8); // 3 (triaged) + 5 (petshop)
    const bookstore = summary.scenarios.find((s) => s.scenarioId === 'bookstore-openapi');
    const petshop = summary.scenarios.find((s) => s.scenarioId === 'petshop');
    expect(bookstore?.trials).toBe(3);
    expect(bookstore?.triage).toBeDefined();
    expect(petshop?.trials).toBe(5);
    expect(petshop?.triage).toBeUndefined();
  });

  it('a repeated deterministic infra failure also triggers (worth stopping for)', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, {
        success: false,
        failureMode: 'spawn-error',
        failureClass: 'infra',
        failureClassRule: 'spawn-error',
        reason: 'model warm failed: no valid manifest+weights',
      }),
    );
    const summary = await runBatch(scenario('tictactoe'), {
      ...base,
      count: 6,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(3);
    expect(summary.triage?.signature).toBe('infra/spawn-error');
  });

  it('operator interrupts never cluster (even without an abort signal)', async () => {
    runTrialMock.mockImplementation(async (s) => trialResult(s.id)); // default: interrupted/operator
    const summary = await runBatch(scenario('tictactoe'), {
      ...base,
      count: 5,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(5);
    expect(summary.triage).toBeUndefined();
  });

  it('parallel>1 reports the cluster but does not early-stop', async () => {
    runTrialMock.mockImplementation(async (s) => modelFail(s.id));
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 6,
      parallel: 2,
      triageK: 3,
      runsDir: tempRoot,
    });
    expect(runTrialMock).toHaveBeenCalledTimes(6);
    expect(summary.triage).toBeDefined();
    expect(summary.triage!.stopped).toBe(false);
    expect(summary.triage!.skipped).toBe(0);
  });

  it('abort precedence: an operator abort stops before the triage break', async () => {
    const ac = new AbortController();
    let i = 0;
    runTrialMock.mockImplementation(async (s) => {
      if (++i === 2) ac.abort();
      return modelFail(s.id);
    });
    const summary = await runBatch(scenario('bookstore-openapi'), {
      ...base,
      count: 10,
      triageK: 2,
      runsDir: tempRoot,
      signal: ac.signal,
    });
    // Trial 2 aborts; the abort check precedes the triage break, so we
    // stop at 2 even though the streak has already reached k=2.
    expect(runTrialMock).toHaveBeenCalledTimes(2);
    expect(summary.trials).toBe(2);
  });

  it('GEZEL_EVAL_TRIAGE_K=0 disables triage', async () => {
    process.env.GEZEL_EVAL_TRIAGE_K = '0';
    try {
      runTrialMock.mockImplementation(async (s) => modelFail(s.id));
      const summary = await runBatch(scenario('bookstore-openapi'), {
        ...base,
        count: 5,
        runsDir: tempRoot,
      });
      expect(runTrialMock).toHaveBeenCalledTimes(5);
      expect(summary.triage).toBeUndefined();
    } finally {
      delete process.env.GEZEL_EVAL_TRIAGE_K;
    }
  });
});

describe('preflight provenance (E4)', () => {
  it('records skippedReason=flag when --skip-preflight is set', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined }),
    );
    const summary = await runBatch(scenario('tictactoe'), {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });
    expect(summary.preflight).toEqual({ ran: false, skippedReason: 'flag' });
  });

  it('records skippedReason=non-local-engine for cloud/CLI engines', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined }),
    );
    const summary = await runBatch(scenario('tictactoe'), {
      engine: 'codex-cli',
      modelId: 'gpt-5.5',
      count: 1,
      runsDir: tempRoot,
    });
    expect(summary.preflight).toEqual({ ran: false, skippedReason: 'non-local-engine' });
  });

  it('carries the matrix model preflight onto the matrix summary', async () => {
    runTrialMock.mockImplementation(async (s) =>
      trialResult(s.id, { success: true, failureMode: undefined }),
    );
    const summary = await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      engine: 'codex-cli',
      modelId: 'gpt-5.5',
      count: 1,
      runsDir: tempRoot,
    });
    expect(summary.preflight).toEqual({ ran: false, skippedReason: 'non-local-engine' });
  });
});

describe('matrix GPU settle', () => {
  it('distinguishes eval-native GPU processes from persistent desktop GPU clients', () => {
    expect(
      parseGpuComputeApps('12329, /opt/warpdotdev/warp-terminal/warp\n456, llama-server\n'),
    ).toEqual([
      { pid: '12329', processName: '/opt/warpdotdev/warp-terminal/warp' },
      { pid: '456', processName: 'llama-server' },
    ]);
    expect(isEvalNativeGpuProcessText('/opt/warpdotdev/warp-terminal/warp --finish-update')).toBe(
      false,
    );
    expect(
      isEvalNativeGpuProcessText(
        '/home/dev/gh/gezel/native/build/linux-arm64-cuda/llama-server --model gemma.gguf',
      ),
    ).toBe(true);
    expect(
      isEvalNativeGpuProcessText('/home/dev/gh/gezel/native/build/linux-arm64/sd-server'),
    ).toBe(true);
    expect(isEvalNativeGpuProcessText('C:\\gezel\\gezel-llama-server.exe --model qwen.gguf')).toBe(
      true,
    );
    expect(isEvalNativeGpuProcessText('/opt/gezel/ds4-server --model deepseek.gguf')).toBe(true);
  });

  it('waits for GPU memory between local-engine scenarios', async () => {
    runTrialMock.mockImplementation(async (s) => trialResult(s.id));

    await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      modelId: 'gemma4-e4b-q8',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    const commands = execFileMock.mock.calls.map(([command]) => command);
    expect(commands).toContain('nvidia-smi');
    expect(commands).toContain('amd-smi');
    expect(commands).toContain('rocm-smi');
  });

  it('skips GPU memory waits for non-local providers', async () => {
    runTrialMock.mockImplementation(async (s) => trialResult(s.id));

    await runMatrix([scenario('tictactoe'), scenario('petshop')], {
      engine: 'codex-cli',
      modelId: 'gpt-5.5',
      count: 1,
      runsDir: tempRoot,
      skipPreflight: true,
    });

    expect(execFileMock).not.toHaveBeenCalled();
  });
});
