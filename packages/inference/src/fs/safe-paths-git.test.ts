import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNotGitControlPath, isGitControlPath, isGitControlTarget } from './safe-paths.js';

describe('isGitControlPath', () => {
  it.each([
    '.git',
    '.git/config',
    'sub/.git/hooks/post-merge',
    '.GIT/config',
    'a\\.Git\\config',
    '.git./config',
    '.git /config',
    '.git::$INDEX_ALLOCATION/config',
  ])('treats %j as inside .git', (path) => {
    expect(isGitControlPath(path)).toBe(true);
  });

  it.each(['.gitignore', '.github/workflows/ci.yml', 'docs/.git-notes.md', 'git/config', '..git'])(
    'leaves %j alone',
    (path) => {
      expect(isGitControlPath(path)).toBe(false);
    },
  );
});

describe('assertNotGitControlPath', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gezel-git-control-'));
    await mkdir(join(base, '.git'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('refuses a path that reaches .git through a link', async () => {
    await symlink(
      join(base, '.git'),
      join(base, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await isGitControlTarget(base, 'alias/config')).toBe(true);
    await expect(assertNotGitControlPath(base, 'alias/config')).rejects.toMatchObject({
      code: 'git-control',
    });
  });

  it('allows an ordinary path, existing or not', async () => {
    await expect(assertNotGitControlPath(base, 'src/new/file.ts')).resolves.toBeUndefined();
    expect(await isGitControlTarget(base, 'notes.md')).toBe(false);
  });
});
