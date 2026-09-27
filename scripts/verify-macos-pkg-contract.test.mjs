import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateMacPkgDistribution,
  validateMacPkgPackageInfo,
} from './verify-macos-pkg-contract.mjs';

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

const distribution = (versions) => `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <pkg-ref id="com.bendyline.gezel"/>
    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
    <volume-check>
        <allowed-os-versions>
${versions.map((v) => `            <os-version min="${v}"/>`).join('\n')}
        </allowed-os-versions>
    </volume-check>
</installer-gui-script>`;

test('accepts a Distribution that refuses macOS below the product floor', () => {
  assert.doesNotThrow(() => validateMacPkgDistribution(distribution(['14.0']), '14.0'));
  assert.doesNotThrow(() => validateMacPkgDistribution(distribution(['14.0.0']), '14.0'));
});

test('rejects a Distribution that would install on an older macOS', () => {
  assert.throws(
    () => validateMacPkgDistribution(distribution(['13.5']), '14.0'),
    /allows macOS 13\.5; expected minimum 14\.0/,
  );
  assert.throws(() => validateMacPkgDistribution('<installer-gui-script/>', '14.0'), /found 0/);
  assert.throws(() => validateMacPkgDistribution(distribution([]), '14.0'), /\(no minimum\)/);
});
