import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLockfileVersion,
  hasLocalGildeOverride,
  hasPackageWideAgeExemption,
  parseLatestVersion,
  readPinnedDependency,
  updatePinnedDependency,
} from './update-gilde.mjs';

test('parses an npm latest-version response', () => {
  assert.equal(parseLatestVersion('"1.2.3"'), '1.2.3');
  assert.throws(() => parseLatestVersion('["1.2.3"]'), /invalid latest version/);
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

test('verifies the catalog importer and all Gilde lockfile entries', () => {
  const lockfile = `importers:

  packages/catalog:
    dependencies:
      '@bendyline/gilde':
        specifier: 1.2.3
        version: 1.2.3

  packages/client:
    dependencies: {}

packages:

  '@bendyline/gilde@1.2.3':
    resolution: {integrity: sha512-example}

snapshots:

  '@bendyline/gilde@1.2.3': {}
`;
  assert.doesNotThrow(() => assertLockfileVersion(lockfile, '1.2.3'));
  assert.throws(() => assertLockfileVersion(lockfile, '1.2.4'), /not pinned/);
});
