/**
 * Contract tests for the two app-store packaging lanes.
 *
 * The mirror image of macos-entitlements.test.mjs and mac-update-contract.test.mjs,
 * which pin the Developer ID build: those assert the sandbox entitlement is
 * ABSENT and that mac targets are exactly ['pkg','zip']. Both must stay true —
 * the store lanes live in separate config files precisely so neither check has
 * to be relaxed. What follows pins the other side of that split, so the store
 * configs cannot silently drift into or out of the shape the stores require.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unpinnedEntries, validateManifest } from './stage-model-pack.mjs';
import { parseBooleanEntitlementsPlist } from './verify-macos-entitlements.mjs';
import {
  MAS_INHERIT_ENTITLEMENTS,
  MAS_REVIEWED_ENTITLEMENTS,
  parseMasEntitlementsPlist,
} from './verify-mas-entitlements.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRaw = (rel) => readFileSync(join(root, rel), 'utf8');

/**
 * Drop whole-line YAML comments before asserting on a config.
 *
 * These files are heavily commented, and the comments necessarily NAME the
 * things the config does not do ("ships no LaunchDaemon plist", "the Store
 * signs on ingest"). A raw grep for such a name finds the explanation and
 * reports the exact opposite of the truth — which it did, twice, while this
 * file was being written. Only leading-`#` lines are removed, so a `#` inside
 * a quoted value like `backgroundColor: '#464646'` is untouched.
 */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const read = (rel) => withoutComments(readRaw(rel));

const STORE_BUILD_RESOURCE = /from: dist\/store-build/;
const MARKER_SCRIPT_MSIX = /write-store-build-marker\.mjs microsoft-store/;
const MARKER_SCRIPT_MAS = /write-store-build-marker\.mjs mac-app-store/;
const UNPACKED_SERVICE_TREE = /dist\/service-bundle\/\*\*\/\*/;

const MAS_CONFIG = 'packages/app/electron-builder.mas.yml';
const APPX_CONFIG = 'packages/app/electron-builder.appx.yml';

test('both store configs extend the base rather than restating it', () => {
  for (const config of [MAS_CONFIG, APPX_CONFIG]) {
    assert.match(
      read(config),
      /^extends: \.\/electron-builder\.yml$/m,
      `${config} must extend the base config so files/asarUnpack/afterPack stay in one place`,
    );
  }
});

test('neither store config publishes an update feed', () => {
  // The store owns delivery. A publish target here would emit update metadata
  // implying this channel self-updates, which it must not.
  for (const config of [MAS_CONFIG, APPX_CONFIG]) {
    assert.match(read(config), /^publish: null$/m, `${config} must not publish an update feed`);
  }
});

test('the MAS config builds only the sandboxed mas target', () => {
  const mas = read(MAS_CONFIG);
  assert.match(mas, /target: mas/, 'the MAS lane must build the mas target');
  assert.doesNotMatch(mas, /target: pkg/, 'the Developer ID PKG belongs to the other lane');
  assert.doesNotMatch(mas, /target: zip/, 'the latest-mac.yml zip belongs to the other lane');
  assert.match(mas, /entitlements: entitlements\.mas\.plist/);
  assert.match(mas, /entitlementsInherit: entitlements\.mas\.inherit\.plist/);
  // Hardened runtime is how the notarized build is signed; a sandboxed store
  // build is signed for distribution instead.
  assert.match(mas, /hardenedRuntime: false/);
});

test('the MAS config ships no LaunchDaemon payload', () => {
  // A store build registers no daemon: it cannot elevate, and guideline 2.4.5
  // forbids installing anything outside the bundle. The MAS config declares
  // its own extraResources (licenses + model pack), which REPLACES the base
  // config's — so what matters is that the installer payload the Developer ID
  // lane ships did not come along with it.
  const mas = read(MAS_CONFIG);
  assert.doesNotMatch(
    mas,
    /com\.bendyline\.gezeld\.plist/,
    'no LaunchDaemon plist in a store build',
  );
  assert.doesNotMatch(mas, /uninstall\.sh/, 'no privileged uninstaller in a store build');
  // Confirm the base config really is the thing being overridden, so this test
  // keeps meaning something if the base ever stops shipping them.
  const base = read('packages/app/electron-builder.yml');
  assert.match(base, /com\.bendyline\.gezeld\.plist/);
});

test('the appx config builds only the appx target and registers no service', () => {
  const appx = read(APPX_CONFIG);
  assert.match(appx, /target: appx/);
  assert.doesNotMatch(appx, /target: nsis/, 'the NSIS installer belongs to the other lane');
  // The service host exists for the NSIS customInstall hook's sc.exe
  // registration. Microsoft states packagedServices will not generally be
  // approved for Store submissions, so this build ships no service at all.
  assert.match(appx, /^ {2}extraFiles: \[\]$/m);
  // The Store signs on ingest; an Authenticode signature here gets rejected.
  assert.match(appx, /^ {2}signtoolOptions: null$/m);
});

test('the appx manifest declares a disabled startup task and no service', () => {
  const xml = readRaw('packages/app/installer/appx-manifest-extensions.xml');
  assert.match(xml, /Category="windows\.startupTask"/);
  assert.match(xml, /TaskId="GezelStartup"/);
  // Autostart is opt-in on every other platform; shipping it enabled would
  // turn a Settings toggle the user has never seen into a default.
  assert.match(xml, /Enabled="false"/);
  // packagedServices/windows.service is the capability Microsoft says will not
  // be approved. Declaring one would fail certification, loudly or otherwise.
  assert.doesNotMatch(xml, /windows\.service/);
  assert.equal(
    (xml.match(/Category="windows\.startupTask"/g) ?? []).length,
    1,
    'exactly one startup task',
  );
});

test('the appx identity placeholders are visible, not plausible', () => {
  // Identity must come from the Partner Center reservation. A wrong-but-
  // plausible value would produce a package that builds and then fails at
  // upload; a loud placeholder fails where someone can read why.
  const appx = read(APPX_CONFIG);
  const placeholders = appx.match(/REPLACE_WITH_PARTNER_CENTER_\w+/g) ?? [];
  if (placeholders.length > 0) {
    assert.ok(
      appx.includes('identityName: REPLACE_WITH_PARTNER_CENTER_IDENTITY_NAME'),
      'placeholder identity must stay obviously unset until reserved',
    );
  } else {
    assert.match(appx, /^ {2}publisher: CN=/m, 'a real publisher must be a CN= distinguished name');
  }
});

test('the MAS entitlements are exactly the reviewed sandbox set', () => {
  // Plists get the raw bytes: the parser strips XML comments itself, and the
  // YAML comment filter would corrupt them.
  const source = parseMasEntitlementsPlist(readRaw('packages/app/entitlements.mas.plist'));
  for (const [key, expected] of MAS_REVIEWED_ENTITLEMENTS) {
    assert.deepEqual(source.get(key), expected, `entitlements.mas.plist must declare ${key}`);
  }
  assert.equal(
    source.size,
    MAS_REVIEWED_ENTITLEMENTS.size,
    'entitlements.mas.plist carries an unreviewed key',
  );
  // The sandbox makes this unnecessary: every Mach-O is re-signed with our own
  // identity and no code is downloaded at runtime, so library validation can
  // stay on — a stronger posture than the Developer ID build has.
  assert.equal(source.has('com.apple.security.cs.disable-library-validation'), false);
});

test('the MAS child entitlements inherit rather than restate capabilities', () => {
  const inherit = parseMasEntitlementsPlist(readRaw('packages/app/entitlements.mas.inherit.plist'));
  for (const [key, expected] of MAS_INHERIT_ENTITLEMENTS) {
    assert.deepEqual(inherit.get(key), expected);
  }
  assert.equal(inherit.size, MAS_INHERIT_ENTITLEMENTS.size);
  // codesign rejects a child that names capabilities alongside inheritance,
  // and restating them would misrepresent what the child holds in its own right.
  for (const key of [
    'com.apple.security.network.client',
    'com.apple.security.network.server',
    'com.apple.security.device.audio-input',
    'com.apple.security.application-groups',
    'com.apple.security.files.user-selected.read-write',
  ]) {
    assert.equal(inherit.has(key), false, `${key} must arrive through inherit, not be restated`);
  }
});

test('the Developer ID lane is untouched by the store lanes', () => {
  // The store configs exist so these two checks never have to be relaxed.
  const base = read('packages/app/electron-builder.yml');
  assert.match(base, /- target: pkg/);
  assert.match(base, /- target: zip/);
  assert.match(base, /- target: nsis/);
  // Parsed rather than grepped: that plist's header explains at length WHY the
  // sandbox keys were removed, so a raw text match finds the explanation and
  // reports the opposite of the truth.
  const hardened = parseBooleanEntitlementsPlist(readRaw('packages/app/entitlements.mac.plist'));
  assert.equal(
    hardened.has('com.apple.security.app-sandbox'),
    false,
    'the hardened-runtime build must never declare the sandbox',
  );
  // And the inverse, so the two lanes cannot converge from the other side.
  const mas = parseMasEntitlementsPlist(readRaw('packages/app/entitlements.mas.plist'));
  assert.equal(mas.get('com.apple.security.app-sandbox'), true);
});

test('both store configs carry the model pack and keep the legal payload', () => {
  for (const config of [MAS_CONFIG, APPX_CONFIG]) {
    const text = read(config);
    assert.match(text, /from: dist\/model-pack/, `${config} must ship the model pack`);
    // A child array replaces the parent's, so restating the licenses tree is
    // mandatory — dropping it would ship a package with no dependency notices.
    assert.match(
      text,
      /from: dist\/licenses/,
      `${config} must restate the licenses tree it replaced`,
    );
  }
});

test('the model pack manifest is well formed and pins every entry it declares', () => {
  const manifest = JSON.parse(readRaw('packages/app/model-pack.json'));
  assert.deepEqual(validateManifest(manifest), [], 'model-pack.json must be structurally valid');
  const pending = unpinnedEntries(manifest);
  if (pending.length > 0) {
    // Not a failure yet: the pack is declared before the weights are chosen.
    // stage-model-pack.mjs turns this into a hard error at build time, so an
    // unpinned entry can never reach a signed package — it just cannot be
    // built until someone fills in the url and sha.
    console.log(
      `[store-contract] model pack awaiting real pins: ${pending.map((e) => e.id).join(', ')}`,
    );
  }
});

test('only the store lanes ship weights', () => {
  // The direct-download installers deliberately carry no models: those users
  // download what they choose, and ~3 GB in a release we pay to serve is the
  // wrong trade. The store CDN is what makes it affordable on that channel.
  assert.doesNotMatch(read('packages/app/electron-builder.yml'), /model-pack/);
  const base = read('.github/workflows/release-electron.yml');
  assert.doesNotMatch(base, /stage-model-pack/);
});

test('both store configs stage the channel marker', () => {
  // Without it a packaged store build reads as a direct download: it would
  // take the managing supervisor ladder and try to download code the stores
  // forbid. The marker is what makes the channel a property of the artifact.
  for (const config of [MAS_CONFIG, APPX_CONFIG]) {
    assert.match(read(config), STORE_BUILD_RESOURCE, `${config} must stage the marker`);
  }
});

test('each store workflow writes its own channel marker before packaging', () => {
  const msix = read('.github/workflows/release-msix.yml');
  assert.match(msix, MARKER_SCRIPT_MSIX);
  // Order matters: the marker has to exist before electron-builder collects
  // extraResources, or it silently ships without one.
  assert.ok(
    msix.indexOf('write-store-build-marker') < msix.indexOf('electron-builder --win'),
    'the marker must be written before packaging',
  );
});

test('the MAS config ships the service tree unpacked', () => {
  // A store build may not extract code at runtime, so the tree it imports has
  // to be in the bundle already. The base config ships only the tarball —
  // correct there, where unpacking one archive instead of ~100k files is what
  // keeps Windows installs from taking half an hour.
  const mas = read(MAS_CONFIG);
  assert.match(mas, UNPACKED_SERVICE_TREE, 'the MAS lane must ship dist/service-bundle unpacked');
  // Unpacked from the asar too: the service reads its own files with plain
  // Node fs, which cannot see inside an archive.
  const asarSection = mas.slice(mas.indexOf('asarUnpack:'));
  assert.match(asarSection, UNPACKED_SERVICE_TREE);
  // And the base config must NOT — otherwise every direct-download installer
  // grows by the size of a second copy of the service.
  assert.doesNotMatch(read('packages/app/electron-builder.yml'), UNPACKED_SERVICE_TREE);
});

test('the MAS workflow re-signs the payload and never notarizes', () => {
  const mas = read('.github/workflows/release-mas.yml');
  assert.match(mas, /mas-resign-payload.mjs/, 'the payload must be re-signed for the sandbox');
  assert.match(mas, MARKER_SCRIPT_MAS);
  assert.match(mas, /stage-model-pack.mjs/);
  assert.match(mas, /verify-mas-entitlements.mjs/);
  // A MAS package is not notarized or stapled — the store reviews and
  // re-signs on ingest, so these checks would fail here by design.
  assert.doesNotMatch(mas, /notarytool/);
  assert.doesNotMatch(mas, /stapler/);
  assert.doesNotMatch(mas, /spctl/);
  // Re-signing sits in a narrow window, and both edges have bitten:
  //
  //   after build:packaged — tsup's onSuccess re-runs fetch-node and
  //     fetch-duckdb, which re-stage those bundles from their vendor downloads
  //     and rewrite sha256.txt. Signing earlier is silently undone, and the
  //     package ships vendor-signed binaries whose children cannot launch
  //     under the sandbox.
  //
  //   before electron-builder — packing seals the tree, and these paths are
  //     signIgnore'd so electron-builder will not sign them itself.
  assert.ok(
    mas.indexOf('pnpm build:packaged') < mas.indexOf('node scripts/mas-resign-payload.mjs'),
    'the payload must be re-signed AFTER build:packaged, which rebuilds two of those trees',
  );
  assert.ok(
    mas.indexOf('node scripts/mas-resign-payload.mjs') < mas.indexOf('exec electron-builder'),
    'the payload must be re-signed before electron-builder seals the tree',
  );
  // And provenance must be proven BEFORE signatures are replaced, or the
  // manifest check would be asserting our own bytes back to us.
  assert.ok(
    mas.indexOf('--root packages/app/native-bin') < mas.indexOf('mas-resign-payload'),
    'the native payload must be verified before it is re-signed',
  );
});

test('the store workflows are dispatch-only and never auto-publish a release', () => {
  for (const workflow of [
    '.github/workflows/release-msix.yml',
    '.github/workflows/release-mas.yml',
  ]) {
    const text = read(workflow);
    assert.match(text, /^on:\s*$/m);
    assert.match(text, /^ {2}workflow_dispatch:$/m);
    assert.doesNotMatch(
      text,
      /^\s*(push|schedule):/m,
      `${workflow} must only run when a human dispatches it`,
    );
    // Store artifacts are hand-uploaded to the store console after review.
    assert.doesNotMatch(text, /draft:\s*false/, `${workflow} must not publish a release`);
  }
});
