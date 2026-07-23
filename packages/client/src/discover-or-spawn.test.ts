import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from './client.js';
import { discoverOrSpawn } from './discover-or-spawn.js';
import type { RuntimeInfo } from './discovery.js';

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: null;
    stderr: null;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = 9999;
  child.unref = vi.fn();
  child.stdout = null;
  child.stderr = null;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  });
  return child as unknown as import('node:child_process').ChildProcess;
}

const sampleRuntime: RuntimeInfo = {
  pid: 1234,
  port: 45678,
  token: 'test-token',
  baseUrl: 'http://127.0.0.1:45678',
  cert: null,
};

function fakeClient() {
  return new GezelClient({
    baseUrl: 'http://127.0.0.1:0',
    token: 'x',
    fetch: (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
  });
}

describe('discoverOrSpawn', () => {
  it('adopts a running daemon when runtime files + pid are live', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      spawnFn,
      readRuntimeFn: async () => sampleRuntime,
      isProcessAliveFn: () => true,
      clientFactory: fakeClient,
    });
    expect(result.outcome).toBe('adopted');
    expect(result.pid).toBe(sampleRuntime.pid);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns when no runtime files exist, then adopts after health succeeds', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    let reads = 0;
    const readRuntimeFn = vi.fn(async () => {
      reads += 1;
      // First read: no runtime yet. Second read: runtime is written.
      return reads === 1 ? null : sampleRuntime;
    });
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      detached: true,
      pollIntervalMs: 5,
      timeoutMs: 200,
      spawnFn,
      readRuntimeFn,
      isProcessAliveFn: () => true,
      clientFactory: fakeClient,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('spawned');
    expect(result.pid).toBe(sampleRuntime.pid);
    // Detached spawns don't return a child handle.
    expect(result.child).toBeUndefined();
  });

  it('refuses to spawn beside a live pid whose daemon fails its health check', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    let reads = 0;
    // A live pid may still own the home even when its listener is wedged.
    // Starting a second process would create concurrent writers.
    const readRuntimeFn = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? { ...sampleRuntime, pid: 7 } : sampleRuntime;
    });
    let healthCalls = 0;
    const clientFactory = ({ token }: { token: string }) =>
      new GezelClient({
        baseUrl: 'http://127.0.0.1:0',
        token,
        fetch: (async () => {
          healthCalls += 1;
          return new Response('refused', { status: 503 });
        }) as typeof fetch,
      });
    await expect(
      discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        detached: false,
        pollIntervalMs: 5,
        timeoutMs: 200,
        spawnFn,
        readRuntimeFn,
        isProcessAliveFn: () => true,
        clientFactory,
      }),
    ).rejects.toThrow(/refusing to spawn another daemon/i);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(healthCalls).toBe(1);
  });

  it('treats a dead pid in runtime files as stale and spawns', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    let reads = 0;
    const readRuntimeFn = vi.fn(async () => {
      reads += 1;
      // First read returns stale runtime (dead pid); later reads return a
      // fresh runtime after spawn.
      return reads === 1 ? { ...sampleRuntime, pid: 9 } : sampleRuntime;
    });
    const isProcessAliveFn = (pid: number) => pid !== 9;
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      pollIntervalMs: 5,
      timeoutMs: 200,
      spawnFn,
      readRuntimeFn,
      isProcessAliveFn,
      clientFactory: fakeClient,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('spawned');
  });

  it('adopted result never carries a child handle', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      detached: false,
      spawnFn,
      readRuntimeFn: async () => sampleRuntime,
      isProcessAliveFn: () => true,
      clientFactory: fakeClient,
    });
    expect(result.outcome).toBe('adopted');
    expect(result.child).toBeUndefined();
  });

  it('returns child handle when attached and we actually spawned', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);
    let reads = 0;
    const readRuntimeFn = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? null : sampleRuntime;
    });
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      detached: false,
      pollIntervalMs: 5,
      timeoutMs: 200,
      spawnFn,
      readRuntimeFn,
      isProcessAliveFn: () => true,
      clientFactory: fakeClient,
    });
    expect(result.outcome).toBe('spawned');
    expect(result.child).toBe(fakeChild);
  });

  it('forceSpawn skips adoption but still polls for the fresh daemon', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    // readRuntime always returns a live-looking runtime. WITHOUT forceSpawn
    // this would be adopted; WITH it we must spawn anew and then detect the
    // fresh daemon via the poll (the poll uses the same readRuntimeFn, which
    // is exactly why a null override would have blinded it and timed out).
    const readRuntimeFn = vi.fn(async () => sampleRuntime);
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      forceSpawn: true,
      pollIntervalMs: 5,
      timeoutMs: 200,
      spawnFn,
      readRuntimeFn,
      isProcessAliveFn: () => true,
      clientFactory: fakeClient,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('spawned');
  });

  it('times out when the daemon never writes its runtime files', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    await expect(
      discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        detached: false,
        pollIntervalMs: 5,
        timeoutMs: 30,
        spawnFn,
        readRuntimeFn: async () => null,
        isProcessAliveFn: () => false,
        clientFactory: fakeClient,
      }),
    ).rejects.toThrow(/Timed out/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps polling through a transient health failure', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    let reads = 0;
    const readRuntimeFn = async () => {
      reads += 1;
      return reads >= 2 ? sampleRuntime : null;
    };
    let healthCalls = 0;
    const clientFactory = () =>
      new GezelClient({
        baseUrl: 'http://127.0.0.1:0',
        token: 'x',
        fetch: (async () => {
          healthCalls += 1;
          if (healthCalls === 1) {
            // Simulate "server bound port but not yet ready": health errors.
            return new Response('server starting', { status: 503 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch,
      });
    const result = await discoverOrSpawn({
      daemonEntry: '/fake/gezeld.js',
      pollIntervalMs: 5,
      timeoutMs: 300,
      spawnFn,
      readRuntimeFn,
      isProcessAliveFn: () => true,
      clientFactory,
    });
    expect(result.outcome).toBe('spawned');
    expect(healthCalls).toBeGreaterThanOrEqual(2);
  });

  it('enforces the wall-clock deadline when health never settles or observes abort', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    const neverSettles = new Promise<Response>(() => {});
    const clientFactory = () =>
      new GezelClient({
        baseUrl: 'http://127.0.0.1:0',
        token: 'x',
        // Deliberately ignore RequestInit.signal. The discovery deadline must
        // remain real even for a broken/custom fetch implementation.
        fetch: (() => neverSettles) as typeof fetch,
      });

    const startedAt = Date.now();
    await expect(
      discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        forceSpawn: true,
        pollIntervalMs: 2,
        timeoutMs: 40,
        healthTimeoutMs: 8,
        spawnFn,
        readRuntimeFn: async () => sampleRuntime,
        isProcessAliveFn: () => true,
        clientFactory,
      }),
    ).rejects.toThrow(/Timed out after 40ms/);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
