import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectOpenCodeBinary, openCodeBinaryCandidates } from './binary.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-opencode-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeFakeOpenCode(path: string, version: string, exitCode = 0): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\necho ${version}\r\nexit /b ${exitCode}\r\n`, 'utf8');
    return;
  }
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${version}'\nexit ${exitCode}\n`, 'utf8');
  await chmod(path, 0o755);
}

describe('detectOpenCodeBinary', () => {
  it('finds the default installer copy when a desktop PATH omits it', async () => {
    const name = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const path = join(dir, '.opencode', 'bin', name);
    await makeFakeOpenCode(path, '1.18.18');

    const detection = await detectOpenCodeBinary({
      env: { PATH: '' },
      home: dir,
      platform: process.platform,
    });

    expect(detection).toEqual({ installed: true, path, version: '1.18.18' });
  });

  it('prefers PATH over a conventional installer copy', async () => {
    const name = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const pathDir = join(dir, 'path-bin');
    const onPath = join(pathDir, name);
    const installed = join(dir, '.opencode', 'bin', name);
    await makeFakeOpenCode(onPath, '2.0.0');
    await makeFakeOpenCode(installed, '1.0.0');

    const detection = await detectOpenCodeBinary({
      env: { PATH: pathDir },
      home: dir,
      platform: process.platform,
    });

    expect(detection.path?.toLowerCase()).toBe(onPath.toLowerCase());
    expect(detection.version).toBe('2.0.0');
  });

  it('continues past a broken PATH entry to a working installer copy', async () => {
    const name = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const pathDir = join(dir, 'path-bin');
    const onPath = join(pathDir, name);
    const installed = join(dir, '.opencode', 'bin', name);
    await makeFakeOpenCode(onPath, 'broken', 7);
    await makeFakeOpenCode(installed, '1.18.18');

    const detection = await detectOpenCodeBinary({
      env: { PATH: pathDir },
      home: dir,
      platform: process.platform,
    });

    expect(detection).toEqual({ installed: true, path: installed, version: '1.18.18' });
  });

  it('reports an explicit broken override instead of silently falling back', async () => {
    const name = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const override = join(dir, 'override', name);
    const installed = join(dir, '.opencode', 'bin', name);
    await makeFakeOpenCode(override, 'broken', 9);
    await makeFakeOpenCode(installed, '1.18.18');

    const detection = await detectOpenCodeBinary({
      override,
      env: { PATH: '' },
      home: dir,
      platform: process.platform,
    });

    expect(detection.installed).toBe(false);
    expect(detection.path).toBe(override);
  });

  it('reports missing when PATH and conventional locations are empty', async () => {
    const detection = await detectOpenCodeBinary({
      env: { PATH: '' },
      home: dir,
      platform: 'aix',
    });

    expect(detection.installed).toBe(false);
    expect(detection.error).toContain('not found on this computer');
  });
});

describe('openCodeBinaryCandidates', () => {
  it('covers the documented installer and common macOS/Linux package paths', () => {
    const env = {
      OPENCODE_INSTALL_DIR: '/custom/opencode',
      XDG_BIN_DIR: '/xdg/bin',
    };
    const darwin = openCodeBinaryCandidates({ env, home: '/Users/ada', platform: 'darwin' });
    const linux = openCodeBinaryCandidates({ env, home: '/home/ada', platform: 'linux' });

    expect(darwin).toEqual(
      expect.arrayContaining([
        '/custom/opencode/opencode',
        '/xdg/bin/opencode',
        '/Users/ada/bin/opencode',
        '/Users/ada/.opencode/bin/opencode',
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode',
      ]),
    );
    expect(linux).toEqual(
      expect.arrayContaining([
        '/home/ada/bin/opencode',
        '/home/ada/.opencode/bin/opencode',
        '/home/ada/.local/bin/opencode',
        '/usr/bin/opencode',
        '/snap/bin/opencode',
        '/home/linuxbrew/.linuxbrew/bin/opencode',
      ]),
    );
  });

  it('covers direct, Scoop, npm, Chocolatey, and WinGet installs on Windows', () => {
    const home = 'C:\\Users\\Ada';
    const candidates = openCodeBinaryCandidates({
      home,
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
        ProgramData: 'C:\\ProgramData',
      },
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        win32.join(home, '.opencode', 'bin', 'opencode'),
        win32.join(home, '.opencode', 'bin', 'opencode.exe'),
        win32.join(home, 'scoop', 'shims', 'opencode.exe'),
        win32.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
        win32.join('C:\\ProgramData', 'chocolatey', 'bin', 'opencode.exe'),
        win32.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'opencode.exe'),
      ]),
    );
  });
});
