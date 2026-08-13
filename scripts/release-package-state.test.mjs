import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  clearReleasePackageState,
  materializeReleasePackageState,
  writeReleasePackageState,
} from './release-package-state.mjs';

test('materializes computed sibling versions only while a package is packed', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gezel-release-state-'));
  const packageDir = join(repoRoot, 'packages', 'cli');
  const manifestPath = join(packageDir, 'package.json');
  const packageName = '@bendyline/gezel-cli';
  const packageVersion = '1.0.1';
  const workspaceSource = `${JSON.stringify(
    {
      name: packageName,
      version: packageVersion,
      dependencies: { '@bendyline/gezel': 'workspace:*' },
    },
    null,
    2,
  )}\n`;
  const releaseSource = workspaceSource.replace('workspace:*', '1.0.1');

  await mkdir(packageDir, { recursive: true });
  await writeFile(manifestPath, workspaceSource);
  writeReleasePackageState({ repoRoot, packageName, packageVersion, source: releaseSource });

  try {
    const materialized = materializeReleasePackageState({
      repoRoot,
      packageName,
      packageVersion,
      manifestPath,
      sourceManifest: workspaceSource,
    });
    assert.equal(materialized.materialized, true);
    assert.equal(await readFile(manifestPath, 'utf8'), releaseSource);

    materialized.restore();
    assert.equal(await readFile(manifestPath, 'utf8'), workspaceSource);
  } finally {
    clearReleasePackageState({ repoRoot, packageName });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('rejects stale release state instead of packing the wrong dependency graph', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gezel-release-state-stale-'));
  const packageName = '@bendyline/gezel-cli';
  const manifestPath = join(repoRoot, 'package.json');
  const workspaceSource = `${JSON.stringify({ name: packageName, version: '1.0.2' }, null, 2)}\n`;
  await writeFile(manifestPath, workspaceSource);
  writeReleasePackageState({
    repoRoot,
    packageName,
    packageVersion: '1.0.1',
    source: `${JSON.stringify({ name: packageName, version: '1.0.1' }, null, 2)}\n`,
  });

  try {
    assert.throws(
      () =>
        materializeReleasePackageState({
          repoRoot,
          packageName,
          packageVersion: '1.0.2',
          manifestPath,
          sourceManifest: workspaceSource,
        }),
      /stale or malformed/,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), workspaceSource);
  } finally {
    clearReleasePackageState({ repoRoot, packageName });
    await rm(repoRoot, { recursive: true, force: true });
  }
});
