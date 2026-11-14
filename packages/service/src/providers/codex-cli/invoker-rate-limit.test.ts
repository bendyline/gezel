/** Codex CLI turns that the model service throttles (HTTP 429).
 * Codex retries a 429 itself and reports each retry as an `error` event; the
 * invoker must hold the turn budget through those waits, and reject a turn
 * that still fails with ProviderRateLimitError. No model calls occur.
 */
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resetSuspendClockForTests, startSuspendMonitor } from '@bendyline/gezel';
import { isProviderRateLimitError } from '@bendyline/gezel/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodexTurn } from './invoker.js';
import { codexRateLimitSignal } from './rate-limit.js';

const RETRY_2 = 'Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)';
const RETRY_3 = 'Reconnecting... 3/5 (exceeded retry limit, last status: 429 Too Many Requests)';
const GAVE_UP = 'exceeded retry limit, last status: 429 Too Many Requests';

beforeEach(() => {
  vi.useFakeTimers();
  resetSuspendClockForTests();
  startSuspendMonitor();
});
afterEach(() => {
  resetSuspendClockForTests();
  vi.useRealTimers();
});

function invocation(timeoutMs = 180_000) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const hooks = {
    emitDelta: vi.fn(),
    emitIntent: vi.fn(),
    emitHeartbeat: vi.fn(),
    emitUsage: vi.fn(),
    emitWarning: vi.fn(),
    onThreadStarted: vi.fn(),
    onRateLimited: vi.fn(),
  };
  const promise = runCodexTurn({
    binaryPath: 'codex',
    cwd: '.',
    codexHome: '.',
    baseEnv: {},
    model: 'gpt-6-luna',
    permissionMode: 'edit',
    prompt: 'Inspect this image',
    timeoutMs,
    spawnImpl: (() => child as unknown as ChildProcess) as typeof spawn,
    hooks,
  });
  const outcome = promise.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error }),
  );
  const event = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const start = () => {
    event({ type: 'thread.started', thread_id: 'throttled-thread' });
    event({ type: 'turn.started' });
  };
  const answer = (text: string) => {
    event({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text } });
    event({ type: 'turn.completed', usage: {} });
    child.emit('close', 0);
  };
  return { child, hooks, outcome, event, start, answer };
}

describe('codexRateLimitSignal', () => {
  it('reads a retry report, a final refusal, and nothing else', () => {
    expect(codexRateLimitSignal(RETRY_2)).toEqual({ retrying: true, attempt: 2, maxAttempts: 5 });
    expect(codexRateLimitSignal(GAVE_UP)).toEqual({ retrying: false });
    expect(codexRateLimitSignal('stream disconnected before completion')).toBeNull();
    expect(codexRateLimitSignal('Reconnecting... 1/5 (connection reset)')).toBeNull();
    // A spent allowance is the quota path's, not a wait-a-minute signal.
    expect(
      codexRateLimitSignal("429 Too Many Requests: You've hit your usage limit. Try again later."),
    ).toBeNull();
  });
});

describe('Codex turns throttled by the model service', () => {
  it('holds the turn budget while Codex waits out 429s, then completes', async () => {
    const run = invocation(180_000);
    run.start();
    run.event({ type: 'error', message: RETRY_2 });
    await vi.advanceTimersByTimeAsync(170_000);
    run.event({ type: 'error', message: RETRY_3 });
    await vi.advanceTimersByTimeAsync(170_000);
    run.answer('ready');

    const { value, error } = await run.outcome;
    expect(error).toBeUndefined();
    expect(value).toBe('ready');
    expect(run.child.kill).not.toHaveBeenCalled();
    expect(run.hooks.onRateLimited).toHaveBeenCalledTimes(2);
    expect(run.hooks.onRateLimited).toHaveBeenCalledWith(
      expect.objectContaining({ retrying: true, attempt: 3, maxAttempts: 5 }),
    );
    expect(run.hooks.emitWarning).toHaveBeenCalledTimes(1);
  });

  it('rejects with a rate-limit error when Codex gives up', async () => {
    const run = invocation();
    run.start();
    run.event({ type: 'error', message: RETRY_2 });
    await vi.advanceTimersByTimeAsync(60_000);
    run.event({ type: 'turn.failed', error: { message: GAVE_UP } });
    run.child.emit('close', 1);

    const { error } = await run.outcome;
    expect(isProviderRateLimitError(error)).toBe(true);
    expect(error?.message).toContain('429 Too Many Requests');
    expect(run.hooks.onRateLimited).toHaveBeenLastCalledWith(
      expect.objectContaining({ retrying: false }),
    );
  });

  it('spends the budget again once the request gets through', async () => {
    const run = invocation(180_000);
    run.start();
    run.event({ type: 'error', message: RETRY_2 });
    await vi.advanceTimersByTimeAsync(120_000);
    run.event({ type: 'item.started', item: { id: 'r', type: 'reasoning' } });
    await vi.advanceTimersByTimeAsync(182_000);

    const { error } = await run.outcome;
    expect(error?.message).toMatch(/^\[codex-cli\] turn timed out after 180s/);
    expect(isProviderRateLimitError(error)).toBe(false);
  });

  it('stops ignoring a 429 wait past its bound, and says it was rate limited', async () => {
    const run = invocation(180_000);
    run.start();
    run.event({ type: 'error', message: RETRY_2 });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 185_000);

    const { error } = await run.outcome;
    expect(isProviderRateLimitError(error)).toBe(true);
    expect(error?.message).toContain('while the model service was rate limiting it');
    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // 2026-11-13: a network blip killed forty turns mid-reconnect.
  it('holds the budget while Codex reconnects after a dropped connection', async () => {
    const run = invocation(180_000);
    run.start();
    run.event({
      type: 'error',
      message:
        'Reconnecting... 2/5 (stream disconnected before completion: Connection reset by peer (os error 54))',
    });
    await vi.advanceTimersByTimeAsync(170_000);
    run.event({ type: 'error', message: 'Reconnecting... 3/5 (request timed out)' });
    await vi.advanceTimersByTimeAsync(170_000);
    run.answer('ready');

    const { value, error } = await run.outcome;
    expect(error).toBeUndefined();
    expect(value).toBe('ready');
    expect(run.hooks.onRateLimited).not.toHaveBeenCalled();
  });

  it('times out plainly once a transport reconnect outlasts its bound', async () => {
    const run = invocation(180_000);
    run.start();
    run.event({
      type: 'error',
      message: 'Reconnecting... 2/5 (workspace routing discovery timed out)',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 185_000);

    const { error } = await run.outcome;
    expect(error?.message).toMatch(/^\[codex-cli\] turn timed out after 180s/);
    expect(isProviderRateLimitError(error)).toBe(false);
  });
});
