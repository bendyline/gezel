import { isSuspendMonitorRunning, resetSuspendClockForTests } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionOptions } from './index.js';
import { WebWorkerScriptExecutor } from './web-worker.js';

function fixture() {
  const worker = {
    onmessage: null as null | ((event: MessageEvent<unknown>) => void),
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn<(value: string) => void>(),
    terminate: vi.fn(),
  };
  const options: ScriptExecutionOptions = {
    source: '',
    scriptName: 'example',
    timeoutMs: 500,
    init: {
      input: {},
      projectId: 'default',
      runId: 'run',
      engagementMode: 'off',
      engagementFlags: { llmAllowed: false },
    },
    provenanceTrusted: false,
    trustedReadOnlyStandard: false,
    onRequest: vi.fn(async () => 'value'),
    onNotification: vi.fn(),
    onStdout: vi.fn(),
    onStderr: vi.fn(),
  };
  const send = (frame: unknown) =>
    worker.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<unknown>);
  return {
    worker,
    options,
    send,
    executor: new WebWorkerScriptExecutor(() => worker as unknown as Worker),
  };
}

describe('Web Worker script boundary', () => {
  afterEach(() => {
    resetSuspendClockForTests();
    vi.useRealTimers();
  });
  it('credits browser sleep while preserving immediate explicit background cancellation', async () => {
    vi.useFakeTimers();
    const { worker, executor, options } = fixture();
    const controller = new AbortController();
    const running = executor.execute({ ...options, timeoutMs: 10_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    controller.abort();
    expect((await running).stderr).toContain('cancelled');
    expect(isSuspendMonitorRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('still expires after the remaining awake budget is consumed', async () => {
    vi.useFakeTimers();
    const { worker, executor, options } = fixture();
    const running = executor.execute({ ...options, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toMatchObject({ timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('terminates on success and forwards no later callbacks', async () => {
    const { worker, executor, options, send } = fixture();
    const run = executor.execute(options);
    send({
      runId: 'run',
      kind: 'result',
      result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
    });
    expect((await run).exitCode).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    send({ runId: 'run', kind: 'request', id: 1, method: 'artifact.write' });
    expect(options.onRequest).not.toHaveBeenCalled();
  });
  it.each([
    { runId: 'wrong', kind: 'request', id: 1, method: 'fs.read' },
    { runId: 'run', kind: 'request', id: -1, method: 'fs.read' },
    { runId: 'run', kind: 'notification', method: 'artifact.write' },
    { runId: 'run', kind: 'result', result: { exitCode: 0 } },
  ])('fails closed on malformed worker messages %s', async (frame) => {
    const { worker, executor, options, send } = fixture();
    const run = executor.execute(options);
    send(frame);
    expect((await run).exitCode).toBe(1);
    expect(options.onRequest).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('uses a host deadline even if the worker never responds', async () => {
    const { worker, executor, options } = fixture();
    expect(await executor.execute({ ...options, timeoutMs: 15 })).toMatchObject({
      exitCode: 1,
      timedOut: true,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('cancels pending host work without posting late replies', async () => {
    const { worker, executor, options, send } = fixture();
    const controller = new AbortController();
    let complete!: (value: string) => void;
    options.onRequest = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const run = executor.execute({ ...options, signal: controller.signal });
    send({ runId: 'run', kind: 'request', id: 1, method: 'fs.read' });
    controller.abort();
    expect((await run).stderr).toContain('cancelled');
    complete('late');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });
});
