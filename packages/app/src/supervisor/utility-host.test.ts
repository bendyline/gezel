import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  type UtilityChild,
  type UtilityChildMessage,
  type UtilityParentMessage,
  prewarmUtilityService,
  serviceHostFromEnv,
  startUtilityHostedService,
} from './utility-host.js';

class FakeChild extends EventEmitter implements UtilityChild {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: UtilityParentMessage[] = [];
  killed = false;
  env: NodeJS.ProcessEnv | undefined;

  constructor(private readonly onMessage: (child: FakeChild, m: UtilityParentMessage) => void) {
    super();
  }

  postMessage(message: UtilityParentMessage): void {
    this.sent.push(message);
    queueMicrotask(() => this.onMessage(this, message));
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 137));
    return true;
  }

  reply(message: UtilityChildMessage): void {
    this.emit('message', message);
  }
}

function forkOf(child: FakeChild) {
  return vi.fn((_path: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    child.env = options.env;
    return child;
  });
}

const READY: UtilityChildMessage = {
  type: 'ready',
  port: 6228,
  token: 'client-token',
  cert: '---PEM---',
  bootMs: 812,
};

/** A child that boots on `start` and exits cleanly on `stop`. */
function wellBehaved(): FakeChild {
  return new FakeChild((child, message) => {
    if (message.type === 'start') child.reply(READY);
    if (message.type === 'stop') child.emit('exit', 0);
  });
}

const base = {
  entryPath: '/app/dist/utility-service-entry.js',
  serviceModuleUrl: 'file:///svc/dist/index.js',
  startOptions: { home: '/home/.gezel', role: 'user' as const, preferCanonicalPort: true },
  env: { GEZEL_HOME: '/home/.gezel', ELECTRON_RUN_AS_NODE: '1' },
};

describe('serviceHostFromEnv', () => {
  it('opts in only on the exact value', () => {
    expect(serviceHostFromEnv({ GEZEL_SERVICE_HOST: 'utility' })).toBe('utility');
    expect(serviceHostFromEnv({ GEZEL_SERVICE_HOST: '1' })).toBe('in-process');
    expect(serviceHostFromEnv({})).toBe('in-process');
  });
});

describe('startUtilityHostedService', () => {
  it('resolves the connection the child reports and forwards the start options', async () => {
    const child = wellBehaved();
    const hosted = await startUtilityHostedService({ ...base, fork: forkOf(child) });

    expect(hosted).toMatchObject({
      baseUrl: 'https://127.0.0.1:6228',
      token: 'client-token',
      cert: '---PEM---',
      pid: 4242,
      bootMs: 812,
    });
    expect(child.sent[0]).toEqual({
      type: 'start',
      serviceModuleUrl: 'file:///svc/dist/index.js',
      options: base.startOptions,
      env: { GEZEL_HOME: '/home/.gezel' },
      unset: [],
    });
  });

  it('never passes RUN_AS_NODE to the child', async () => {
    const child = wellBehaved();
    await startUtilityHostedService({ ...base, fork: forkOf(child) });
    expect(child.env).toEqual({ GEZEL_HOME: '/home/.gezel' });
    expect(child.sent[0]).toMatchObject({ env: { GEZEL_HOME: '/home/.gezel' } });
  });

  it('uses http when the service has no certificate', async () => {
    const child = new FakeChild((c, m) => {
      if (m.type === 'start') c.reply({ ...READY, cert: null });
    });
    const hosted = await startUtilityHostedService({ ...base, fork: forkOf(child) });
    expect(hosted.baseUrl).toBe('http://127.0.0.1:6228');
  });

  it('rejects with the child error when startup fails', async () => {
    const child = new FakeChild((c, m) => {
      if (m.type === 'start')
        c.reply({ type: 'start-failed', message: 'ERR_MODULE_NOT_FOUND hono' });
    });
    await expect(startUtilityHostedService({ ...base, fork: forkOf(child) })).rejects.toThrow(
      /ERR_MODULE_NOT_FOUND hono/,
    );
  });

  it('rejects when the child dies before it is ready', async () => {
    const child = new FakeChild((c, m) => {
      if (m.type === 'start') c.emit('exit', 1);
    });
    await expect(startUtilityHostedService({ ...base, fork: forkOf(child) })).rejects.toThrow(
      /exited with code 1 before it was ready/,
    );
  });

  it('kills a child that never becomes ready', async () => {
    const child = new FakeChild(() => {});
    await expect(
      startUtilityHostedService({ ...base, fork: forkOf(child), readyTimeoutMs: 10 }),
    ).rejects.toThrow(/did not become ready/);
    expect(child.killed).toBe(true);
  });

  it('relays the service restart requests', async () => {
    const onRestartRequested = vi.fn();
    const child = wellBehaved();
    await startUtilityHostedService({ ...base, fork: forkOf(child), onRestartRequested });
    child.reply({ type: 'restart-requested', reason: 'config reset' });
    expect(onRestartRequested).toHaveBeenCalledWith('config reset');
  });

  it('asks for a restart when the ready service dies on its own', async () => {
    const onRestartRequested = vi.fn();
    const child = wellBehaved();
    await startUtilityHostedService({ ...base, fork: forkOf(child), onRestartRequested });
    child.emit('exit', 134);
    expect(onRestartRequested).toHaveBeenCalledWith(
      'service process exited unexpectedly (code 134)',
    );
  });

  it('stops gracefully without reporting the exit as a crash', async () => {
    const onRestartRequested = vi.fn();
    const child = wellBehaved();
    const hosted = await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      onRestartRequested,
    });
    await hosted.stop();
    expect(child.sent.at(-1)).toEqual({ type: 'stop' });
    expect(child.killed).toBe(false);
    expect(onRestartRequested).not.toHaveBeenCalled();
  });

  it('kills a child that ignores stop', async () => {
    const child = new FakeChild((c, m) => {
      if (m.type === 'start') c.reply(READY);
    });
    const hosted = await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      stopTimeoutMs: 10,
    });
    await hosted.stop();
    expect(child.killed).toBe(true);
  });

  it('forwards child output', async () => {
    const onOutput = vi.fn();
    const child = wellBehaved();
    await startUtilityHostedService({ ...base, fork: forkOf(child), onOutput });
    child.stdout.write('[perf] ready\n');
    child.stderr.write('warn\n');
    expect(onOutput).toHaveBeenCalledWith('[perf] ready\n', 'stdout');
    expect(onOutput).toHaveBeenCalledWith('warn\n', 'stderr');
  });
});

describe('prewarmUtilityService', () => {
  /** Forked with the environment as it was before the supervisor prepared it. */
  const early = { GEZEL_HOME: '/home/.gezel', GEZEL_NODE_PATH: '/inherited/node' };
  /** The supervisor has since stamped a binary and cleared the unvouched node path. */
  const prepared = { GEZEL_HOME: '/home/.gezel', GEZEL_DUCKDB_BIN: '/bin/duckdb' };

  it('starts importing at once, and the start reuses that process', async () => {
    const child = wellBehaved();
    const fork = forkOf(child);
    const prewarmed = prewarmUtilityService({ ...base, env: early, fork });
    expect(child.sent).toEqual([{ type: 'preload', serviceModuleUrl: base.serviceModuleUrl }]);

    const hosted = await startUtilityHostedService({ ...base, env: prepared, fork, prewarmed });

    expect(fork).toHaveBeenCalledTimes(1);
    expect(hosted.pid).toBe(4242);
    expect(hosted.prewarm).toEqual({ importMs: null });
    expect(child.sent[1]).toEqual({
      type: 'start',
      serviceModuleUrl: base.serviceModuleUrl,
      options: base.startOptions,
      env: prepared,
      unset: ['GEZEL_NODE_PATH'],
    });
  });

  it('reports an import that finished before the start', async () => {
    const child = wellBehaved();
    const fork = forkOf(child);
    const prewarmed = prewarmUtilityService({ ...base, env: early, fork });
    child.reply({ type: 'preloaded', importMs: 640 });

    const hosted = await startUtilityHostedService({ ...base, env: prepared, fork, prewarmed });

    expect(hosted.prewarm).toEqual({ importMs: 640 });
  });

  it('forks a fresh process when the prewarmed one died', async () => {
    const dead = wellBehaved();
    const prewarmed = prewarmUtilityService({ ...base, env: early, fork: forkOf(dead) });
    dead.emit('exit', 1);
    const fresh = wellBehaved();
    const fork = forkOf(fresh);

    const hosted = await startUtilityHostedService({ ...base, env: prepared, fork, prewarmed });

    expect(fork).toHaveBeenCalledTimes(1);
    expect(fresh.sent[0]).toMatchObject({ type: 'start', unset: [] });
    expect(hosted.prewarm).toBeNull();
  });

  it('discards a prewarm that imported a different service tree', async () => {
    const warm = wellBehaved();
    const prewarmed = prewarmUtilityService({
      ...base,
      serviceModuleUrl: null,
      env: early,
      fork: forkOf(warm),
    });
    const fresh = wellBehaved();

    await startUtilityHostedService({ ...base, env: prepared, fork: forkOf(fresh), prewarmed });

    expect(warm.killed).toBe(true);
    expect(fresh.sent[0]).toMatchObject({ type: 'start', serviceModuleUrl: base.serviceModuleUrl });
  });

  it('kills an unused prewarm, and leaves a taken one alone', async () => {
    const unused = wellBehaved();
    prewarmUtilityService({ ...base, env: early, fork: forkOf(unused) }).dispose();
    expect(unused.killed).toBe(true);

    const used = wellBehaved();
    const fork = forkOf(used);
    const prewarmed = prewarmUtilityService({ ...base, env: early, fork });
    await startUtilityHostedService({ ...base, env: prepared, fork, prewarmed });
    prewarmed.dispose();
    expect(used.killed).toBe(false);
  });
});
