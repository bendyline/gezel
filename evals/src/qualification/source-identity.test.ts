import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('scopes campaigns to live eval inputs while retaining full repository provenance', async () => {
    await mkdir(join(dir, 'evals/src'), { recursive: true });
    await writeFile(join(dir, 'evals/src/runner.ts'), 'runner');
    const before = await sourceIdentity(dir, 'eval');
    const provenance = await sourceIdentity(dir);
    for (const path of [
      'docs/note.md',
      '.github/workflows/build.yml',
      'packages/service/src/worker.ts',
      'scratch.txt',
      'pnpm-lock.yaml',
      'evals/src/worker.test.ts',
      'evals/src/worker.ts.tmp',
    ]) {
      const { dirname } = await import('node:path');
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), 'unrelated change');
    }
    expect((await sourceIdentity(dir)).sha256).not.toBe(provenance.sha256);
    expect(
      identityChanges({ source: before }, { source: await sourceIdentity(dir, 'eval') }),
    ).toEqual([]);
    await rm(join(dir, 'scratch.txt'));
    await rm(join(dir, 'evals/src/worker.ts.tmp'));
    git('add', '.');
    commit();
    expect(
      identityChanges({ source: before }, { source: await sourceIdentity(dir, 'eval') }),
    ).toEqual([]);
  });

  it('still detects changed, added and deleted evaluator code, fixtures, consent and launch inputs', async () => {
    const { dirname } = await import('node:path');
    const paths = [
      'evals/src/runner.ts',
      'evals/src/fixtures/brief.md',
      'evals/src/fixtures/data.json',
      'evals/user-scripts/consent.json',
      'scripts/dependency-lease.mjs',
      'evals/tsconfig.json',
    ];
    for (const path of paths) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), 'before');
    }
    const before = await sourceIdentity(dir, 'eval');
    for (const path of paths) await writeFile(join(dir, path), 'after');
    await rm(join(dir, paths[0]!));
    await writeFile(join(dir, 'evals/src/new.ts'), 'new');
    expect(
      identityChanges({ source: before }, { source: await sourceIdentity(dir, 'eval') }),
    ).toEqual([{ component: 'source', paths: [...paths, 'evals/src/new.ts'].sort() }]);
    expect(
      identityChanges(
        { source: await sourceIdentity(dir) },
        { source: await sourceIdentity(dir, 'eval') },
      ),
    ).toHaveLength(1);
  });
});
