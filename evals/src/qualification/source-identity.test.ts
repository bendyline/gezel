import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityChanges } from '../api-campaign/identity.ts';
import { sourceIdentity } from './source-identity.ts';

describe('source content identity', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const commit = () =>
    git(
      '-c',
      'user.name=Eval Test',
      '-c',
      'user.email=eval@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-source-identity-'));
    git('init');
    await writeFile(join(dir, 'source.ts'), 'original');
    await writeFile(join(dir, '.gitignore'), 'output/\n');
    git('add', '.');
    commit();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the same identity across staging and committing the same bytes', async () => {
    await writeFile(join(dir, 'source.ts'), 'changed');
    await writeFile(join(dir, 'new.ts'), 'new source');
    const before = await sourceIdentity(dir);
    git('add', '.');
    expect((await sourceIdentity(dir)).sha256).toBe(before.sha256);
    commit();
    const after = await sourceIdentity(dir);
    expect(after.head).not.toBe(before.head);
    expect(after.sha256).toBe(before.sha256);
    expect(identityChanges({ source: before }, { source: after })).toEqual([]);
  });

  it('reports added, edited and deleted source paths', async () => {
    const before = await sourceIdentity(dir);
    await writeFile(join(dir, 'source.ts'), 'different');
    await writeFile(join(dir, 'added.ts'), 'addition');
    await rm(join(dir, '.gitignore'));
    const after = await sourceIdentity(dir);
    expect(identityChanges({ source: before }, { source: after })).toEqual([
      { component: 'source', paths: ['.gitignore', 'added.ts', 'source.ts'] },
    ]);
    git('add', '-A');
    commit();
    expect((await sourceIdentity(dir)).sha256).toBe(after.sha256);
  });

  it('includes executable mode and hashes links without reading their targets', async () => {
    const before = await sourceIdentity(dir);
    await chmod(join(dir, 'source.ts'), 0o755);
    expect((await sourceIdentity(dir)).sha256).not.toBe(before.sha256);
    await symlink('/a/nonexistent/private/file', join(dir, 'link'));
    const linked = await sourceIdentity(dir);
    expect(linked.manifest.link).toBeDefined();
    git('add', '.');
    expect((await sourceIdentity(dir)).sha256).toBe(linked.sha256);
  });

  it('does not reinterpret old diff-based baselines as content hashes', async () => {
    const current = await sourceIdentity(dir);
    expect(
      identityChanges(
        { source: { head: current.head, workingTreeSha256: current.sha256 } },
        { source: current },
      ),
    ).toEqual([{ component: 'source', paths: [] }]);
  });
});
