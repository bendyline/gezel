import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverVSCodeProfiles, vscodeUserDir } from './profiles.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('VS Code profile discovery', () => {
  it('finds the default profile and named profile directories', async () => {
    const userDir = await mkdtemp(join(tmpdir(), 'vscode profiles '));
    roots.push(userDir);
    const workDir = join(userDir, 'profiles', 'work-id');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'profile.json'), JSON.stringify({ name: 'Work' }));

    const profiles = await discoverVSCodeProfiles({ product: 'code', userDir });

    expect(profiles).toEqual([
      expect.objectContaining({ id: 'code:default', label: 'Default profile' }),
      expect.objectContaining({
        id: 'code:work-id',
        label: 'Work',
        configPath: join(workDir, 'chatLanguageModels.json'),
      }),
    ]);
  });

  it('resolves the conventional product-specific user directory on each platform', () => {
    expect(
      vscodeUserDir({
        product: 'code',
        platform: 'win32',
        home: 'C:\\Users\\Test',
        env: { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' },
      }),
    ).toContain(join('Code', 'User'));
    expect(
      vscodeUserDir({ product: 'code-insiders', platform: 'darwin', home: '/Users/test' }),
    ).toContain(join('Code - Insiders', 'User'));
    expect(
      vscodeUserDir({
        product: 'code',
        platform: 'linux',
        home: '/home/test',
        env: { XDG_CONFIG_HOME: '/custom/config' },
      }),
    ).toBe(join('/custom/config', 'Code', 'User'));
  });
});
