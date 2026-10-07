import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIDDEN_LAUNCH_ARG,
  getStartAtLogin,
  launchedAtLogin,
  linuxAutostartEntry,
  setStartAtLogin,
} from './start-at-login.js';

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'gezel-login-'));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function fakeApp(wasOpenedAtLogin = false) {
  let openAtLogin = false;
  return {
    getLoginItemSettings: vi.fn(() => ({ openAtLogin, wasOpenedAtLogin })),
    setLoginItemSettings: vi.fn((s: { openAtLogin: boolean }) => {
      openAtLogin = s.openAtLogin;
    }),
  };
}

describe('start at login', () => {
  it('registers a hidden login item on Windows', async () => {
    const app = fakeApp();
    const deps = { platform: 'win32' as const, app, execPath: 'C:\\Gezel\\Gezel.exe', configDir };

    await setStartAtLogin(deps, true);

    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [HIDDEN_LAUNCH_ARG],
    });
    expect(getStartAtLogin(deps)).toBe(true);
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ args: [HIDDEN_LAUNCH_ARG] });
  });

  it('uses the plain login item on macOS, which reports a login launch itself', async () => {
    const app = fakeApp(true);
    const deps = {
      platform: 'darwin' as const,
      app,
      execPath: '/Applications/Gezel.app',
      configDir,
    };

    await setStartAtLogin(deps, true);

    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(launchedAtLogin(deps, [])).toBe(true);
    expect(launchedAtLogin({ platform: 'darwin', app: fakeApp(false) }, [])).toBe(false);
  });

  it('writes and removes an XDG autostart entry on Linux', async () => {
    const app = fakeApp();
    const deps = { platform: 'linux' as const, app, execPath: '/opt/Gezel/gezel', configDir };

    await setStartAtLogin(deps, true);
    const entry = await readFile(join(configDir, 'autostart', 'gezel.desktop'), 'utf8');
    expect(entry).toContain('Exec="/opt/Gezel/gezel" --hidden');
    expect(getStartAtLogin(deps)).toBe(true);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();

    await setStartAtLogin(deps, false);
    expect(getStartAtLogin(deps)).toBe(false);
  });

  it('treats the hidden argument as a login launch everywhere', () => {
    expect(launchedAtLogin({ platform: 'linux', app: fakeApp() }, ['gezel', '--hidden'])).toBe(
      true,
    );
    expect(launchedAtLogin({ platform: 'win32', app: fakeApp(true) }, ['Gezel.exe'])).toBe(false);
  });

  it('quotes an executable path with spaces and shell characters', () => {
    expect(linuxAutostartEntry('/home/a b/Gezel "x" $y.AppImage')).toContain(
      'Exec="/home/a b/Gezel \\"x\\" \\$y.AppImage" --hidden',
    );
  });
});
