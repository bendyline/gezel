import assert from 'node:assert/strict';
import test from 'node:test';

import { selectLatestAppTag } from './check-latest-release-namespace.mjs';

test('the greatest stable app release is selected around other namespaces', () => {
  const verdict = selectLatestAppTag([
    { tag_name: '@bendyline/gezel-service@1.0.2', draft: false, prerelease: false },
    { tag_name: 'native-v0.1.36', draft: false, prerelease: true },
    { tag_name: 'v1.26214.29', draft: false, prerelease: false },
    { tag_name: 'v1.26212.27', draft: false, prerelease: false },
  ]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tag, 'v1.26214.29');
});

test('a listing with no app release is rejected', () => {
  const verdict = selectLatestAppTag([
    { tag_name: 'native-v0.1.29', draft: false, prerelease: true },
    { tag_name: '@bendyline/gezel@1.0.2', draft: false, prerelease: false },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no published stable app release/);
});

test('tags the updater would refuse are rejected', () => {
  for (const tag of ['1.26214.29', 'v1.26214', 'v1.26214.29-rc1', 'latest', 'v01.2.3']) {
    assert.equal(
      selectLatestAppTag([{ tag_name: tag, draft: false, prerelease: false }]).ok,
      false,
      `${tag} must not pass`,
    );
  }
});

test('draft and prerelease app tags do not enter the stable channel', () => {
  const verdict = selectLatestAppTag([
    { tag_name: 'v2.0.0', draft: true, prerelease: false },
    { tag_name: 'v1.0.0', draft: false, prerelease: true },
  ]);
  assert.equal(verdict.ok, false);
});

test('an explicit expected version pins the exact release', () => {
  const releases = [{ tag_name: 'v1.26214.29', draft: false, prerelease: false }];
  assert.equal(selectLatestAppTag(releases, '1.26214.29').ok, true);
  const stale = selectLatestAppTag(releases, '1.26215.30');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /expected 'v1\.26215\.30'/);
});
