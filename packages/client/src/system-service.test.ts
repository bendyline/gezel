import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_SERVICE_PORT,
  electronNativeBinCandidates,
  readSystemServiceEndpoint,
  readSystemServiceRuntime,
  systemServiceHome,
  systemSharedAssetsDir,
} from './system-service.js';

const homes: string[] = [];

it('uses the unprivileged MAAT port below the default OS ephemeral ranges', () => {
  expect(SYSTEM_SERVICE_PORT).toBe(6228);
});

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function runtimeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-system-runtime-'));
  homes.push(home);
  await mkdir(join(home, 'runtime'));
  return home;
}

describe('systemServiceHome', () => {
  it('resolves every packaged platform without using host path semantics', () => {
    expect(systemServiceHome('win32', { ProgramData: 'D:\\MachineData' })).toBe(
      'D:\\MachineData\\Gezel',
    );
    expect(systemServiceHome('darwin')).toBe('/Library/Application Support/Gezel');
    expect(systemServiceHome('linux')).toBe('/var/lib/gezel');
    expect(systemServiceHome('freebsd')).toBeNull();
    expect(systemSharedAssetsDir('win32', { ProgramData: 'D:\\MachineData' })).toBe(
      'D:\\MachineData\\Gezel\\assets',
    );
    expect(systemSharedAssetsDir('linux')).toBe('/var/lib/gezel/assets');
  });

  it('returns conventional Electron native roots as untrusted discovery hints', () => {
    expect(
      electronNativeBinCandidates('win32', {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      }),
    ).toEqual([
      'C:\\Program Files\\Gezel\\resources\\app.asar.unpacked\\native-bin',
      'C:\\Users\\test\\AppData\\Local\\Programs\\Gezel\\resources\\app.asar.unpacked\\native-bin',
    ]);
    expect(electronNativeBinCandidates('darwin')).toEqual([
      '/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin',
    ]);
  });
});

describe('system service runtime discovery', () => {
  it('reads endpoint metadata without requiring the desktop credential', async () => {
    const home = await runtimeHome();
    await writeFile(join(home, 'runtime', 'port'), '6228\n');
    await writeFile(join(home, 'runtime', 'cert.pem'), 'certificate');

    await expect(readSystemServiceEndpoint(home)).resolves.toEqual({
      port: 6228,
      baseUrl: 'https://127.0.0.1:6228',
      cert: 'certificate',
      home,
    });
    await expect(readSystemServiceRuntime(home)).resolves.toBeNull();
  });

  it('adds the scoped desktop token only for the Electron runtime reader', async () => {
    const home = await runtimeHome();
    await writeFile(join(home, 'runtime', 'port'), '6228\n');
    await writeFile(join(home, 'runtime', 'auth-token'), 'desktop-token\n');

    await expect(readSystemServiceRuntime(home)).resolves.toEqual({
      port: 6228,
      baseUrl: 'http://127.0.0.1:6228',
      cert: null,
      home,
      token: 'desktop-token',
    });
  });

  it('rejects invalid and out-of-range ports', async () => {
    const home = await runtimeHome();
    await writeFile(join(home, 'runtime', 'port'), '70000\n');
    await expect(readSystemServiceEndpoint(home)).resolves.toBeNull();
  });
});
