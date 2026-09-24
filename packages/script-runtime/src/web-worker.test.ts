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
  it('rejects an invalid deadline or an oversized source before spawning a worker', async () => {
    const createWorker = vi.fn();
    const executor = new WebWorkerScriptExecutor(createWorker);
    const { options } = fixture();
    await expect(executor.execute({ ...options, timeoutMs: 0 })).rejects.toThrow(/timeout/);
    await expect(executor.execute({ ...options, timeoutMs: 1.5 })).rejects.toThrow(/timeout/);
    await expect(executor.execute({ ...options, source: 'x'.repeat(1_000_001) })).rejects.toThrow(
      /too large/,
    );
    expect(createWorker).not.toHaveBeenCalled();
  });
  it('does not spawn a worker for an already-cancelled run', async () => {
    const createWorker = vi.fn();
    const { options } = fixture();
    const result = await new WebWorkerScriptExecutor(createWorker).execute({
      ...options,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toContain('cancelled');
    expect(createWorker).not.toHaveBeenCalled();
  });
  it('answers host requests and forwards notifications and stderr', async () => {
    const { worker, executor, options, send } = fixture();
    const run = executor.execute(options);
    expect(JSON.parse(worker.postMessage.mock.calls[0]![0])).toMatchObject({
      scriptName: 'example',
      timeoutMs: 500,
    });
    send({ runId: 'run', kind: 'started' });
    send({ runId: 'run', kind: 'request', id: 1, method: 'fs.read', params: { path: 'a' } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(options.onRequest).toHaveBeenCalledWith('fs.read', { path: 'a' });
    expect(JSON.parse(worker.postMessage.mock.calls[1]![0])).toEqual({
      runId: 'run',
      id: 1,
      result: 'value',
    });
    send({ runId: 'run', kind: 'notification', method: 'script.log', params: ['hi'] });
    send({ runId: 'run', kind: 'stderr', line: 'warning: careful' });
    send({ runId: 'run', kind: 'notification', method: 'script.output', params: { ok: true } });
    send({
      runId: 'run',
      kind: 'result',
      result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
    });
    expect((await run).exitCode).toBe(0);
    expect(options.onNotification).toHaveBeenNthCalledWith(1, 'script.log', ['hi']);
    expect(options.onNotification).toHaveBeenNthCalledWith(2, 'script.output', { ok: true });
    expect(options.onStderr).toHaveBeenCalledWith('warning: careful');
  });
  it('replies with the host error message and its string code', async () => {
    const { worker, executor, options, send } = fixture();
    options.onRequest = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const run = executor.execute(options);
    send({ runId: 'run', kind: 'request', id: 1, method: 'fs.write' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(JSON.parse(worker.postMessage.mock.calls[1]![0])).toEqual({
      runId: 'run',
      id: 1,
      error: { message: 'denied', code: 'EACCES' },
    });
    send({
      runId: 'run',
      kind: 'result',
      result: { exitCode: 1, stdout: '', stderr: 'denied', timedOut: false },
    });
    expect((await run).exitCode).toBe(1);
  });
  it.each([
    ['a non-string frame', 42],
    ['an unknown frame kind', JSON.stringify({ runId: 'run', kind: 'mystery' })],
    ['a non-string stderr line', JSON.stringify({ runId: 'run', kind: 'stderr', line: 7 })],
    [
      'a method name that is not a string',
      JSON.stringify({ runId: 'run', kind: 'request', id: 1, method: 7 }),
    ],
  ])('fails closed on %s', async (_label, data) => {
    const { worker, executor, options } = fixture();
    const run = executor.execute(options);
    worker.onmessage?.({ data } as MessageEvent<unknown>);
    expect((await run).exitCode).toBe(1);
    expect(options.onRequest).not.toHaveBeenCalled();
  });
  it('fails closed when the worker reuses a request id', async () => {
    const { executor, options, send } = fixture();
    options.onRequest = () => new Promise(() => {});
    const run = executor.execute(options);
    send({ runId: 'run', kind: 'request', id: 1, method: 'fs.read' });
    send({ runId: 'run', kind: 'request', id: 1, method: 'fs.read' });
    expect((await run).stderr).toMatch(/call limit/);
  });
  it('refuses output or a clean exit while host calls are still pending', async () => {
    for (const frame of [
      { runId: 'run', kind: 'notification', method: 'script.output', params: {} },
      {
        runId: 'run',
        kind: 'result',
        result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
      },
    ]) {
      const { executor, options, send } = fixture();
      options.onRequest = () => new Promise(() => {});
      const run = executor.execute(options);
      send({ runId: 'run', kind: 'request', id: 1, method: 'fs.read' });
      send(frame);
      expect((await run).stderr).toMatch(/pending host calls/);
    }
  });
  it('stops on worker error and message-deserialization events', async () => {
    const errored = fixture();
    const errorRun = errored.executor.execute(errored.options);
    const preventDefault = vi.fn();
    (errored.worker.onerror as unknown as (event: Partial<ErrorEvent>) => void)({
      message: 'worker crashed',
      preventDefault,
    });
    expect((await errorRun).stderr).toBe('worker crashed');
    expect(preventDefault).toHaveBeenCalled();

    const garbled = fixture();
    const garbledRun = garbled.executor.execute(garbled.options);
    (garbled.worker.onmessageerror as unknown as () => void)();
    expect((await garbledRun).stderr).toBe('Invalid script worker message');
  });
  it('fails the run when the worker cannot accept its instructions', async () => {
    const { worker, executor, options } = fixture();
    worker.postMessage.mockImplementation(() => {
      throw new Error('DataCloneError');
    });
    expect(await executor.execute(options)).toMatchObject({
      exitCode: 1,
      stderr: 'DataCloneError',
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

describe('a worker that never starts', () => {
  afterEach(() => {
    resetSuspendClockForTests();
    vi.useRealTimers();
  });

  it('fails on its own instead of waiting out the script deadline', async () => {
    // A worker the platform kills at spawn fires no error event anywhere: it
    // simply never speaks. Without the startup frame the host sat through the
    // whole budget for a run that never began.
    vi.useFakeTimers();
    const { executor, options, worker } = fixture();
    const running = executor.execute({ ...options, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await running;
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toMatch(/did not start/);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('stays quiet once the worker has spoken', async () => {
    vi.useFakeTimers();
    const { executor, options, send } = fixture();
    const running = executor.execute({ ...options, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(10);
    send({ runId: 'run', kind: 'started' });
    await vi.advanceTimersByTimeAsync(11_000);
    send({
      runId: 'run',
      kind: 'result',
      result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
    });
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });
});
