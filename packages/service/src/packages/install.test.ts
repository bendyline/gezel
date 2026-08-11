import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runPnpm } = vi.hoisted(() => ({ runPnpm: vi.fn() }));
vi.mock('./pnpm.js', () => ({ runPnpm }));

import { installPackage } from './install.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-package-install-'));
  await mkdir(join(home, 'projects', 'safe-project'), { recursive: true });
  await writeFile(
    join(home, 'projects', 'safe-project', 'project.json'),
    JSON.stringify({ id: 'safe-project', name: 'Safe project' }),
  );
  runPnpm.mockReset();
  runPnpm.mockResolvedValue({ ok: true, code: 0, stdout: '', stderr: '', log: 'installed' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('installPackage', () => {
  it('passes a validated registry spec after an argv terminator', async () => {
    const result = await installPackage({
      home,
      projectId: 'safe-project',
      packageName: '@types/node',
      version: '^24',
    });

    expect(result.ok).toBe(true);
    expect(runPnpm).toHaveBeenCalledWith(['add', '--', '@types/node@^24'], {
      cwd: join(home, 'projects', 'safe-project'),
    });
  });

  it.each([
    { packageName: '--global' },
    { packageName: 'https://example.test/pkg.tgz' },
    { packageName: 'zod', version: 'file:../outside' },
  ])('rejects unsafe package input before spawning: $packageName@$version', async (request) => {
    const result = await installPackage({
      home,
      projectId: 'safe-project',
      ...request,
    });

    expect(result.ok).toBe(false);
    expect(runPnpm).not.toHaveBeenCalled();
  });

  it('rejects a traversal-shaped project id before spawning', async () => {
    const result = await installPackage({
      home,
      projectId: '..\\outside',
      packageName: 'zod',
    });

    expect(result.ok).toBe(false);
    expect(runPnpm).not.toHaveBeenCalled();
  });

  it('requires a canonical existing project before spawning', async () => {
    const result = await installPackage({
      home,
      projectId: 'missing-project',
      packageName: 'zod',
    });

    expect(result).toMatchObject({ ok: false, error: 'project not found' });
    expect(runPnpm).not.toHaveBeenCalled();
  });
});
