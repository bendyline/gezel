/** Exercise Codex stream inactivity with a controllable subprocess.
 * No model calls occur. These regressions distinguish silent inference from
 * live tools, stream progress, diagnostic noise and the overall turn budget.
 */
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resetSuspendClockForTests, startSuspendMonitor } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodexTurn } from './invoker.js';

beforeEach(() => {
  vi.useFakeTimers();
  resetSuspendClockForTests();
  startSuspendMonitor();
});
afterEach(() => {
  resetSuspendClockForTests();
  vi.useRealTimers();
});

function invocation(options: { timeoutMs?: number; idleTimeoutMs?: number } = {}) {
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
  };
  const promise = runCodexTurn({
    binaryPath: 'codex',
    cwd: '.',
    codexHome: '.',
    baseEnv: {},
    model: 'gpt-5.6-luna',
    permissionMode: 'edit',
    prompt: 'Inspect this image',
    timeoutMs: 2 * 60 * 60_000,
    spawnImpl: (() => child as unknown as ChildProcess) as typeof spawn,
    hooks,
    ...options,
  });
  // Observe rejections immediately, including during fake-timer advancement.
  const outcome = promise.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error }),
  );
  const event = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const finish = () => {
    event({ type: 'turn.completed', usage: {} });
    child.emit('close', 0);
  };
  return { child, hooks, outcome, event, finish };
}

describe('Codex inactivity recovery', () => {
  it('ends a silent turn after the image tool completes, before the two-hour cap', async () => {
    const run = invocation();
    run.event({ type: 'thread.started', thread_id: 'retained-thread' });
    run.event({
      type: 'item.completed',
      item: {
        id: 'image',
        type: 'mcp_tool_call',
        server: 'gezel',
        tool: 'read_image_as_base64',
        status: 'completed',
      },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await run.outcome).error?.message).toContain(
      'no stream progress for 600s while thinking; no tool is running',
    );
    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(run.hooks.onThreadStarted).toHaveBeenCalledWith('retained-thread');
    expect(run.hooks.emitHeartbeat).toHaveBeenCalled();
  });

  it('renews the idle budget on stream events while keeping a fixed overall cap', async () => {
    const run = invocation({ timeoutMs: 30_000, idleTimeoutMs: 10_000 });
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(8_000);
      run.event({
        type: 'item.updated',
        item: { id: 'reason', type: 'reasoning', text: `step ${index}` },
      });
      expect(run.child.kill).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await run.outcome).error?.message).toContain('turn timed out after 30s');
  });

  it('allows silent tools, then starts a fresh idle budget when they complete', async () => {
    const run = invocation({ idleTimeoutMs: 10_000 });
    const item = { id: 'tool', type: 'command_execution', command: 'long-job' };
    run.event({ type: 'item.started', item });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.child.kill).not.toHaveBeenCalled();
    run.event({ type: 'item.completed', item: { ...item, exit_code: 0 } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await run.outcome).error?.message).toContain('no stream progress for 10s');
  });

  it('still applies the overall cap to a tool that never returns', async () => {
    const run = invocation({ timeoutMs: 20_000, idleTimeoutMs: 5_000 });
    run.event({
      type: 'item.started',
      item: { id: 'tool', type: 'mcp_tool_call', server: 'gezel', tool: 'slow' },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await run.outcome).error?.message).toContain('turn timed out after 20s');
  });

  it('does not count stderr, malformed output or its own heartbeat as progress', async () => {
    const run = invocation({ idleTimeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    run.child.stderr.write('still connected\n');
    run.child.stdout.write('not JSON\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await run.outcome).error?.message).toContain('no stream progress for 10s');
  });

  it('cleans up the watchdog when a normally progressing turn completes', async () => {
    const run = invocation({ idleTimeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    run.finish();
    expect((await run.outcome).error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.child.kill).not.toHaveBeenCalled();
  });

  it('preserves the idle allowance across a short host suspension', async () => {
    const run = invocation();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.child.kill).not.toHaveBeenCalled();
    run.finish();
    expect((await run.outcome).error).toBeUndefined();
  });

  it('reports a long host suspension rather than an unexplained silent hang', async () => {
    const run = invocation();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await run.outcome).error?.message).toContain('machine slept for');
  });

  it('allows an explicit idle opt-out without disabling the overall cap', async () => {
    const run = invocation({ timeoutMs: 20_000, idleTimeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await run.outcome).error?.message).toContain('turn timed out after 20s');
  });
});
