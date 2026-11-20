import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

/**
 * A `.git` folder is git's own configuration, and settings there run
 * commands the next time git runs: a gezel-written `.git/config` once ran as
 * the daemon's account through the indexer's `git ls-files`. No write path
 * through the Store may change one, whoever asks.
 */

let fixture: string;
let store: Store;
let projectId: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'gezel-git-control-'));
  store = new Store({ home: join(fixture, 'home') });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'Git control' })).id;
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const refused = { code: 'git-control' };
const gezel = { gezelId: 'g1' };

describe('workspace', () => {
  async function workspace(): Promise<string> {
    const dir = await store.projectWorkspaceDir(projectId);
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), '[core]\n');
    await writeFile(join(dir, 'a.txt'), 'a');
    return dir;
  }

  it.each([
    ['write', () => store.writeProjectWorkspaceFile(projectId, '.git/config', 'x', gezel)],
    ['write in any case', () => store.writeProjectWorkspaceFile(projectId, '.GIT/config', 'x')],
    [
      'write a nested repository',
      () => store.writeProjectWorkspaceFile(projectId, 'sub/.git/hooks/post-merge', 'x', gezel),
    ],
    [
      'write a .git pointer file',
      () => store.writeProjectWorkspaceFile(projectId, 'sub/.git', 'gitdir: ../evil', gezel),
    ],
    [
      'write binary',
      () => store.writeProjectWorkspaceBinary(projectId, '.git/hooks/x', Buffer.from('x')),
    ],
    ['make a folder', () => store.mkdirProjectWorkspace(projectId, 'sub/.git', gezel)],
    [
      'move a file in',
      () => store.renameProjectWorkspacePath(projectId, 'a.txt', '.git/config', gezel),
    ],
    [
      'move the folder away',
      () => store.renameProjectWorkspacePath(projectId, '.git', 'old-git', gezel),
    ],
    ['copy a file in', () => store.copyProjectWorkspacePath(projectId, 'a.txt', 'b/.git/config')],
    ['delete', () => store.rmProjectWorkspacePath(projectId, '.git/config', {}, gezel)],
    [
      'apply a proposal',
      () =>
        store.writeProjectWorkspaceFile(projectId, '.git/config', 'x', undefined, {
          userInitiated: true,
        }),
    ],
  ])('refuses to %s', async (_label, op) => {
    const dir = await workspace();
    await expect(op()).rejects.toMatchObject(refused);
    expect(await readFile(join(dir, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(existsSync(join(dir, 'sub'))).toBe(false);
  });

  it('refuses a link that leads into .git', async () => {
    const dir = await workspace();
    await symlink(
      join(dir, '.git'),
      join(dir, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      store.writeProjectWorkspaceFile(projectId, 'alias/config', 'x', gezel),
    ).rejects.toMatchObject(refused);
    expect(await readFile(join(dir, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it.runIf(process.platform === 'win32')(
    'refuses the 8.3 short name Windows gives .git, where the volume makes one',
    async () => {
      const dir = await workspace();
      if (!existsSync(join(dir, 'GIT~1'))) return;
      await expect(
        store.writeProjectWorkspaceFile(projectId, 'GIT~1/config', 'x', gezel),
      ).rejects.toMatchObject(refused);
      expect(await readFile(join(dir, '.git', 'config'), 'utf8')).toBe('[core]\n');
    },
  );

  it('still writes files whose names only resemble .git', async () => {
    const dir = await workspace();
    for (const path of ['.gitignore', '.github/workflows/ci.yml', 'docs/.git-notes.md']) {
      await store.writeProjectWorkspaceFile(projectId, path, 'ok', gezel);
      expect(await readFile(join(dir, path), 'utf8')).toBe('ok');
    }
  });
});

describe('artifacts', () => {
  it.each([
    ['write', () => store.writeProjectArtifact(projectId, '.git/config', 'x')],
    [
      'write binary',
      () => store.writeProjectArtifactBinary(projectId, 'repo/.git/hooks/x', Buffer.from('x')),
    ],
    ['make a folder', () => store.createProjectArtifactFolder(projectId, 'repo/.git')],
  ])('refuses to %s', async (_label, op) => {
    await expect(op()).rejects.toMatchObject(refused);
    expect(existsSync(join(store.projectArtifactsDir(projectId), 'repo'))).toBe(false);
  });
});

describe('the shared library', () => {
  it.each([
    ['write', () => store.writeDocument('.git/config', 'x', { gezelId: 'g1' })],
    ['write binary', () => store.writeDocumentBinary('notes/.git/config', Buffer.from('x'))],
    ['make a folder', () => store.createDocumentFolder('notes/.git')],
  ])('refuses to %s', async (_label, op) => {
    await expect(op()).rejects.toMatchObject(refused);
    expect(existsSync(join(store.documentsDir(), '.git'))).toBe(false);
    expect(existsSync(join(store.documentsDir(), 'notes'))).toBe(false);
  });
});
