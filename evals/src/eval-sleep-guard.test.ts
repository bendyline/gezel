import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { EVAL_ALLOW_SLEEP_ENV, acquireEvalSleepGuard } from './eval-sleep-guard.ts';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.unref = vi.fn();
  return child;
}

describe('eval macOS sleep guard', () => {
  it('scopes caffeinate to the eval pid and releases it idempotently', () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const lease = acquireEvalSleepGuard({
      platform: 'darwin',
      pid: 4321,
      spawnProcess: spawnProcess as never,
    });

    expect(spawnProcess).toHaveBeenCalledWith('caffeinate', ['-im', '-w', '4321'], {
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledOnce();

    lease?.release();
    lease?.release();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('is a no-op off macOS and when explicitly disabled', () => {
    const spawnProcess = vi.fn();
    expect(
      acquireEvalSleepGuard({ platform: 'linux', spawnProcess: spawnProcess as never }),
    ).toBeNull();
    expect(
      acquireEvalSleepGuard({
        platform: 'darwin',
        env: { [EVAL_ALLOW_SLEEP_ENV]: '1' },
        spawnProcess: spawnProcess as never,
      }),
    ).toBeNull();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('warns without aborting when caffeinate cannot start', () => {
    const warn = vi.fn();
    const child = fakeChild();
    const lease = acquireEvalSleepGuard({
      platform: 'darwin',
      spawnProcess: vi.fn(() => child) as never,
      warn,
    });
    child.emit('error', new Error('missing'));

    expect(lease).not.toBeNull();
    expect(warn).toHaveBeenCalledWith('[evals] macOS sleep guard unavailable: missing');
  });
});
