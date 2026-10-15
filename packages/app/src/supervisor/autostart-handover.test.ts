import { describe, expect, it, vi } from 'vitest';
import type { AutostartInstallOptions, ManagedAutostart } from '../autostart/index.js';
import { type AutostartRuntime, handOverToAutostart } from './autostart-handover.js';

const HOME = '/Users/tester/.gezel';
const SHIPPED = '1.26279.87';
const SHARED_TREE = '/Library/Application Support/Gezel/service/dist/bin/gezeld.js';
const STALE_TREE = '/Users/tester/.gezel/service/dist/bin/gezeld.js';

const current: AutostartInstallOptions = {
  nodePath: `${HOME}/bin/node`,
  pnpmPath: `${HOME}/bin/pnpm-runtime/bin/pnpm.mjs`,
  gezeldPath: SHARED_TREE,
  gezelHome: HOME,
};

interface Daemon {
  pid: number;
  version: string;
}

/**
 * One OS account: an autostart unit, the daemon it runs, and optionally a
 * daemon something else started. Whoever holds the home first keeps it; a
 * unit daemon that finds it taken stands down, as gezeld now does.
 */
function world(init: {
  unitTree?: string | null;
  unitHome?: string;
  unitRunning?: string | null;
  foreign?: Daemon | null;
  treeVersions?: Record<string, string>;
}) {
  const versions = init.treeVersions ?? { [SHARED_TREE]: SHIPPED, [STALE_TREE]: '1.26226.50' };
  let nextPid = 500;
  const state = {
    unitTree: init.unitTree === undefined ? SHARED_TREE : init.unitTree,
    unitHome: init.unitHome ?? HOME,
    unit: (init.unitRunning
      ? { pid: nextPid++, version: init.unitRunning }
      : null) as Daemon | null,
    foreign: init.foreign ?? null,
  };
  const startUnit = () => {
    state.unit = null;
    if (state.foreign || !state.unitTree) return;
    state.unit = { pid: nextPid++, version: versions[state.unitTree] ?? 'unknown' };
  };
  const autostart = {
    registeredHome: vi.fn(async () => (state.unitTree ? state.unitHome : null)),
    isCurrent: vi.fn(async (o: AutostartInstallOptions) => state.unitTree === o.gezeldPath),
    install: vi.fn(async (o: AutostartInstallOptions) => {
      state.unitTree = o.gezeldPath;
      startUnit();
    }),
    restart: vi.fn(async () => startUnit()),
    stop: vi.fn(async () => {
      state.unit = null;
    }),
  } satisfies ManagedAutostart;
  const holder = () => state.foreign ?? state.unit;
  const toRuntime = (d: Daemon): AutostartRuntime => ({
    pid: d.pid,
    baseUrl: `https://127.0.0.1:${d.pid}`,
    token: `t${d.pid}`,
    cert: null,
  });
  const stopPid = vi.fn(async (pid: number) => {
    if (state.foreign?.pid === pid) state.foreign = null;
    return true;
  });
  const opts = {
    home: HOME,
    autostart,
    definition: vi.fn(async () => current),
    shippedVersion: SHIPPED as string | null,
    readRuntime: async () => {
      const d = holder();
      return d ? toRuntime(d) : null;
    },
    isProcessAlive: (pid: number) => state.unit?.pid === pid || state.foreign?.pid === pid,
    healthVersion: async (rt: AutostartRuntime) => {
      const d = [state.unit, state.foreign].find((x) => x?.pid === rt.pid);
      if (!d) throw new Error('connection refused');
      return d.version;
    },
    stopPid,
    timeoutMs: 200,
    pollMs: 1,
  };
  return { state, autostart, opts, stopPid };
}

describe('handOverToAutostart', () => {
  it('leaves the app alone when no autostart unit is registered', async () => {
    const w = world({ unitTree: null });
    await expect(handOverToAutostart(w.opts)).resolves.toEqual({ kind: 'not-registered' });
    expect(w.opts.definition).not.toHaveBeenCalled();
    expect(w.autostart.stop).not.toHaveBeenCalled();
  });

  it('never touches a unit registered for a different home', async () => {
    const w = world({ unitTree: STALE_TREE, unitHome: '/Users/tester/.gezel-dev' });
    await expect(handOverToAutostart(w.opts)).resolves.toEqual({ kind: 'not-registered' });
    expect(w.autostart.install).not.toHaveBeenCalled();
    expect(w.autostart.stop).not.toHaveBeenCalled();
  });

  // The 2026-10-06 incident: a LaunchAgent written after the shared service
  // tree shipped still pinned ~/.gezel/service, which nothing refreshed.
  it('re-registers a unit pinned to a stale tree and adopts the shipped daemon', async () => {
    const w = world({ unitTree: STALE_TREE, unitRunning: '1.26226.50' });
    const result = await handOverToAutostart(w.opts);
    expect(result).toMatchObject({ kind: 'adopted', version: SHIPPED, repaired: true });
    expect(w.autostart.install).toHaveBeenCalledWith(current);
    expect(w.state.unitTree).toBe(SHARED_TREE);
    expect(w.stopPid).not.toHaveBeenCalled();
  });

  it('restarts a current unit still running the release the installer replaced', async () => {
    const w = world({ unitRunning: '1.26250.12' });
    const stalePid = w.state.unit?.pid;
    const result = await handOverToAutostart(w.opts);
    expect(result).toMatchObject({ kind: 'adopted', version: SHIPPED, repaired: false });
    expect(w.autostart.install).not.toHaveBeenCalled();
    expect(w.autostart.stop).toHaveBeenCalled();
    expect(w.autostart.restart).toHaveBeenCalledTimes(1);
    // The unit's own daemon goes down through launchd/systemd, never by pid:
    // a signal is exactly what KeepAlive answers with a relaunch.
    expect(w.stopPid).not.toHaveBeenCalledWith(stalePid);
  });

  it('starts a registered unit that stood down earlier', async () => {
    const w = world({ unitRunning: null });
    await expect(handOverToAutostart(w.opts)).resolves.toMatchObject({
      kind: 'adopted',
      version: SHIPPED,
    });
    expect(w.autostart.restart).toHaveBeenCalledTimes(1);
  });

  it('clears an old daemon the unit does not own before restarting the unit', async () => {
    const w = world({ unitRunning: null, foreign: { pid: 42, version: '1.26226.50' } });
    const result = await handOverToAutostart(w.opts);
    expect(result).toMatchObject({ kind: 'adopted', version: SHIPPED });
    expect(w.stopPid).toHaveBeenCalledWith(42);
  });

  it('declines, and stops the unit, when it cannot reach the shipped version', async () => {
    const w = world({
      unitRunning: '1.26226.50',
      treeVersions: { [SHARED_TREE]: '1.26226.50' },
    });
    const result = await handOverToAutostart(w.opts);
    expect(result).toMatchObject({ kind: 'declined' });
    expect(w.autostart.restart).toHaveBeenCalledTimes(2);
    expect(w.state.unit).toBeNull();
  });

  it('declines without re-registering when the current service cannot be described', async () => {
    const w = world({ unitTree: STALE_TREE, unitRunning: '1.26226.50' });
    w.opts.definition.mockRejectedValueOnce(
      new Error('verified bundled Node runtime is unavailable'),
    );
    const result = await handOverToAutostart(w.opts);
    expect(result).toMatchObject({ kind: 'declined' });
    expect(String((result as { reason: string }).reason)).toMatch(/bundled Node/);
    expect(w.autostart.install).not.toHaveBeenCalled();
    expect(w.state.unit).toBeNull();
  });

  it('adopts any healthy daemon when the app cannot read its own version', async () => {
    const w = world({ unitRunning: '1.26250.12' });
    w.opts.shippedVersion = null;
    await expect(handOverToAutostart(w.opts)).resolves.toMatchObject({
      kind: 'adopted',
      version: '1.26250.12',
    });
    expect(w.autostart.restart).not.toHaveBeenCalled();
  });
});
