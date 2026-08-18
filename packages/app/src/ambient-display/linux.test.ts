import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { capability, detectDesktop, getCurrentWallpaper, setWallpaper } from './linux.js';

type ExecCall = { command: string; args: readonly string[] };

function recordingExec(stdout = ''): {
  exec: (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout, stderr: '' };
    },
  };
}

describe('detectDesktop', () => {
  it('maps XDG_CURRENT_DESKTOP variants to families', () => {
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toMatchObject({
      kind: 'gsettings',
      schema: 'org.gnome.desktop.background',
    });
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'GNOME' }).kind).toBe('gsettings');
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' })).toMatchObject({
      kind: 'gsettings',
      schema: 'org.cinnamon.desktop.background',
    });
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'KDE' }).kind).toBe('plasma');
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland' }).kind).toBe('unknown');
    expect(detectDesktop({}).kind).toBe('unknown');
  });
});

describe('linux setWallpaper', () => {
  it('sets light + dark + options via gsettings with a file URI on GNOME', async () => {
    const { exec, calls } = recordingExec();
    const imagePath = '/home/test user/.gezel/ambient/applied-a.png';
    await setWallpaper(imagePath, {
      exec,
      env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
    });
    const gsettings = calls.filter((c) => c.command === 'gsettings');
    // `pathToFileURL` is platform-relative: on win32 it resolves the rooted
    // POSIX literal against the current drive, yielding `file:///D:/home/...`.
    // setWallpaper only ever runs on Linux (index.ts dispatches by platform),
    // so derive the expectation the same way the source does and assert the
    // contract that actually matters — a file:// URI with the space escaped —
    // rather than pinning a POSIX-only string that fails on a Windows checkout.
    const uri = pathToFileURL(imagePath).href;
    expect(uri.startsWith('file:///')).toBe(true);
    expect(uri.endsWith('/test%20user/.gezel/ambient/applied-a.png')).toBe(true);
    expect(gsettings.map((c) => c.args)).toEqual([
      ['set', 'org.gnome.desktop.background', 'picture-uri', uri],
      ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri],
      ['set', 'org.gnome.desktop.background', 'picture-options', 'zoom'],
      ['set', 'org.gnome.desktop.screensaver', 'picture-uri', uri],
    ]);
  });

  it('uses plasma-apply-wallpaperimage on KDE with the raw path', async () => {
    const { exec, calls } = recordingExec();
    await setWallpaper('/home/u/.gezel/ambient/applied-b.png', {
      exec,
      env: { XDG_CURRENT_DESKTOP: 'KDE' },
    });
    expect(calls).toEqual([
      { command: 'plasma-apply-wallpaperimage', args: ['/home/u/.gezel/ambient/applied-b.png'] },
    ]);
  });

  it('refuses to guess-execute on unknown desktops', async () => {
    const { exec, calls } = recordingExec();
    await expect(
      setWallpaper('/tmp/x.png', { exec, env: { XDG_CURRENT_DESKTOP: 'Hyprland' } }),
    ).rejects.toThrow(/not supported/);
    expect(calls).toEqual([]);
  });
});

describe('linux capability', () => {
  it('degrades to command-missing when the tool is absent', async () => {
    const exec = vi.fn(async () => {
      const err = new Error('spawn gsettings ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const cap = await capability({ exec, env: { XDG_CURRENT_DESKTOP: 'GNOME' } });
    expect(cap).toMatchObject({ supported: false, reason: 'command-missing' });
  });

  it('reports no restore on plasma, restore on gsettings', async () => {
    const { exec } = recordingExec();
    expect(await capability({ exec, env: { XDG_CURRENT_DESKTOP: 'KDE' } })).toMatchObject({
      supported: true,
      canRestore: false,
    });
    expect(await capability({ exec, env: { XDG_CURRENT_DESKTOP: 'GNOME' } })).toMatchObject({
      supported: true,
      canRestore: true,
    });
  });
});

describe('linux getCurrentWallpaper', () => {
  it('unquotes GVariant strings and captures light + dark', async () => {
    const { exec } = recordingExec(`'file:///usr/share/backgrounds/day.png'\n`);
    const value = await getCurrentWallpaper({ exec, env: { XDG_CURRENT_DESKTOP: 'GNOME' } });
    expect(value).toEqual({
      light: 'file:///usr/share/backgrounds/day.png',
      dark: 'file:///usr/share/backgrounds/day.png',
    });
  });

  it('returns null on plasma', async () => {
    const { exec } = recordingExec();
    expect(await getCurrentWallpaper({ exec, env: { XDG_CURRENT_DESKTOP: 'KDE' } })).toBeNull();
  });
});
