import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type SignalCleanupHost, installSignalCleanup } from './signal-cleanup.js';

function signalHost() {
  const events = new EventEmitter();
  const host: SignalCleanupHost = {
    exitCode: undefined,
    on: (signal, listener) => events.on(signal, listener),
    off: (signal, listener) => events.off(signal, listener),
  };
  return { events, host };
}

describe('installSignalCleanup', () => {
  it('runs async cleanup once and preserves the conventional signal exit code', async () => {
    const { events, host } = signalHost();
    const cleanup = vi.fn(async () => {});
    const dispose = installSignalCleanup(cleanup, { host });

    events.emit('SIGINT');
    events.emit('SIGTERM');
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(host.exitCode).toBe(143);
    dispose();
    events.emit('SIGINT');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure and changes the exit code to failure', async () => {
    const { events, host } = signalHost();
    const error = new Error('shutdown failed');
    const onError = vi.fn();
    installSignalCleanup(async () => Promise.reject(error), { host, onError });

    events.emit('SIGINT');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(error);
    expect(host.exitCode).toBe(1);
  });
});
