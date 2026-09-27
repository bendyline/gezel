/**
 * An installed Gezel on a Mac below the new floor must not be offered the
 * update. The only thing that reaches releases already in the field is the
 * `minimumSystemVersion` their electron-updater reads from latest-mac.yml.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  darwinReleaseForMacOS,
  feedMinimumSystemVersion,
  stampMacUpdateFloor,
  withMinimumSystemVersion,
} from './stamp-mac-update-floor.mjs';
import { BUILDER_CONFIG, declaredMacFloor } from './verify-macos-version-floor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const FEED = `version: 1.26280.80
files:
  - url: Gezel-1.26280.80-mac-arm64.zip
    sha512: aGFzaA==
    size: 468123456
    blockMapSize: 491234
path: Gezel-1.26280.80-mac-arm64.zip
sha512: aGFzaA==
releaseDate: '2026-10-07T12:00:00.000Z'
`;

test('translates macOS floors to the Darwin release os.release() reports', () => {
  assert.equal(darwinReleaseForMacOS('14.0'), '23.0.0');
  assert.equal(darwinReleaseForMacOS('14.4'), '23.4.0');
  assert.equal(darwinReleaseForMacOS('15.0'), '24.0.0');
  assert.equal(darwinReleaseForMacOS('26.0'), '25.0.0');
  assert.equal(darwinReleaseForMacOS('26.1'), '25.1.0');
  assert.throws(() => darwinReleaseForMacOS('13.5'), /no verified Darwin release mapping/);
  assert.throws(() => darwinReleaseForMacOS('Sonoma'), /not a macOS version/);
});

test('adds a top-level minimumSystemVersion after version, or replaces it', () => {
  const stamped = withMinimumSystemVersion(FEED, '23.0.0');
  assert.match(stamped, /^version: 1\.26280\.80\nminimumSystemVersion: '23\.0\.0'\nfiles:/);
  assert.equal(feedMinimumSystemVersion(stamped), '23.0.0');
  const restamped = withMinimumSystemVersion(stamped, '24.0.0');
  assert.equal(restamped.match(/^minimumSystemVersion:/gm)?.length, 1);
  assert.equal(feedMinimumSystemVersion(restamped), '24.0.0');
  assert.equal(feedMinimumSystemVersion(FEED), null);
  assert.throws(() => withMinimumSystemVersion('files: []\n', '23.0.0'), /exactly one/);
});

test('stamps the declared product floor into a feed file', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gezel-mac-feed-'));
  try {
    const feedPath = join(work, 'latest-mac.yml');
    await writeFile(feedPath, FEED.replace(/\n/g, '\r\n'));
    const floor = declaredMacFloor(await readFile(BUILDER_CONFIG, 'utf8'));
    assert.equal(await stampMacUpdateFloor(feedPath, floor), '23.0.0');
    assert.equal(feedMinimumSystemVersion(await readFile(feedPath, 'utf8')), '23.0.0');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

/**
 * Parse the stamped feed the way installed apps do and apply their own
 * comparison. electron-updater's default isUpdateSupported is
 * `semver.lt(os.release(), updateInfo.minimumSystemVersion)` → no update.
 */
test("installed apps' electron-updater withholds the update below the floor", (t) => {
  let updaterMain;
  try {
    updaterMain = createRequire(join(root, 'packages', 'app', 'package.json')).resolve(
      'electron-updater',
    );
  } catch {
    t.skip('electron-updater is not installed in this checkout');
    return;
  }
  const updaterRequire = createRequire(updaterMain);
  const yaml = updaterRequire('js-yaml');
  const semver = updaterRequire('semver');
  const appUpdater = readFileSync(join(dirname(updaterMain), 'AppUpdater.js'), 'utf8');
  assert.match(
    appUpdater,
    /_isUpdateSupported = updateInfo => this\.checkIfUpdateSupported\(updateInfo\)/,
    'electron-updater no longer defaults isUpdateSupported to the OS-version check',
  );
  assert.match(appUpdater, /\(0, semver_1\.lt\)\(currentOSVersion, minimumSystemVersion\)/);

  const info = yaml.load(withMinimumSystemVersion(FEED, darwinReleaseForMacOS('14.0')));
  assert.equal(typeof info.minimumSystemVersion, 'string');
  const withheld = (osRelease) => semver.lt(osRelease, info.minimumSystemVersion);
  assert.equal(withheld('22.6.0'), true, 'macOS 13.5 must not be offered a 14.0 release');
  assert.equal(withheld('22.1.0'), true, 'macOS 13.0 must not be offered a 14.0 release');
  assert.equal(withheld('23.0.0'), false);
  assert.equal(withheld('25.5.0'), false);
});

test('main.ts keeps electron-updater default OS-version gate', async () => {
  const main = await readFile(join(root, 'packages', 'app', 'src', 'main.ts'), 'utf8');
  assert.doesNotMatch(
    main,
    /isUpdateSupported\s*=/,
    'overriding isUpdateSupported drops the minimumSystemVersion check older Macs rely on',
  );
});

test('the macOS release job stamps latest-mac.yml before verifying and uploading it', async () => {
  const workflow = await readFile(
    join(root, '.github', 'workflows', 'release-electron.yml'),
    'utf8',
  );
  const stamp = workflow.indexOf(
    'node scripts/stamp-mac-update-floor.mjs packages/app/dist/installers/latest-mac.yml',
  );
  const verify = workflow.indexOf('- name: Verify macOS update metadata was generated');
  const upload = workflow.indexOf('name: macos-artifacts');
  assert.notEqual(stamp, -1, 'release job must stamp the macOS floor into latest-mac.yml');
  assert.ok(stamp < verify && verify < upload, 'stamp, then verify, then upload');
  assert.match(
    workflow.slice(verify, upload),
    /grep -Eq "\^minimumSystemVersion: /,
    'the feed verification must assert the stamped floor survived',
  );
});
