import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DarwinAutostartDeps,
  buildPlist,
  install,
  isCurrent,
  registeredHome,
  restart,
  stop,
} from './darwin.js';

const opts = {
  nodePath: '/Users/tester/.gezel/bin/node',
  pnpmPath: '/Users/tester/.gezel/bin/pnpm-runtime/bin/pnpm.mjs',
  gezeldPath: '/Library/Application Support/Gezel/service/dist/bin/gezeld.js',
  gezelHome: '/Users/tester/.gezel',
};

/**
 * A launchd that behaves like the real one where it matters: `bootout`
 * returns while the job is still leaving the domain, and a `bootstrap` in that
 * window fails with the Input/output error the PKG postinstall polls around.
 */
function fakeLaunchd(initiallyLoaded: boolean) {
  const state = { loaded: initiallyLoaded, unloadingPolls: 0, calls: [] as string[][] };
  const exec: NonNullable<DarwinAutostartDeps['exec']> = async (_command, args) => {
    state.calls.push([...args]);
    const verb = args[0];
    if (verb === 'print') {
      if (state.unloadingPolls > 0) {
        state.unloadingPolls -= 1;
        if (state.unloadingPolls === 0) state.loaded = false;
        return { stdout: 'state = exiting', stderr: '' };
      }
      if (!state.loaded) throw new Error('Could not find service');
      return { stdout: 'state = running', stderr: '' };
    }
    if (verb === 'bootout') {
      if (!state.loaded) throw new Error('Boot-out failed: 3: No such process');
      state.unloadingPolls = 2;
      return { stdout: '', stderr: '' };
    }
    if (verb === 'bootstrap') {
      if (state.loaded) throw new Error('Bootstrap failed: 5: Input/output error');
      state.loaded = true;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected launchctl ${verb}`);
  };
  return { state, exec };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-launchagents-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(exec: NonNullable<DarwinAutostartDeps['exec']>): DarwinAutostartDeps {
  return { exec, launchAgentsDir: dir, uid: 501, pollMs: 1, unloadWaitMs: 1_000 };
}

describe('macOS LaunchAgent', () => {
  it('relaunches only an unsuccessful exit, so a stood-down daemon stays down', () => {
    const plist = buildPlist(opts);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>GEZEL_AUTOSTART<\/key>\s*<string>1<\/string>/);
  });

  it('waits for the old agent to leave launchd before loading the new one', async () => {
    const launchd = fakeLaunchd(true);
    await install(opts, deps(launchd.exec));
    expect(launchd.state.loaded).toBe(true);
    expect(launchd.state.calls.map((c) => c[0])).toEqual([
      'bootout',
      'print',
      'print',
      'print',
      'bootstrap',
    ]);
    expect(launchd.state.calls.at(-1)).toEqual([
      'bootstrap',
      'gui/501',
      join(dir, 'com.bendyline.gezel.plist'),
    ]);
    await expect(readFile(join(dir, 'com.bendyline.gezel.plist'), 'utf8')).resolves.toBe(
      buildPlist(opts),
    );
  });

  it('restarts an unloaded agent and stops one without deleting its plist', async () => {
    const launchd = fakeLaunchd(false);
    await writeFile(join(dir, 'com.bendyline.gezel.plist'), buildPlist(opts));
    await restart(deps(launchd.exec));
    expect(launchd.state.loaded).toBe(true);
    await stop(deps(launchd.exec));
    expect(launchd.state.loaded).toBe(false);
    await expect(registeredHome(deps(launchd.exec))).resolves.toBe(opts.gezelHome);
  });

  it('reports the home a registered plist serves, unescaping XML', async () => {
    const launchd = fakeLaunchd(false);
    await expect(registeredHome(deps(launchd.exec))).resolves.toBeNull();
    await writeFile(
      join(dir, 'com.bendyline.gezel.plist'),
      buildPlist({ ...opts, gezelHome: '/Users/Tom & Jerry/.gezel' }),
    );
    await expect(registeredHome(deps(launchd.exec))).resolves.toBe('/Users/Tom & Jerry/.gezel');
  });

  it('treats the pre-fix plist pinned to ~/.gezel/service as outdated', async () => {
    const launchd = fakeLaunchd(false);
    // The shape every Settings → Daemon toggle wrote before this change.
    const legacy = buildPlist({
      ...opts,
      gezeldPath: '/Users/tester/.gezel/service/dist/bin/gezeld.js',
    })
      .replace(/\s*<key>GEZEL_AUTOSTART<\/key>\s*<string>1<\/string>/, '')
      .replace(/<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/, '<true/>');
    await writeFile(join(dir, 'com.bendyline.gezel.plist'), legacy);
    await expect(isCurrent(opts, deps(launchd.exec))).resolves.toBe(false);
    await expect(registeredHome(deps(launchd.exec))).resolves.toBe(opts.gezelHome);
    await writeFile(join(dir, 'com.bendyline.gezel.plist'), buildPlist(opts));
    await expect(isCurrent(opts, deps(launchd.exec))).resolves.toBe(true);
  });
});
