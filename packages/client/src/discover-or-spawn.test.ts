import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from './client.js';
import { type SpawnLike, discoverOrSpawn, stopOwnedDaemon } from './discover-or-spawn.js';
import type { RuntimeInfo } from './discovery.js';

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: null;
    stderr: null;
    stdin: {
      destroyed: boolean;
      writableEnded: boolean;
      end: ReturnType<typeof vi.fn>;
    };
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = 9999;
  child.unref = vi.fn();
  child.stdout = null;
  child.stderr = null;
  child.stdin = {
    destroyed: false,
    writableEnded: false,
    end: vi.fn(() => {
      child.stdin.writableEnded = true;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    }),
  };
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
  // Regression: the supervisor spawns `process.execPath`, which under Electron
  // is the app binary. Without this flag Electron ignores the script argument
  // and boots a second copy of the app — it never writes runtime files, so the
  // caller waited out its whole startup budget and fell back to embedded on
  // every packaged per-user launch.
  describe('daemon child environment', () => {
    // Must await inside: discoverOrSpawn reaches its spawn only after the
    // runtime-file await, so a synchronous finally would restore the real
    // process.versions before the code under test ever reads it.
    async function withElectron<T>(version: string | undefined, run: () => Promise<T>): Promise<T> {
      const original = process.versions;
      const patched = { ...original };
      if (version === undefined) delete (patched as { electron?: string }).electron;
      else (patched as { electron?: string }).electron = version;
      Object.defineProperty(process, 'versions', { value: patched, configurable: true });
      try {
        return await run();
      } finally {
        Object.defineProperty(process, 'versions', { value: original, configurable: true });
      }
    }

    async function spawnAndCaptureEnv(
      electronVersion: string | undefined,
      env?: NodeJS.ProcessEnv,
    ): Promise<NodeJS.ProcessEnv | undefined> {
      // Typed as SpawnLike so `mock.calls[0][2].env` is checked, not `never`.
      const spawnFn = vi.fn<SpawnLike>(() => makeFakeChild());
      await withElectron(electronVersion, () =>
        discoverOrSpawn({
          daemonEntry: '/fake/gezeld.js',
          timeoutMs: 20,
          pollIntervalMs: 5,
          ...(env ? { env } : {}),
          spawnFn,
          readRuntimeFn: async () => null,
          isProcessAliveFn: () => false,
          clientFactory: fakeClient,
        }).catch(() => undefined),
      );
      expect(spawnFn).toHaveBeenCalled();
      return spawnFn.mock.calls[0]?.[2]?.env;
    }

    it('runs the Electron binary as node so it starts gezeld, not a second app', async () => {
      const spawned = await spawnAndCaptureEnv('39.0.0', { GEZEL_HOME: '/tmp/home' });
      expect(spawned?.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(spawned?.GEZEL_HOME).toBe('/tmp/home');
    });

    it('leaves the flag off outside Electron, where execPath is already node', async () => {
      const spawned = await spawnAndCaptureEnv(undefined, { GEZEL_HOME: '/tmp/home' });
      expect(spawned?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    });

    it('never mutates the caller env, so the flag cannot leak into later spawns', async () => {
      const callerEnv: NodeJS.ProcessEnv = { GEZEL_HOME: '/tmp/home' };
      const spawned = await spawnAndCaptureEnv('39.0.0', callerEnv);
      expect(spawned?.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(callerEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(spawned).not.toBe(callerEnv);
    });

    it('opts attached pipe-owned daemons into stdin EOF shutdown without mutating the caller', async () => {
      const callerEnv: NodeJS.ProcessEnv = { GEZEL_HOME: '/tmp/home' };
      const spawnFn = vi.fn<SpawnLike>(() => makeFakeChild());
      const result = await discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        detached: false,
        stdio: 'pipe',
        env: callerEnv,
        timeoutMs: 100,
        pollIntervalMs: 1,
        spawnFn,
        readRuntimeFn: async () => sampleRuntime,
        isProcessAliveFn: () => true,
        clientFactory: fakeClient,
        forceSpawn: true,
      });

      expect(result.outcome).toBe('spawned');
      expect(spawnFn.mock.calls[0]?.[2].env?.GEZEL_SHUTDOWN_ON_STDIN_EOF).toBe('1');
      expect(callerEnv.GEZEL_SHUTDOWN_ON_STDIN_EOF).toBeUndefined();
    });

    it('does not opt detached or inherited-stdio daemons into stdin EOF shutdown', async () => {
      const detachedEnv = await spawnAndCaptureEnv(undefined, { GEZEL_HOME: '/tmp/home' });
      expect(detachedEnv?.GEZEL_SHUTDOWN_ON_STDIN_EOF).toBeUndefined();

      const spawnFn = vi.fn<SpawnLike>(() => makeFakeChild());
      await discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        detached: false,
        stdio: 'inherit',
        timeoutMs: 20,
        pollIntervalMs: 2,
        spawnFn,
        readRuntimeFn: async () => null,
        isProcessAliveFn: () => false,
        clientFactory: fakeClient,
      }).catch(() => undefined);
      expect(spawnFn.mock.calls[0]?.[2].env?.GEZEL_SHUTDOWN_ON_STDIN_EOF).toBeUndefined();
    });
  });

  describe('owned daemon shutdown', () => {
    it('uses stdin EOF on Windows and does not signal or taskkill a child that exits cleanly', async () => {
      const child = makeFakeChild();
      const terminateWindowsTree = vi.fn(async () => {});

      await stopOwnedDaemon(child, undefined, {
        platform: 'win32',
        graceMs: 20,
        forceMs: 20,
        terminateWindowsTree,
      });

      expect(child.stdin?.end).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
      expect(terminateWindowsTree).not.toHaveBeenCalled();
    });

    it('falls back to a Windows process-tree kill when stdin EOF is ignored', async () => {
      const child = makeFakeChild();
      const mutable = child as unknown as {
        pid: number;
        signalCode: NodeJS.Signals | null;
        stdin: { end: ReturnType<typeof vi.fn> };
      };
      mutable.pid = 43210;
      mutable.stdin.end.mockImplementation(() => {
        // Deliberately remain alive through the graceful window.
      });
      const terminateWindowsTree = vi.fn(async () => {
        mutable.signalCode = 'SIGKILL';
        queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      });

      await stopOwnedDaemon(child, undefined, {
        platform: 'win32',
        graceMs: 5,
        forceMs: 20,
        terminateWindowsTree,
      });

      expect(terminateWindowsTree).toHaveBeenCalledWith(43210);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

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
    const spawnFn = vi.fn<SpawnLike>(() => makeFakeChild());
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
    expect(spawnFn.mock.calls[0]?.[2].windowsHide).toBe(
      process.platform === 'win32' ? true : undefined,
    );
    expect(result.outcome).toBe('spawned');
    expect(result.pid).toBe(sampleRuntime.pid);
    // Detached spawns don't return a child handle.
    expect(result.child).toBeUndefined();
  });

  it('can require an already-running daemon without spawning a replacement', async () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    await expect(
      discoverOrSpawn({
        daemonEntry: '/fake/gezeld.js',
        spawnIfMissing: false,
        spawnFn,
        readRuntimeFn: async () => null,
        isProcessAliveFn: () => false,
        clientFactory: fakeClient,
      }),
    ).rejects.toMatchObject({ name: 'DaemonNotRunningError' });
    expect(spawnFn).not.toHaveBeenCalled();
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
    expect(child.stdin?.end).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
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
