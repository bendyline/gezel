import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLatestTag } from './check-latest-release-namespace.mjs';

test('an app release tag is accepted', () => {
  assert.equal(classifyLatestTag('v1.26214.29').ok, true);
  assert.equal(classifyLatestTag('v0.0.1').ok, true);
});

test('a native engine release is rejected with a runnable fix', () => {
  const verdict = classifyLatestTag('native-v0.1.29');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not an app release tag/);
  assert.match(verdict.reason, /gh release edit native-v0\.1\.29 --prerelease/);
});

test('tags the updater would refuse are rejected', () => {
  for (const tag of ['1.26214.29', 'v1.26214', 'v1.26214.29-rc1', 'latest', 'v01.2.3']) {
    assert.equal(classifyLatestTag(tag).ok, false, `${tag} must not pass`);
  }
});

test('a missing latest release is reported rather than treated as healthy', () => {
  for (const tag of [undefined, null, '']) {
    const verdict = classifyLatestTag(tag);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no latest release/);
  }
});

test('an explicit expected version pins the exact release', () => {
  assert.equal(classifyLatestTag('v1.26214.29', '1.26214.29').ok, true);
  const stale = classifyLatestTag('v1.26212.27', '1.26214.29');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /expected 'v1\.26214\.29'/);
});
