import { beforeEach, describe, expect, it } from 'vitest';
import {
  NativeEngineSupervisor,
  __resetLiveEnginePidsForTest,
  classifyNativeEnginePanic,
  normalizeNativeEngineLaunch,
  parseNativeProcessSnapshot,
} from './supervisor.js';

/**
 * Drive the supervisor against an injected spawn + fetch so we never
 * actually touch the filesystem or a real binary.
 */

type FakeExitListener = (code: number | null, signal: string | null) => void;
type FakeErrorListener = (error: Error) => void;

interface FakeChild {
  stdout: { on: (ev: string, fn: (buf: Buffer) => void) => void };
  stderr: { on: (ev: string, fn: (buf: Buffer) => void) => void };
  once(ev: 'exit', fn: FakeExitListener): void;
  once(ev: 'error', fn: FakeErrorListener): void;
  on(ev: 'exit', fn: FakeExitListener): void;
  on(ev: 'error', fn: FakeErrorListener): void;
  kill: (sig?: string) => boolean;
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  emitExit(code: number | null, signal: string | null): void;
  emitError(error: Error): void;
}

function makeFakeChild(pid?: number): FakeChild {
  const exitListeners: FakeExitListener[] = [];
  const errorListeners: FakeErrorListener[] = [];
  function on(ev: 'exit', fn: FakeExitListener): void;
  function on(ev: 'error', fn: FakeErrorListener): void;
  function on(ev: 'exit' | 'error', fn: FakeExitListener | FakeErrorListener): void {
    if (ev === 'exit') exitListeners.push(fn as FakeExitListener);
    else errorListeners.push(fn as FakeErrorListener);
  }
  const fake: FakeChild = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    once: on,
    on,
    pid,
    exitCode: null,
    signalCode: null,
    kill(sig?: string) {
      // Mimic a real child: SIGTERM/SIGKILL terminates the process and emits exit.
      queueMicrotask(() => fake.emitExit(0, sig ?? 'SIGTERM'));
      return true;
    },
    emitExit(code, signal) {
      if (fake.exitCode !== null || fake.signalCode !== null) return;
      fake.exitCode = code;
      fake.signalCode = signal;
      for (const fn of exitListeners) fn(code, signal);
    },
    emitError(error) {
      for (const fn of errorListeners) fn(error);
    },
  };
  return fake;
}

describe('NativeEngineSupervisor', () => {
  // The live-engine registry is a process-wide singleton; clear it so a
  // pid registered by one case can't suppress an orphan reap in the next.
  beforeEach(() => __resetLiveEnginePidsForTest());

  it('classifies the CUDA invalid-argument panic precisely', () => {
    expect(classifyNativeEnginePanic('CUDA error: invalid argument')).toEqual({
      kind: 'cuda-invalid-argument',
      line: 'CUDA error: invalid argument',
    });
    expect(classifyNativeEnginePanic('routine CUDA initialization')).toBeUndefined();
  });

  it('rewrites every packaged ASAR launch path to its real unpacked location', () => {
    expect(
      normalizeNativeEngineLaunch({
        command:
          '/Applications/Gezel.app/Contents/Resources/app.asar/native-bin/darwin-arm64-metal/gezel-llama-server',
        args: [
          '--helper',
          '/Applications/Gezel.app/Contents/Resources/app.asar/native-bin/helper.bin',
        ],
        cwd: '/Applications/Gezel.app/Contents/Resources/app.asar/native-bin/darwin-arm64-metal',
        env: {
          PATH: '/Applications/Gezel.app/Contents/Resources/app.asar/native-bin:/usr/bin',
          ALREADY_REAL: '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin',
        },
        baseUrl: 'http://127.0.0.1:9999',
      }),
    ).toMatchObject({
      command:
        '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin/darwin-arm64-metal/gezel-llama-server',
      args: [
        '--helper',
        '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin/helper.bin',
      ],
      cwd: '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin/darwin-arm64-metal',
      env: {
        PATH: '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin:/usr/bin',
        ALREADY_REAL: '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin',
      },
    });
  });

  it('reports the resolved executable when native spawn emits an error', async () => {
    const command =
      '/Applications/Gezel.app/Contents/Resources/app.asar/native-bin/darwin-arm64-metal/gezel-llama-server';
    const child = makeFakeChild();
    const fakeSpawn = (() => {
      queueMicrotask(() =>
        child.emitError(Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' })),
      );
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command,
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => [],
    });

    await expect(sup.ensureRunning()).rejects.toThrow(
      /app\.asar\.unpacked\/native-bin\/darwin-arm64-metal\/gezel-llama-server.*ENOTDIR/,
    );
  });

  // Regression: the engine spawn used to pass `windowsHide: true`, which is
  // CREATE_NO_WINDOW — a console is still allocated, and that allocation
  // fails under the restricted Session 0 service SID, so every launch died
  // as `spawn EPERM` in packaged machine-service installs. DETACHED_PROCESS
  // (Node's `detached`) is the flag that allocates no console at all.
  it('launches native engines detached from any Windows console', async () => {
    let spawnOptions: Parameters<typeof import('node:child_process').spawn>[2] | undefined;
    const child = makeFakeChild(4242);
    const fakeSpawn = ((...args: Parameters<typeof import('node:child_process').spawn>) => {
      spawnOptions = args[2];
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine.exe',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      idleTimeoutMs: 0,
      healthIntervalMs: 10_000_000,
      onLog: () => {},
      psRunner: async () => [],
    });

    await sup.ensureRunning();
    expect(spawnOptions).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    // CREATE_NO_WINDOW must never come back — it is what broke the machine
    // service. `detached` is win32-only: on POSIX it means setsid(), and the
    // supervisor's group/signal handling does not want that.
    expect(spawnOptions?.windowsHide).toBeUndefined();
    expect(spawnOptions?.detached).toBe(process.platform === 'win32' ? true : undefined);
    await sup.stop();
  });

  it('exposes the live launch snapshot and hides it once the child exits', async () => {
    const child = makeFakeChild(5150);
    const fakeSpawn = (() =>
      child as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
        diagnostics: {
          model: 'gemma4-31b-q4',
          contextPerSlot: 65_536,
          contextTotal: 65_536,
          slots: 1,
          kvCacheType: 'q8_0',
          backend: 'metal',
        },
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      idleTimeoutMs: 0,
      healthIntervalMs: 10_000_000,
      onLog: () => {},
      psRunner: async () => [],
    });

    expect(sup.launchSnapshot()).toBeUndefined();
    await sup.ensureRunning();
    const snap = sup.launchSnapshot();
    expect(snap?.pid).toBe(5150);
    expect(snap?.startedAt).toBeGreaterThan(0);
    expect(snap?.diagnostics).toMatchObject({
      model: 'gemma4-31b-q4',
      contextPerSlot: 65_536,
      kvCacheType: 'q8_0',
    });
    await sup.stop();
    // A stale grant for a dead engine would misdirect the exact triage
    // this snapshot feeds (Settings → About, /api/system/diagnostics).
    expect(sup.launchSnapshot()).toBeUndefined();
  });

  it('parses PPID from the production ps snapshot shape', () => {
    expect(
      parseNativeProcessSnapshot(`
  68057   66049 /usr/bin/node packages/service/dist/bin/gezeld.js
  68188   68057 /opt/gezel/gezel-llama-server --model /tmp/model.gguf --port 33221
not a process row
`),
    ).toEqual([
      {
        pid: 68057,
        ppid: 66049,
        command: '/usr/bin/node packages/service/dist/bin/gezeld.js',
      },
      {
        pid: 68188,
        ppid: 68057,
        command: '/opt/gezel/gezel-llama-server --model /tmp/model.gguf --port 33221',
      },
    ]);
  });

  it('lazy-starts on ensureRunning and caches the running state', async () => {
    const children: FakeChild[] = [];
    const healthOk = true;
    const fakeSpawn = (() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () =>
      new Response('ok', { status: healthOk ? 200 : 503 });

    const launches: Array<{ command: string }> = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => {
        const spec = { command: 'fake-engine', args: [], baseUrl: 'http://127.0.0.1:9999' };
        launches.push(spec);
        return spec;
      },
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
    });

    const launch1 = await sup.ensureRunning();
    const launch2 = await sup.ensureRunning();
    expect(launches).toHaveLength(1);
    expect(launch1.baseUrl).toBe('http://127.0.0.1:9999');
    expect(launch2).toBe(launch1);
    expect(sup.currentBaseUrl()).toBe('http://127.0.0.1:9999');

    await sup.stop();
    expect(sup.currentBaseUrl()).toBeUndefined();
  });

  it('defers the idle-stop while isBusy() is true, then stops once idle', async () => {
    const fakeSpawn = (() =>
      makeFakeChild(4242) as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    let busy = true;
    const logs: string[] = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine',
        args: [],
        baseUrl: 'http://127.0.0.1:9998',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 40,
      freezeTimeoutMs: 0,
      isBusy: () => busy,
      onLog: (l) => logs.push(l),
    });

    await sup.ensureRunning();
    expect(sup.currentBaseUrl()).toBe('http://127.0.0.1:9998');

    // Past the idle deadline while a turn is active → deferred, still resident.
    await new Promise((r) => setTimeout(r, 160));
    expect(sup.currentBaseUrl()).toBe('http://127.0.0.1:9998');
    expect(logs.some((l) => /deferring VRAM stop/.test(l))).toBe(true);

    // Turn finished → the next deadline actually stops it to free VRAM.
    busy = false;
    await new Promise((r) => setTimeout(r, 160));
    expect(sup.currentBaseUrl()).toBeUndefined();
    expect(logs.some((l) => /idle timeout — stopping/.test(l))).toBe(true);
  });

  it('flushes and releases an idle engine early under memory pressure', async () => {
    const fakeSpawn = (() =>
      makeFakeChild(4243) as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    let busy = true;
    let flushes = 0;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine',
        args: [],
        baseUrl: 'http://127.0.0.1:9997',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      healthIntervalMs: 20,
      idleTimeoutMs: 500,
      freezeTimeoutMs: 250,
      pressureIdleTimeoutMs: 40,
      isBusy: () => busy,
      memoryPressure: async () => ({ pressured: true, detail: '0.8 GB free' }),
      onFreeze: async () => {
        flushes++;
      },
      onLog: () => {},
    });

    await sup.ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sup.currentBaseUrl()).toBe('http://127.0.0.1:9997');
    expect(sup.lifecycleSnapshot()).toMatchObject({
      running: true,
      active: true,
      releaseReason: null,
    });

    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sup.currentBaseUrl()).toBeUndefined();
    expect(flushes).toBe(1);
  });

  it('fails cleanly when the engine never becomes ready', async () => {
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({ command: 'fake', args: [], baseUrl: 'http://127.0.0.1:1' }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 300,
      idleTimeoutMs: 0,
      onLog: () => {},
    });

    await expect(sup.ensureRunning()).rejects.toThrow(/did not become ready/);
  });

  it('exhausts the restart budget after 3 rapid failed starts', async () => {
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({ command: 'fake', args: [], baseUrl: 'http://127.0.0.1:2' }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 50,
      idleTimeoutMs: 0,
      onLog: () => {},
    });

    for (let i = 0; i < 3; i++) {
      await expect(sup.ensureRunning()).rejects.toThrow();
    }
    await expect(sup.ensureRunning()).rejects.toThrow(/crashed too many times|failed repeatedly/);
  });

  it('uses the configured logPrefix in log output', async () => {
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const logs: string[] = [];

    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({ command: 'fake', args: [], baseUrl: 'http://127.0.0.1:3' }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 50,
      idleTimeoutMs: 0,
      logPrefix: '[llama-server]',
      onLog: (line) => logs.push(line),
    });

    await expect(sup.ensureRunning()).rejects.toThrow();
    expect(
      logs.some((l) => l.includes('[llama-server]')),
      `expected a log line with the configured prefix; got: ${JSON.stringify(logs)}`,
    ).toBe(true);
  });

  it('reaps orphan processes whose argv[0] matches the launch command before the first spawn', async () => {
    // Simulate two prior orphans (`gezel_mlx_server.py` reparented to
    // launchd) plus an unrelated `node` process. The reaper should
    // SIGKILL only the two orphans matching argv[0].
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const reaped: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killed = new Set<number>();
    const binary = '/Users/test/.gezel/engines/uv/venvs/mlx/bin/python';
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: binary,
        args: ['gezel_mlx_server.py', '--port', '12345'],
        baseUrl: 'http://127.0.0.1:12345',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      // Model real process death: a SIGKILL'd pid disappears from later ps
      // output, so the supervisor's post-reap `waitForPidsGone` returns.
      psRunner: async () =>
        [
          { pid: 13228, ppid: 1, command: `${binary} gezel_mlx_server.py --port 62597` },
          { pid: 50164, ppid: 1, command: `${binary} gezel_mlx_server.py --port 58764` },
          { pid: 99001, ppid: 1, command: '/usr/bin/node /some/other/server.js' },
        ].filter((p) => !killed.has(p.pid)),
      killProcess: (pid, signal) => {
        reaped.push({ pid, signal });
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([
      { pid: 13228, signal: 'SIGKILL' },
      { pid: 50164, signal: 'SIGKILL' },
    ]);
    await sup.stop();
  });

  it('does not reap an engine a live sibling supervisor in this process owns', async () => {
    // The outage we're fixing: a second engine (e.g. a model switch)
    // constructs a fresh supervisor whose orphan sweep matches a sibling
    // engine by shared script path — but that sibling is still mid-turn
    // for another session. It must be skipped, not SIGKILL'd.
    const binary = '/Users/test/.gezel/engines/uv/venvs/mlx/bin/python';
    const script = '/Users/test/.gezel/dist/gezel_mlx_server.py';
    const launchFor = (port: number) => ({
      command: binary,
      args: [script, '--port', String(port)],
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const fetchOk: typeof fetch = async () => new Response('ok', { status: 200 });

    // Supervisor A owns a live engine, pid 13228. Long idle + health
    // intervals so it stays running (and registered) for B's sweep.
    const aChild = makeFakeChild(13228);
    const supA = new NativeEngineSupervisor({
      resolveLaunch: async () => launchFor(9001),
      spawn: (() =>
        aChild as unknown as ReturnType<
          typeof import('node:child_process').spawn
        >) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchOk,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 10_000_000,
      healthIntervalMs: 10_000_000,
      psRunner: async () => [],
      killProcess: () => {},
    });
    await supA.ensureRunning();

    // Supervisor B's sweep sees A's engine in `ps` — same script path —
    // but must leave it alone because A still owns it.
    const reaped: number[] = [];
    const killed = new Set<number>();
    const supB = new NativeEngineSupervisor({
      resolveLaunch: async () => launchFor(9002),
      spawn: (() =>
        makeFakeChild() as unknown as ReturnType<
          typeof import('node:child_process').spawn
        >) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchOk,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      healthIntervalMs: 10_000_000,
      psRunner: async () =>
        [
          { pid: 13228, command: `${binary} ${script} --port 9001` },
          { pid: 77777, command: `${binary} ${script} --port 8000` }, // a true orphan
        ].filter((p) => !killed.has(p.pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });
    await supB.ensureRunning();

    // The live sibling (13228) is spared; the genuine orphan (77777) dies.
    expect(reaped).toEqual([77777]);
    await supB.stop();
    await supA.stop();
  });

  it('does not reap a matching engine owned by another live daemon', async () => {
    // Regression for two concurrent isolated eval daemons. Daemon B's first
    // orphan sweep saw daemon A's llama child because both homes share the
    // same absolute engine binary. The old command-only matcher SIGKILL'd A's
    // in-flight child, producing `TypeError: terminated` in A. PPID proves the
    // matching child still has a live owner; only the PPID-1 orphan is safe to
    // reap.
    const binary = '/home/dev/gh/gezel/packages/app/native-bin/linux-arm64-cuda/gezel-llama-server';
    const ownerPid = 68057;
    const liveEnginePid = 68188;
    const orphanPid = 67999;
    const killed = new Set<number>();
    const reaped: number[] = [];
    const fakeSpawn = (() =>
      makeFakeChild(69001) as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: binary,
        args: ['--model', '/tmp/gezel-eval-b/model.gguf', '--port', '33065'],
        baseUrl: 'http://127.0.0.1:33065',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () =>
        [
          {
            pid: ownerPid,
            ppid: 66049,
            command: '/usr/bin/node packages/service/dist/bin/gezeld.js',
          },
          {
            pid: liveEnginePid,
            ppid: ownerPid,
            command: `${binary} --model /tmp/gezel-eval-a/model.gguf --port 33221`,
          },
          {
            pid: orphanPid,
            ppid: 1,
            command: `${binary} --model /tmp/abandoned/model.gguf --port 39999`,
          },
        ].filter((proc) => !killed.has(proc.pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([orphanPid]);
    expect(reaped).not.toContain(liveEnginePid);
    await sup.stop();
  });

  it('reaps a Windows engine whose retained creator pid is absent while preserving live owners', async () => {
    const binary = 'C:\\Gezel\\native-bin\\gezel-llama-server.exe';
    const liveOwnerPid = 72000;
    const liveEnginePid = 72001;
    const deadOwnerPid = 71900;
    const orphanPid = 71901;
    const killed = new Set<number>();
    const reaped: number[] = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: binary,
        args: ['--model', 'C:\\Users\\test\\.gezel\\models\\active.gguf', '--port', '33065'],
        baseUrl: 'http://127.0.0.1:33065',
      }),
      spawn: (() =>
        makeFakeChild(73000) as unknown as ReturnType<
          typeof import('node:child_process').spawn
        >) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      platform: 'win32',
      psRunner: async () =>
        [
          {
            pid: liveOwnerPid,
            ppid: 60000,
            command: 'node C:\\other-home\\service\\dist\\bin\\gezeld.js',
          },
          {
            pid: liveEnginePid,
            ppid: liveOwnerPid,
            command: `"${binary.toUpperCase()}" --model C:\\other-home\\model.gguf --port 33066`,
          },
          {
            pid: orphanPid,
            ppid: deadOwnerPid,
            command: `"${binary.toUpperCase()}" --model C:\\abandoned\\model.gguf --port 33067`,
          },
        ].filter(({ pid }) => !killed.has(pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([orphanPid]);
    expect(reaped).not.toContain(liveEnginePid);
    await sup.stop();
  });

  it('does not reap wrapper processes that only mention the launch command as an argument', async () => {
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const reaped: number[] = [];
    const killed = new Set<number>();
    const binary = '/home/dev/gh/gezel/native/build/linux-arm64-cuda/llama-server';
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: binary,
        args: ['--model', '/tmp/gezel/model.gguf', '--port', '12345'],
        baseUrl: 'http://127.0.0.1:12345',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () =>
        [
          { pid: 13228, command: `${binary} --model /old/model.gguf --port 62597` },
          {
            pid: 50164,
            command: `node src/bin/run.ts tankcombat --llama-bin ${binary}`,
          },
        ].filter((p) => !killed.has(p.pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([13228]);
    await sup.stop();
  });

  it('reaps Python orphans by script-path arg even when the venv binary symlink-resolves elsewhere', async () => {
    // Real-world MLX case: launch.command is the venv's `bin/python`,
    // but that's a symlink chain to the system framework Python. macOS
    // `ps` reports the resolved path, so the binary-path match never
    // hits. The script path (an absolute `.py` file in launch.args) is
    // what actually identifies the orphan.
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const reaped: number[] = [];
    const killed = new Set<number>();
    const venvPython = '/Users/test/.gezel/engines/uv/venvs/mlx/bin/python';
    const scriptPath = '/Users/test/gezel/dist/providers/mlx/python/gezel_mlx_server.py';
    const frameworkPython =
      '/Library/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python';
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: venvPython,
        args: [scriptPath, '--port', '12345'],
        baseUrl: 'http://127.0.0.1:12345',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () =>
        [
          // Two prior MLX orphans: argv[0] is the framework Python (after
          // symlink resolution), and argv[1] is our install-specific
          // script path — that's what should anchor the match.
          { pid: 13228, command: `${frameworkPython} ${scriptPath} --port 62597` },
          { pid: 50164, command: `${frameworkPython} ${scriptPath} --port 58764` },
          // An unrelated framework-Python process — same binary prefix but
          // a different script. Must NOT be reaped.
          {
            pid: 99001,
            command: `${frameworkPython} /Users/somebody/unrelated/script.py`,
          },
        ].filter((p) => !killed.has(p.pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([13228, 50164]);
    await sup.stop();
  });

  it('does not anchor on bare directory args (avoids matching unrelated tools)', async () => {
    // The MLX launch passes `--model /path/to/model-dir` — that's an
    // absolute path with no extension. We refuse to use it as an
    // anchor because some unrelated tool (a backup script, `du`, an
    // editor) might have that path on its command line.
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const reaped: number[] = [];
    const venvPython = '/Users/test/.gezel/engines/uv/venvs/mlx/bin/python';
    const modelDir = '/Users/test/.gezel/engines/mlx/models/qwen3.6';
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: venvPython,
        args: ['--model', modelDir, '--port', '12345'],
        baseUrl: 'http://127.0.0.1:12345',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => [
        // An unrelated `du` process has the model dir on its cmdline.
        { pid: 77001, command: `/usr/bin/du -sh ${modelDir}` },
      ],
      killProcess: (pid) => {
        reaped.push(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([]);
    await sup.stop();
  });

  it('only reaps once per supervisor instance (skipped on restart)', async () => {
    // The didOrphanSweep gate prevents the supervisor from killing
    // its OWN healthy child during a restart cycle. We verify this
    // by triggering a restart and asserting the second startFresh
    // doesn't call psRunner again.
    const fakeChildren: FakeChild[] = [];
    const fakeSpawn = (() => {
      const c = makeFakeChild();
      fakeChildren.push(c);
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    let psCalls = 0;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/fake/binary',
        args: [],
        baseUrl: 'http://127.0.0.1:9',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => {
        psCalls++;
        return [];
      },
      killProcess: () => {},
    });

    await sup.ensureRunning();
    await sup.stop();
    await sup.ensureRunning();

    expect(psCalls).toBe(1);
    expect(fakeChildren).toHaveLength(2);
    await sup.stop();
  });

  it('skips reaping our own pid even if the command path matches', async () => {
    const fakeSpawn = (() =>
      makeFakeChild() as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const reaped: number[] = [];
    const killed = new Set<number>();
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({ command: '/bin/sh', args: [], baseUrl: 'http://127.0.0.1:9' }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      // Include this test process's own pid in the matched list to
      // make sure the supervisor doesn't kill itself.
      psRunner: async () =>
        [
          { pid: process.pid, command: '/bin/sh -c "anything"' },
          { pid: 99002, command: '/bin/sh -c "old orphan"' },
        ].filter((p) => !killed.has(p.pid)),
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([99002]);
    expect(reaped).not.toContain(process.pid);
    await sup.stop();
  });

  it('recovers from a singleton conflict: re-sweeps a blocking orphan and retries the spawn once', async () => {
    // ds4-server enforces a hard singleton — while an owner-less orphan from a
    // prior launch holds the lock, the freshly spawned child exits "before
    // becoming ready". That orphan can appear AFTER the first-spawn sweep (a
    // teardown race, or a restart that skips the sweep), so the supervisor must
    // re-sweep on that failure and, if it clears a blocker, retry once.
    const binary = '/Users/test/.gezel/native/bin/ds4-server';
    const orphanPid = 55501;
    const killed = new Set<number>();
    const reaped: number[] = [];
    let psCall = 0;
    let spawnCount = 0;
    const children: FakeChild[] = [];
    const fakeSpawn = (() => {
      spawnCount += 1;
      const c = makeFakeChild(8000 + spawnCount);
      children.push(c);
      // First spawn: the orphan still holds the lock → exit code 2 before ready.
      if (spawnCount === 1) queueMicrotask(() => c.emitExit(2, null));
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    // Readiness only succeeds once the blocking orphan is gone (second attempt).
    const fakeFetch: typeof fetch = async () =>
      killed.has(orphanPid)
        ? new Response('ok', { status: 200 })
        : Promise.reject(new Error('connection refused'));
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: binary,
        args: ['--model', '/m.gguf', '--port', '12345'],
        baseUrl: 'http://127.0.0.1:12345',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 2_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => {
        psCall += 1;
        // The first-spawn sweep (call 1) sees nothing; the blocking orphan
        // only becomes visible to the re-sweep after the first child fails.
        if (psCall === 1) return [];
        return [{ pid: orphanPid, command: `${binary} --model /m.gguf --port 9999` }].filter(
          (p) => !killed.has(p.pid),
        );
      },
      killProcess: (pid) => {
        reaped.push(pid);
        killed.add(pid);
      },
    });

    await sup.ensureRunning();
    expect(reaped).toEqual([orphanPid]); // the blocking orphan was cleared
    expect(spawnCount).toBe(2); // first failed before ready, retried exactly once
    expect(children).toHaveLength(2);
    await sup.stop();
  });

  it('two-stage idle: fires onFreeze before SIGTERM, keeps child alive in between', async () => {
    const children: FakeChild[] = [];
    const fakeSpawn = (() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });

    let freezeFiredAt = 0;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine',
        args: [],
        baseUrl: 'http://127.0.0.1:9991',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 1_000,
      healthIntervalMs: 10_000_000,
      // Tight values so the test runs fast. freeze at 80ms, idle at 200ms.
      freezeTimeoutMs: 80,
      idleTimeoutMs: 200,
      onFreeze: () => {
        freezeFiredAt = Date.now();
      },
      onLog: () => {},
    });

    await sup.ensureRunning();
    const startedAt = Date.now();
    expect(children).toHaveLength(1);
    expect(children[0]!.exitCode).toBeNull();

    // Wait past the freeze deadline but before idle SIGTERM.
    await new Promise((r) => setTimeout(r, 130));
    expect(freezeFiredAt).toBeGreaterThanOrEqual(startedAt + 80);
    // Child should still be alive — freeze flushes caches but never
    // SIGTERMs.
    expect(children[0]!.exitCode).toBeNull();

    // Wait past the idle deadline. The child should now be SIGTERMed
    // by the supervisor's idle handler.
    await new Promise((r) => setTimeout(r, 200));
    expect(children[0]!.exitCode).toBe(0);
  });

  it('does NOT call onFreeze when freezeTimeoutMs is unset (legacy single-stage idle)', async () => {
    const children: FakeChild[] = [];
    const fakeSpawn = (() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });

    let freezeFired = false;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake',
        args: [],
        baseUrl: 'http://127.0.0.1:9992',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 1_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 150,
      // freezeTimeoutMs intentionally unset.
      onFreeze: () => {
        freezeFired = true;
      },
      onLog: () => {},
    });

    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 200));
    expect(freezeFired).toBe(false);
    expect(children[0]!.exitCode).toBe(0);
  });

  it('markUsed during freeze window resets the timers cleanly', async () => {
    const children: FakeChild[] = [];
    const fakeSpawn = (() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });

    let freezeCount = 0;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake',
        args: [],
        baseUrl: 'http://127.0.0.1:9993',
      }),
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      startupTimeoutMs: 1_000,
      healthIntervalMs: 10_000_000,
      freezeTimeoutMs: 80,
      idleTimeoutMs: 250,
      onFreeze: () => {
        freezeCount++;
      },
      onLog: () => {},
    });

    await sup.ensureRunning();
    // Activity bumps lastUsedAt → both timers should restart and the
    // freeze should NOT fire at 80ms from initial start.
    await new Promise((r) => setTimeout(r, 50));
    sup.markUsed();
    await new Promise((r) => setTimeout(r, 60));
    // Total elapsed ~110ms. Without markUsed we'd be 30ms past
    // freeze; with the reset the new freeze timer fires 80ms after
    // the markUsed call (at ~130ms total), so it shouldn't have
    // fired yet.
    expect(freezeCount).toBe(0);
    expect(children[0]!.exitCode).toBeNull();

    // Wait past the new freeze deadline (~110+80=190ms total) — fire
    // expected.
    await new Promise((r) => setTimeout(r, 90));
    expect(freezeCount).toBe(1);

    await sup.stop();
  });

  it('splits tqdm-style \\r progress repaints into one onRawLine call per step', async () => {
    // Regression: mlx chunked prefill prints `Prefill: NN%|…` as a tqdm
    // bar that repaints in place with bare `\r` and no `\n` until 100%.
    // Splitting on `\n` alone buffered the whole prefill arc into one
    // record, so the classifier never saw per-step progress and the mlx
    // idle watchdog killed the turn mid-prefill. We must split on `\r`
    // too. See supervisor.ts onChunk.
    let stdoutHandler: ((buf: Buffer) => void) | undefined;
    const child = makeFakeChild();
    child.stdout = {
      on: (ev: string, fn: (buf: Buffer) => void) => {
        if (ev === 'data') stdoutHandler = fn;
      },
    };
    const fakeSpawn = (() =>
      child as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;

    const rawLines: string[] = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: 'fake-engine',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      onRawLine: (line) => rawLines.push(line),
    });

    await sup.ensureRunning();
    expect(stdoutHandler).toBeDefined();

    // One chunk carrying three in-place repaints (\r-separated, no
    // trailing \n) — exactly what tqdm flushes mid-prefill.
    stdoutHandler!(
      Buffer.from(
        'Prefill:  11%|█▏        | 2048/18173 [00:20<02:39, 101.13tok/s]\r' +
          'Prefill:  23%|██▎       | 4096/18173 [00:39<02:15, 103.67tok/s]\r' +
          'Prefill:  34%|███▍      | 6144/18173 [00:59<01:55, 103.93tok/s]\r',
      ),
    );

    const prefillLines = rawLines.filter((l) => l.includes('Prefill:'));
    expect(prefillLines).toHaveLength(3);
    expect(prefillLines[0]).toContain('11%');
    expect(prefillLines[1]).toContain('23%');
    expect(prefillLines[2]).toContain('34%');
    // No interior \r should survive into a classified line.
    for (const l of prefillLines) expect(l).not.toContain('\r');

    await sup.stop();
  });

  it('retains a bounded crash tail and emits a structured unexpected-exit snapshot', async () => {
    let stderrHandler: ((buf: Buffer) => void) | undefined;
    const child = makeFakeChild(55121);
    child.stderr = {
      on: (ev: string, fn: (buf: Buffer) => void) => {
        if (ev === 'data') stderrHandler = fn;
      },
    };
    const fakeSpawn = (() =>
      child as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const logs: string[] = [];
    const exits: Array<import('./supervisor.js').NativeEngineExitSnapshot> = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/gezel/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
        diagnostics: {
          model: 'qwen3.6-35b-a3b-q4',
          cudaArchitectures: '121a-real',
        },
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      logPrefix: '[llama-server]',
      onLog: (line) => logs.push(line),
      onExit: (snapshot) => {
        exits.push(snapshot);
      },
      psRunner: async () => [],
    });

    await sup.ensureRunning();
    const requestStartedAt = Date.now();
    // Split the fatal line across chunks. The line reader must join it before
    // classification rather than inserting a log prefix in the middle.
    stderrHandler!(Buffer.from('CUDA error: invalid '));
    stderrHandler!(Buffer.from('argument\n  current device: 0\n'));
    child.emitExit(null, 'SIGABRT');

    const snapshot = await sup.waitForUnexpectedExitSince(requestStartedAt, 0);
    expect(snapshot).toMatchObject({
      pid: 55121,
      code: null,
      signal: 'SIGABRT',
      expected: false,
      panicKind: 'cuda-invalid-argument',
      diagnostics: {
        model: 'qwen3.6-35b-a3b-q4',
        cudaArchitectures: '121a-real',
      },
    });
    expect(snapshot?.outputTail).toContain('CUDA error: invalid argument');
    expect(snapshot?.outputTail).toContain('current device: 0');
    expect(exits).toHaveLength(1);
    expect(logs.some((line) => line.includes('"panicKind":"cuda-invalid-argument"'))).toBe(true);
    expect(sup.currentBaseUrl()).toBeUndefined();
  });

  it('classifies a silent SIGILL during startup as an unrunnable build', async () => {
    // The field case: a CUDA build that could not execute on the host CPU
    // died before binding its port and printed nothing at all, so the
    // crash surfaced as a bare signal name with no attribution.
    const child = makeFakeChild(51832);
    child.stderr = { on: () => {} };
    // The exit listeners only exist once the supervisor has spawned, so
    // the crash has to be emitted after that — not synchronously after
    // ensureRunning(), which never resolves on this path.
    let markSpawned: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const fakeSpawn = ((): unknown => {
      queueMicrotask(() => markSpawned());
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const exits: Array<import('./supervisor.js').NativeEngineExitSnapshot> = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/Gezel/native-bin/linux-x64-cuda/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      // Never becomes ready — the child dies mid-startup.
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      onExit: (snapshot) => void exits.push(snapshot),
      psRunner: async () => [],
    });

    const started = sup.ensureRunning().catch(() => {});
    await spawned;
    child.emitExit(null, 'SIGILL');
    await started;

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      signal: 'SIGILL',
      expected: false,
      reachedReady: false,
      panicKind: 'illegal-instruction',
    });
  });

  it('does not relabel a diagnosed CUDA fault that happens to exit via SIGILL', async () => {
    // SIGILL is also how a `ud2` trap on a C++ abort path surfaces. When
    // the engine already said what went wrong, that explanation wins —
    // otherwise a recoverable CUDA fault would quarantine the backend.
    let stderrHandler: ((buf: Buffer) => void) | undefined;
    const child = makeFakeChild(51833);
    child.stderr = {
      on: (ev: string, fn: (buf: Buffer) => void) => {
        if (ev === 'data') stderrHandler = fn;
      },
    };
    const fakeSpawn = (() =>
      child as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >) as unknown as typeof import('node:child_process').spawn;
    const exits: Array<import('./supervisor.js').NativeEngineExitSnapshot> = [];
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/gezel/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      onExit: (snapshot) => void exits.push(snapshot),
      psRunner: async () => [],
    });

    await sup.ensureRunning();
    stderrHandler!(Buffer.from('CUDA error: out of memory\n'));
    child.emitExit(null, 'SIGILL');

    expect(exits[0]).toMatchObject({
      signal: 'SIGILL',
      reachedReady: true,
      panicKind: 'cuda-out-of-memory',
    });
  });
});

describe('NativeEngineSupervisor — startup recovery (recoverStartup)', () => {
  beforeEach(() => __resetLiveEnginePidsForTest());

  it('classifies Vulkan out-of-device-memory lines', () => {
    expect(
      classifyNativeEnginePanic('ggml_vulkan: Device memory allocation of size 1024 failed'),
    ).toMatchObject({ kind: 'vulkan-out-of-memory' });
    expect(classifyNativeEnginePanic('terminate called: vk::OutOfDeviceMemoryError')).toMatchObject(
      { kind: 'vulkan-out-of-memory' },
    );
    expect(classifyNativeEnginePanic('ggml_vulkan: found 1 Vulkan devices')).toBeUndefined();
  });

  /** A fake child whose stderr can carry engine diagnostics into the classifier. */
  function makeDiagnosableChild(pid: number) {
    let stderrHandler: ((buf: Buffer) => void) | undefined;
    const child = makeFakeChild(pid);
    child.stderr = {
      on: (ev: string, fn: (buf: Buffer) => void) => {
        if (ev === 'data') stderrHandler = fn;
      },
    };
    return {
      child,
      dieOfGpuOom(line = 'ggml_cuda: CUDA error: out of memory') {
        stderrHandler?.(Buffer.from(`${line}\n`));
        child.emitExit(1, null);
      },
    };
  }

  it('retries with the owner-degraded plan after a GPU OOM startup death', async () => {
    const recoverCalls: Array<{ panicKind?: string | undefined; attempt: number }> = [];
    const spawned: ReturnType<typeof makeDiagnosableChild>[] = [];
    const fakeSpawn = (() => {
      const entry = makeDiagnosableChild(6100 + spawned.length);
      spawned.push(entry);
      if (spawned.length === 1) queueMicrotask(() => entry.dieOfGpuOom());
      return entry.child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/gezel/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      // The OOM'd first child never answers /health; its replacement does.
      fetchImpl: async () => {
        if (spawned.length >= 2) return new Response('ok', { status: 200 });
        throw new Error('connection refused');
      },
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => [],
      recoverStartup: (info) => {
        recoverCalls.push(info);
        return true;
      },
    });

    await sup.ensureRunning();
    expect(spawned).toHaveLength(2);
    expect(recoverCalls).toEqual([{ panicKind: 'cuda-out-of-memory', attempt: 0 }]);
  });

  it('gives up once the recovery cap is exhausted', async () => {
    const recoverCalls: number[] = [];
    const spawned: ReturnType<typeof makeDiagnosableChild>[] = [];
    const fakeSpawn = (() => {
      const entry = makeDiagnosableChild(6200 + spawned.length);
      spawned.push(entry);
      queueMicrotask(() => entry.dieOfGpuOom());
      return entry.child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/gezel/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
      startupTimeoutMs: 2_000,
      healthIntervalMs: 10_000_000,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => [],
      recoverStartup: ({ attempt }) => {
        recoverCalls.push(attempt);
        return true;
      },
    });

    await expect(sup.ensureRunning()).rejects.toThrow(/before becoming ready/);
    // Initial start + two recoveries, then the cap stops the ladder without
    // consulting the hook a third time.
    expect(spawned).toHaveLength(3);
    expect(recoverCalls).toEqual([0, 1]);
  });

  it('does not consult the hook when the failure is not a recoverable start', async () => {
    let recoverCalled = false;
    const fakeSpawn = (() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    }) as unknown as typeof import('node:child_process').spawn;
    const sup = new NativeEngineSupervisor({
      resolveLaunch: async () => ({
        command: '/opt/gezel/gezel-llama-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9999',
      }),
      spawn: fakeSpawn,
      idleTimeoutMs: 0,
      onLog: () => {},
      psRunner: async () => [],
      recoverStartup: () => {
        recoverCalled = true;
        return true;
      },
    });

    await expect(sup.ensureRunning()).rejects.toThrow(/EACCES/);
    expect(recoverCalled).toBe(false);
  });
});
