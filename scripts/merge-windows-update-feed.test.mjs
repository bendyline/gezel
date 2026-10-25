/**
 * Every Windows install reads one latest.yml, so x64 and arm64 machines must
 * each find their own installer in it — and an arm64 machine handed the x64
 * installer would run its engines under emulation, if at all.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeWindowsUpdateFeeds } from './merge-windows-update-feed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function feed(arch, version = '1.26297.12') {
  return `version: ${version}
files:
  - url: Gezel-${version}-windows-${arch}.exe
    sha512: ${arch}SHA==
    size: 412345678
    isAdminRightsRequired: true
path: Gezel-${version}-windows-${arch}.exe
sha512: ${arch}SHA==
isAdminRightsRequired: true
releaseDate: '2026-10-24T12:00:00.000Z'
`;
}

test('lists both installers and keeps the x64 top-level fields', () => {
  const merged = mergeWindowsUpdateFeeds(feed('x64'), feed('arm64'));
  assert.match(merged, /- url: Gezel-1\.26297\.12-windows-x64\.exe/);
  assert.match(merged, /- url: Gezel-1\.26297\.12-windows-arm64\.exe/);
  // Older updaters read the top-level path; it must stay the x64 installer.
  assert.match(merged, /^path: Gezel-1\.26297\.12-windows-x64\.exe$/m);
  assert.match(merged, /^sha512: x64SHA==$/m);
  assert.equal(merged.match(/^version:/gm)?.length, 1);
});

test('refuses feeds from different versions', () => {
  assert.throws(
    () => mergeWindowsUpdateFeeds(feed('x64', '1.0.1'), feed('arm64', '1.0.2')),
    /x64 feed is 1\.0\.1 but arm64 feed is 1\.0\.2/,
  );
});

test('refuses installers whose names lost their arch', () => {
  assert.throws(
    () => mergeWindowsUpdateFeeds(feed('x64'), feed('x64')),
    /arm64 feed's installers must name their arch/,
  );
  assert.throws(
    () => mergeWindowsUpdateFeeds(feed('x64'), 'version: 1.26297.12\n'),
    /arm64 update feed has no top-level files/,
  );
});

test("each arch's electron-updater picks its own installer from the merged feed", (t) => {
  let providerPath;
  try {
    providerPath = createRequire(join(root, 'packages', 'app', 'package.json')).resolve(
      'electron-updater/out/providers/Provider.js',
    );
  } catch {
    t.skip('electron-updater is not installed in this checkout');
    return;
  }
  const updaterRequire = createRequire(providerPath);
  const { findFile, resolveFiles } = updaterRequire(providerPath);
  const yaml = updaterRequire('js-yaml');
  const info = yaml.load(mergeWindowsUpdateFeeds(feed('x64'), feed('arm64')));
  const files = resolveFiles(info, new URL('https://example.invalid/releases/'));

  const realArch = Object.getOwnPropertyDescriptor(process, 'arch');
  try {
    for (const arch of ['x64', 'arm64']) {
      Object.defineProperty(process, 'arch', { value: arch, configurable: true });
      const picked = findFile(files, 'exe');
      assert.ok(
        picked.url.pathname.endsWith(`-windows-${arch}.exe`),
        `${arch} picked ${picked.url.pathname}`,
      );
    }
  } finally {
    Object.defineProperty(process, 'arch', realArch);
  }
});
