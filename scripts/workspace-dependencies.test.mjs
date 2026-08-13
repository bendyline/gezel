import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  findWorkspaceDependencies,
  findWorkspaceDependencyViolations,
  normalizeWorkspaceDependencies,
  normalizeWorkspaceManifest,
  readWorkspaceManifests,
} from './workspace-dependencies.mjs';

async function writeManifest(root, relativeDir, manifest) {
  const dir = join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

test('normalizes every local dependency scope while leaving registry dependencies alone', () => {
  const manifest = {
    name: '@bendyline/example',
    dependencies: {
      '@bendyline/gezel': '1.0.0',
      zod: '^4.0.0',
    },
    devDependencies: { '@bendyline/gezel-client': 'workspace:*' },
    peerDependencies: { '@bendyline/gezel-sdk': '^1.0.0' },
    optionalDependencies: { '@bendyline/gezel-mcp': '~1.0.0' },
  };
  const names = new Set([
    '@bendyline/gezel',
    '@bendyline/gezel-client',
    '@bendyline/gezel-sdk',
    '@bendyline/gezel-mcp',
  ]);

  const changes = normalizeWorkspaceDependencies(manifest, names);

  assert.deepEqual(
    changes.map(({ field, name, specifier }) => ({ field, name, specifier })),
    [
      { field: 'dependencies', name: '@bendyline/gezel', specifier: '1.0.0' },
      { field: 'peerDependencies', name: '@bendyline/gezel-sdk', specifier: '^1.0.0' },
      {
        field: 'optionalDependencies',
        name: '@bendyline/gezel-mcp',
        specifier: '~1.0.0',
      },
    ],
  );
  assert.equal(manifest.dependencies['@bendyline/gezel'], 'workspace:*');
  assert.equal(manifest.dependencies.zod, '^4.0.0');
  assert.equal(manifest.peerDependencies['@bendyline/gezel-sdk'], 'workspace:*');
  assert.equal(manifest.optionalDependencies['@bendyline/gezel-mcp'], 'workspace:*');
  assert.deepEqual(findWorkspaceDependencyViolations(manifest, names), []);
  assert.deepEqual(
    findWorkspaceDependencies(manifest, names).map(({ field, name }) => `${field}:${name}`),
    [
      'dependencies:@bendyline/gezel',
      'devDependencies:@bendyline/gezel-client',
      'peerDependencies:@bendyline/gezel-sdk',
      'optionalDependencies:@bendyline/gezel-mcp',
    ],
  );
});

test('discovers the Gezel workspace layout and writes only changed manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-workspace-deps-'));
  try {
    await writeManifest(root, 'packages/core', {
      name: '@bendyline/gezel',
      version: '1.0.0',
    });
    await writeManifest(root, 'packages/client', {
      name: '@bendyline/gezel-client',
      version: '1.0.0',
      dependencies: { '@bendyline/gezel': '1.0.0' },
    });
    await writeManifest(root, 'evals', {
      name: '@bendyline/gezel-evals',
      private: true,
      dependencies: { '@bendyline/gezel-client': 'workspace:*' },
    });

    const { records, names } = readWorkspaceManifests(root);
    assert.deepEqual([...names].sort(), [
      '@bendyline/gezel',
      '@bendyline/gezel-client',
      '@bendyline/gezel-evals',
    ]);

    const client = records.find(({ manifest }) => manifest.name === '@bendyline/gezel-client');
    const changes = normalizeWorkspaceManifest(client, names);
    assert.equal(changes.length, 1);
    assert.equal(
      JSON.parse(await readFile(client.path, 'utf8')).dependencies['@bendyline/gezel'],
      'workspace:*',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
