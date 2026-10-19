import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type UtilityChild,
  type UtilityChildMessage,
  type UtilityParentMessage,
  defaultUtilityEntryPath,
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

  it('reports a ready service that dies on its own as a crash, not a restart request', async () => {
    // A restart request waits for the user; a crash must be acted on at once.
    const onRestartRequested = vi.fn();
    const onUnexpectedExit = vi.fn();
    const child = wellBehaved();
    await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      onRestartRequested,
      onUnexpectedExit,
    });
    child.emit('exit', 134);
    expect(onUnexpectedExit).toHaveBeenCalledWith('service process exited unexpectedly (code 134)');
    expect(onRestartRequested).not.toHaveBeenCalled();
  });

  it('kills at once, without reporting its own kill as a crash', async () => {
    const onUnexpectedExit = vi.fn();
    const child = new FakeChild((c, m) => {
      if (m.type === 'start') c.reply(READY);
    });
    const hosted = await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      onUnexpectedExit,
    });
    await hosted.kill();
    expect(child.killed).toBe(true);
    expect(child.sent.some((m) => m.type === 'stop')).toBe(false);
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    await hosted.kill();
  });

  it('stops gracefully without reporting the exit as a crash', async () => {
    const onRestartRequested = vi.fn();
    const onUnexpectedExit = vi.fn();
    const child = wellBehaved();
    const hosted = await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      onRestartRequested,
      onUnexpectedExit,
    });
    await hosted.stop();
    expect(child.sent.at(-1)).toEqual({ type: 'stop' });
    expect(child.killed).toBe(false);
    expect(onRestartRequested).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('escalates to SIGKILL when the process does not act on SIGTERM', async () => {
    // A stopped (SIGSTOP) or wedged process: Electron's kill changes nothing.
    const child = new FakeChild((c, m) => {
      if (m.type === 'start') c.reply(READY);
    });
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const forceKill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 9));
    });
    const hosted = await startUtilityHostedService({
      ...base,
      fork: forkOf(child),
      killGraceMs: 10,
      forceKill,
    });
    await hosted.kill();
    expect(forceKill).toHaveBeenCalledWith(4242);
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

describe('packaging the utility entry', () => {
  it('points at the unpacked entry when the app runs from app.asar', () => {
    expect(
      defaultUtilityEntryPath(
        'file:///Applications/Gezel.app/Contents/Resources/app.asar/dist/main.js',
      ),
    ).toBe(
      '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/dist/utility-service-entry.js',
    );
    expect(defaultUtilityEntryPath('file:///repo/packages/app/dist/main.js')).toBe(
      '/repo/packages/app/dist/utility-service-entry.js',
    );
  });

  // The builder configs list shipped files explicitly, and the MAS config
  // replaces the base lists rather than extending them. A build without the
  // entry has nothing for utilityProcess.fork to load, and nothing in dev
  // would notice.
  it.each(['electron-builder.yml', 'electron-builder.mas.yml'])('%s ships it unpacked', (name) => {
    const config = readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');
    const files = config.slice(
      config.indexOf('\nfiles:\n'),
      config.indexOf('\n\n', config.indexOf('\nfiles:\n') + 1),
    );
    const asarStart = config.indexOf('\nasarUnpack:\n');
    const asarUnpack = config.slice(asarStart, config.indexOf('\n\n', asarStart + 1));
    expect(files).toContain('- dist/utility-service-entry.js');
    expect(asarUnpack).toContain('- dist/utility-service-entry.js');
  });
});
