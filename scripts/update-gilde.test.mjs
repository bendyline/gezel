import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertLockfileVersion,
  hasLocalGildeOverride,
  hasPackageWideAgeExemption,
  lockfileMatchesVersion,
  missingTypeEntries,
  parseLatestVersion,
  readPinnedDependency,
  treeMatchesVersion,
  updatePinnedDependency,
  verifyInstalledVersion,
} from './update-gilde.mjs';

test('parses an npm latest-version response', () => {
  assert.equal(parseLatestVersion('"1.2.3"'), '1.2.3');
  assert.equal(parseLatestVersion('["1.2.3"]'), '1.2.3');
  assert.throws(() => parseLatestVersion('["1.2.3", "1.2.4"]'), /invalid latest version/);
});

test('reads and updates only the exact Gilde dependency pin', () => {
  const source = `{
  "dependencies": {
    "@bendyline/gilde": "1.2.3"
  }
}
`;
  assert.equal(readPinnedDependency(source), '1.2.3');
  assert.equal(readPinnedDependency(updatePinnedDependency(source, '1.2.4')), '1.2.4');
  assert.match(
    updatePinnedDependency('    "@bendyline/gilde" :  "1.2.3",\n', '1.2.4'),
    /"@bendyline\/gilde" : {2}"1\.2\.4",/,
  );
  assert.throws(
    () => readPinnedDependency(source.replace('"1.2.3"', '"^1.2.3"')),
    /must use an exact version/,
  );
});

test('requires a package-wide release-age exemption', () => {
  const packageWide = `minimumReleaseAgeExclude:
  - "@bendyline/gilde"
  - "other@1.0.0"
`;
  const versionOnly = `minimumReleaseAgeExclude:
  - "@bendyline/gilde@1.2.3"
`;
  assert.equal(hasPackageWideAgeExemption(packageWide), true);
  assert.equal(hasPackageWideAgeExemption(versionOnly), false);
});

test('detects a local Gilde override', () => {
  assert.equal(
    hasLocalGildeOverride(`overrides:
  "@bendyline/gilde": "link:../gilde"
`),
    true,
  );
  assert.equal(
    hasLocalGildeOverride(`minimumReleaseAgeExclude:
  - "@bendyline/gilde"
`),
    false,
  );
});

test('verifies both consumer importers and all Gilde lockfile entries', () => {
  const lockfile = gildeLockfile();
  assert.doesNotThrow(() => assertLockfileVersion(lockfile, '1.2.3'));
  assert.throws(() => assertLockfileVersion(lockfile, '1.2.4'), /not pinned/);

  // The state question behind resumability: a pin that already reads 1.2.4
  // over a lockfile still on 1.2.3 is an interrupted update, not a finished
  // one, and must not report "already current".
  assert.equal(lockfileMatchesVersion(lockfile, '1.2.3'), true);
  assert.equal(lockfileMatchesVersion(lockfile, '1.2.4'), false);
  assert.equal(lockfileMatchesVersion('', '1.2.3'), false);
});

test('reports unbuilt core type declarations before anything is mutated', () => {
  const entries = [
    '/repo/packages/core/dist/index.d.ts',
    '/repo/packages/core/dist/svg/index.d.ts',
  ];
  assert.deepEqual(
    missingTypeEntries(entries, () => true),
    [],
  );
  assert.deepEqual(
    missingTypeEntries(entries, () => false),
    entries,
  );
  assert.deepEqual(
    missingTypeEntries(entries, (entry) => entry.endsWith('index.d.ts') && !entry.includes('svg')),
    ['/repo/packages/core/dist/svg/index.d.ts'],
  );
});

function gildeLockfile() {
  return `importers:

  packages/catalog:
    dependencies:
      '@bendyline/gilde':
        specifier: 1.2.3
        version: 1.2.3

  packages/client:
    dependencies: {}

  packages/service:
    dependencies:
      '@bendyline/gilde':
        specifier: 1.2.3
        version: 1.2.3

packages:

  '@bendyline/gilde@1.2.3':
    resolution: {integrity: sha512-example}

snapshots:

  '@bendyline/gilde@1.2.3': {}
`;
}

test('rejects a stale or missing service lockfile importer even when the catalog is current', () => {
  const lockfile = gildeLockfile();
  const serviceStart = lockfile.indexOf('  packages/service:');
  const stale =
    lockfile.slice(0, serviceStart) +
    lockfile.slice(serviceStart).replace('specifier: 1.2.3', 'specifier: 1.2.2');
  assert.throws(() => assertLockfileVersion(stale, '1.2.3'), /service importer is not pinned/);
  assert.throws(
    () => assertLockfileVersion(lockfile.replace('packages/service:', 'packages/other:'), '1.2.3'),
    /no packages\/service importer/,
  );
});

test('requires both consumers to be installed at their pins before reporting an update complete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-gilde-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), gildeLockfile());
  const packageJson = (version) =>
    JSON.stringify({ dependencies: { '@bendyline/gilde': version } }, null, 2);
  for (const consumer of ['catalog', 'service']) {
    const dir = join(root, 'packages', consumer);
    const installed = join(dir, 'node_modules', '@bendyline', 'gilde');
    await mkdir(installed, { recursive: true });
    await writeFile(join(dir, 'package.json'), packageJson('1.2.3'));
    await writeFile(join(installed, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  }
  assert.equal(await treeMatchesVersion('1.2.3', root), true);
  const serviceManifest = join(root, 'packages', 'service', 'package.json');
  const installedManifest = join(
    root,
    'packages',
    'service',
    'node_modules',
    '@bendyline',
    'gilde',
    'package.json',
  );

  await writeFile(installedManifest, JSON.stringify({ version: '1.2.2' }));
  assert.equal(await treeMatchesVersion('1.2.3', root), false);
  await assert.rejects(verifyInstalledVersion('1.2.3', root), /packages\/service resolves 1\.2\.2/);
  await writeFile(installedManifest, JSON.stringify({ version: '1.2.3' }));
  assert.equal(await treeMatchesVersion('1.2.3', root), true);

  await writeFile(serviceManifest, packageJson('1.2.2'));
  assert.equal(await treeMatchesVersion('1.2.3', root), false);
  await assert.rejects(verifyInstalledVersion('1.2.3', root), /packages\/service pins 1\.2\.2/);
  await writeFile(serviceManifest, packageJson('1.2.3'));
  await writeFile(installedManifest, '{');
  assert.equal(await treeMatchesVersion('1.2.3', root), false);
  await rm(installedManifest);
  assert.equal(await treeMatchesVersion('1.2.3', root), false);
});
