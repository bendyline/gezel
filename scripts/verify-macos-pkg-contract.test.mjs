import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMacPkgPackageInfo } from './verify-macos-pkg-contract.mjs';

const componentPostinstall =
  '<postinstall file="./component-postinstall" component-id="com.bendyline.gezel" timeout="1800"/>';

test('accepts one component postinstall with the extended timeout', () => {
  assert.doesNotThrow(() =>
    validateMacPkgPackageInfo([`<pkg-info>${componentPostinstall}</pkg-info>`]),
  );
});

test('rejects the package-scoped default timeout that caused the failed install', () => {
  assert.throws(
    () =>
      validateMacPkgPackageInfo([
        '<pkg-info><postinstall file="./postinstall" timeout="600"/></pkg-info>',
      ]),
    /component-id is null/,
  );
});

test('rejects duplicate postinstall registrations', () => {
  assert.throws(
    () =>
      validateMacPkgPackageInfo([
        `<pkg-info>${componentPostinstall}${componentPostinstall}</pkg-info>`,
      ]),
    /expected exactly one.*found 2/,
  );
});

test('rejects timeout regressions', () => {
  assert.throws(
    () =>
      validateMacPkgPackageInfo([
        '<pkg-info><postinstall file="./component-postinstall" component-id="com.bendyline.gezel" timeout="600"/></pkg-info>',
      ]),
    /timeout is "600"; expected 1800/,
  );
});
