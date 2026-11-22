import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { restoreGitControl, snapshotGitControl } from './git-control-guard.js';

let root: string;
let ws: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-git-guard-'));
  ws = join(root, 'ws');
  await mkdir(join(ws, '.git', 'hooks'), { recursive: true });
  await writeFile(join(ws, '.git', 'config'), '[core]\n\tbare = false\n');
  await writeFile(join(ws, '.git', 'hooks', 'pre-commit.sample'), 'sample');
  await mkdir(join(ws, 'checkout'), { recursive: true });
  await writeFile(join(ws, 'checkout', '.git'), 'gitdir: ../../real/.git\n');
  await writeFile(join(ws, 'a.txt'), 'before');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFile(join(ws, path), 'utf8');

it('puts back what a run changed in .git and removes what it planted', async () => {
  const snapshot = await snapshotGitControl(ws);

  // What a model-written script with workspace write access could do.
  await writeFile(join(ws, '.git', 'config'), '[core]\n\tfsmonitor = "touch pwned"\n');
  await writeFile(join(ws, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ntouch pwned\n');
  await mkdir(join(ws, '.git', 'info'), { recursive: true });
  await writeFile(join(ws, '.git', 'info', 'attributes'), '* filter=pwn\n');
  await writeFile(join(ws, 'checkout', '.git'), 'gitdir: ../evil\n');
  await mkdir(join(ws, 'planted', '.git'), { recursive: true });
  await writeFile(join(ws, 'planted', '.git', 'config'), '[core]\n\tfsmonitor = pwn\n');
  await writeFile(join(ws, 'a.txt'), 'after');

  const note = await restoreGitControl(snapshot);

  expect(await read('.git/config')).toBe('[core]\n\tbare = false\n');
  expect(existsSync(join(ws, '.git', 'hooks', 'post-merge'))).toBe(false);
  expect(existsSync(join(ws, '.git', 'info', 'attributes'))).toBe(false);
  expect(await read('.git/hooks/pre-commit.sample')).toBe('sample');
  expect(await read('checkout/.git')).toBe('gitdir: ../../real/.git\n');
  expect(existsSync(join(ws, 'planted', '.git'))).toBe(false);
  // Set aside, never deleted: git no longer reads it, and nothing is lost.
  expect(await read('planted/.git.gezel-set-aside/config')).toBe('[core]\n\tfsmonitor = pwn\n');
  // Everything else is the script's to change.
  expect(await read('a.txt')).toBe('after');
  expect(note).toMatch(/Put back/);
  expect(note).toContain('.git/config');
  expect(note).toContain('Set aside planted/.git as planted/.git.gezel-set-aside');
  expect(note).toContain('Nothing in it was deleted');
});

it('keeps a repository the script moved, with its history', async () => {
  // Moving proj-a/ into archive/ used to read as a planted repository, and
  // the restore deleted archive/proj-a/.git: unpushed commits, branches and
  // stashes with it.
  await mkdir(join(ws, 'proj-a', '.git', 'objects'), { recursive: true });
  await writeFile(join(ws, 'proj-a', '.git', 'config'), '[remote "origin"]\n\turl = x\n');
  await writeFile(join(ws, 'proj-a', '.git', 'objects', 'pack'), 'history');
  const snapshot = await snapshotGitControl(ws);

  await mkdir(join(ws, 'archive'), { recursive: true });
  await rename(join(ws, 'proj-a'), join(ws, 'archive', 'proj-a'));

  expect(await restoreGitControl(snapshot)).toBeNull();
  expect(await read('archive/proj-a/.git/objects/pack')).toBe('history');
  expect(await read('archive/proj-a/.git/config')).toBe('[remote "origin"]\n\turl = x\n');
});

it('puts back the control files of a moved repository the script also changed', async () => {
  await mkdir(join(ws, 'proj-b', '.git', 'hooks'), { recursive: true });
  await writeFile(join(ws, 'proj-b', '.git', 'config'), '[core]\n\tbare = false\n\n');
  const snapshot = await snapshotGitControl(ws);

  await rename(join(ws, 'proj-b'), join(ws, 'proj-c'));
  await writeFile(join(ws, 'proj-c', '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch pwned\n');

  const note = await restoreGitControl(snapshot);
  expect(existsSync(join(ws, 'proj-c', '.git', 'hooks', 'post-checkout'))).toBe(false);
  expect(await read('proj-c/.git/config')).toBe('[core]\n\tbare = false\n\n');
  expect(note).toContain('proj-c/.git/hooks/post-checkout');
});

it('still removes a .git pointer file the run planted', async () => {
  const snapshot = await snapshotGitControl(ws);
  await mkdir(join(ws, 'sub'), { recursive: true });
  await writeFile(join(ws, 'sub', '.git'), 'gitdir: ../../evil\n');
  const note = await restoreGitControl(snapshot);
  expect(existsSync(join(ws, 'sub', '.git'))).toBe(false);
  expect(note).toContain('sub/.git');
});

it('leaves alone a repository the capped scan had not reached before the run', async () => {
  await mkdir(join(ws, 'late', '.git'), { recursive: true });
  await writeFile(join(ws, 'late', '.git', 'config'), '[core]\n');
  const snapshot = await snapshotGitControl(ws);
  // As if the scan had stopped at its folder cap before reaching late/.
  const truncated = {
    ...snapshot,
    truncated: true,
    // A real snapshot comes long after the repository was made.
    takenAt: snapshot.takenAt + 60_000,
    entries: new Map([...snapshot.entries].filter(([path]) => !path.includes('late'))),
  };
  const born = (await lstat(join(ws, 'late', '.git'))).birthtimeMs;
  const note = await restoreGitControl(truncated);
  if (born > 0) {
    expect(existsSync(join(ws, 'late', '.git'))).toBe(true);
    expect(note).toBeNull();
  }
});

it('says nothing when the run left .git alone', async () => {
  const snapshot = await snapshotGitControl(ws);
  await writeFile(join(ws, 'a.txt'), 'after');
  expect(await restoreGitControl(snapshot)).toBeNull();
});

it('leaves a hooks folder that was already a link where it points', async () => {
  const shared = join(ws, 'shared-hooks');
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'pre-commit'), 'team hook');
  await rm(join(ws, '.git', 'hooks'), { recursive: true, force: true });
  await symlink(
    shared,
    join(ws, '.git', 'hooks'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const snapshot = await snapshotGitControl(ws);

  expect(await restoreGitControl(snapshot)).toBeNull();
  expect((await lstat(join(ws, '.git', 'hooks'))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(shared, 'pre-commit'), 'utf8')).toBe('team hook');
});

it('never deletes or writes through a link planted in place of the hooks folder', async () => {
  const outside = join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'keep.txt'), 'not the workspace');
  const snapshot = await snapshotGitControl(ws);

  await rm(join(ws, '.git', 'hooks'), { recursive: true, force: true });
  await symlink(
    outside,
    join(ws, '.git', 'hooks'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await restoreGitControl(snapshot);

  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('not the workspace');
  expect((await lstat(join(ws, '.git', 'hooks'))).isSymbolicLink()).toBe(false);
  expect(await read('.git/hooks/pre-commit.sample')).toBe('sample');
});
