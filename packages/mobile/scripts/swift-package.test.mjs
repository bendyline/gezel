import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSwiftPackage } from './swift-package.mjs';

const manifest = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v"$)],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.5.2")
    ]
)
`;
test('repairs Capacitor parsing an Xcode deployment variable while preserving the native floor', () => {
  const result = normalizeSwiftPackage(manifest, '8.5.2', '16.4');
  assert.ok(result.includes('platforms: [.iOS("16.4")],'));
  assert.ok(result.includes('exact: "8.5.2"'));
  assert.ok(!result.includes('.v"$'));
  assert.equal(normalizeSwiftPackage(result, '8.5.2', '16.4'), result);
});
test('refuses missing/duplicate declarations or unverified versions', () => {
  assert.throws(() => normalizeSwiftPackage(manifest, '^8.5.2', '16.4'), /exact release/);
  assert.throws(() => normalizeSwiftPackage(manifest, '8.5.2', '$(SDK_VERSION)'), /minimum OS/);
  assert.throws(() => normalizeSwiftPackage(manifest + manifest, '8.5.2', '16.4'), /one generated/);
  assert.throws(
    () =>
      normalizeSwiftPackage(
        manifest.replace('capacitor-swift-pm.git', 'other.git'),
        '8.5.2',
        '16.4',
      ),
    /one Capacitor/,
  );
});
