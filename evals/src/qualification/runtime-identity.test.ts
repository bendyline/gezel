import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityChanges } from '../api-campaign/identity.ts';
import { workspaceRuntimeIdentity } from './runtime-identity.ts';

describe('installed eval runtime identity', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-runtime-identity-'));
    for (const name of ['core', 'client', 'unused']) {
      const dir = join(root, 'packages', name);
      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(join(dir, 'dist/index.js'), 'original build');
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name,
          type: 'module',
          exports: './dist/index.js',
          ...(name === 'client' ? { dependencies: { core: 'workspace:*', external: '^1' } } : {}),
        }),
      );
    }
    await mkdir(join(root, 'evals'));
    await writeFile(
      join(root, 'evals/package.json'),
      JSON.stringify({ name: 'evals', dependencies: { client: 'workspace:*' } }),
    );
    await mkdir(join(root, 'node_modules/external'), { recursive: true });
    await writeFile(
      join(root, 'node_modules/external/package.json'),
      '{"name":"external","version":"1"}',
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ignores unbuilt source, unrelated packages, release scripts, lockfiles and debug maps', async () => {
    const before = await workspaceRuntimeIdentity(root);
    await mkdir(join(root, 'packages/core/src'));
    await writeFile(join(root, 'packages/core/src/index.ts'), 'new source');
    await writeFile(join(root, 'packages/unused/dist/index.js'), 'unused build');
    await writeFile(join(root, 'packages/core/dist/index.js.map'), 'debug map');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'new requested dependency');
    const pkgPath = join(root, 'packages/client/package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    await writeFile(
      pkgPath,
      JSON.stringify({
        ...pkg,
        scripts: { build: 'new build' },
        dependencies: { ...pkg.dependencies, external: '^2' },
      }),
    );
    expect(await workspaceRuntimeIdentity(root)).toEqual(before);
  });

  it.each([
    'packages/core/dist/index.js',
    'packages/client/dist/index.js',
    'node_modules/external/package.json',
  ])('detects installed input changes at %s', async (path) => {
    const before = await workspaceRuntimeIdentity(root);
    await writeFile(
      join(root, path),
      path.endsWith('package.json') ? '{"name":"external","version":"2"}' : 'new build',
    );
    const changes = identityChanges(
      { runtime: before },
      { runtime: await workspaceRuntimeIdentity(root) },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.paths.length).toBeGreaterThan(0);
  });

  it('detects module-routing changes and refuses a missing required build', async () => {
    const before = await workspaceRuntimeIdentity(root);
    await writeFile(
      join(root, 'packages/core/package.json'),
      '{"name":"core","exports":"./dist/other.js"}',
    );
    expect((await workspaceRuntimeIdentity(root)).sha256).not.toBe(before.sha256);
    await rm(join(root, 'packages/core/dist'), { recursive: true });
    await expect(workspaceRuntimeIdentity(root)).rejects.toThrow();
  });

  it('checks standard gate scripts that execute directly without a dist directory', async () => {
    const dir = join(root, 'packages/stdlib');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"@bendyline/gezel-script-stdlib"}');
    await writeFile(
      join(root, 'evals/package.json'),
      '{"name":"evals","dependencies":{"@bendyline/gezel-script-stdlib":"workspace:*"}}',
    );
    await writeFile(join(dir, 'scripts/gate.ts'), 'original');
    const before = await workspaceRuntimeIdentity(root);
    await writeFile(join(dir, 'scripts/gate.test.ts'), 'test');
    expect(await workspaceRuntimeIdentity(root)).toEqual(before);
    await writeFile(join(dir, 'scripts/gate.ts'), 'new gate');
    expect((await workspaceRuntimeIdentity(root)).sha256).not.toBe(before.sha256);
  });
});
