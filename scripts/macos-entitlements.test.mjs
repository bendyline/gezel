/**
 * Pin both the intended and effective macOS hardened-runtime entitlement set.
 *
 * Every hardened-runtime exception gives back a protection, so additions are
 * deliberate and reviewed. The v1.26211.26 audit removed unsigned executable
 * memory and DYLD environment variables. This follow-up also removed two
 * App Sandbox-only network keys that had no effect because Gezel is not App
 * Sandbox-enabled. The v1.26270.76 audit went the other way: Narrate and the
 * ambient wallpaper declared usage strings but lacked the resource
 * entitlements hardened runtime requires, so macOS refused both silently.
 *
 * Electron's maintained notarization guidance makes the compatibility boundary
 * version-based, not architecture-based: Electron 11 and older needed unsigned
 * executable memory, while Electron 12+ should use the narrower allow-jit
 * entitlement. Pin that floor so adding an x64 target never becomes a reason to
 * weaken the current build.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REVIEWED_ENTITLEMENTS,
  VENDOR_SIGNED_ENTITLEMENTS,
  appRelativePath,
  assertExactReviewedEntitlements,
  assertExactVendorEntitlements,
  parseBooleanEntitlementsPlist,
} from './verify-macos-entitlements.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'packages', 'app');
const plistPath = join(appDir, 'entitlements.mac.plist');
const builderPath = join(appDir, 'electron-builder.yml');
const appPackagePath = join(appDir, 'package.json');
const releaseWorkflowPath = join(root, '.github', 'workflows', 'release-electron.yml');

const REMOVED = new Map([
  [
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'Electron 12+ uses allow-jit; this broader exception increases attack surface',
  ],
  [
    'com.apple.security.cs.allow-dyld-environment-variables',
    'permits dynamic-linker environment injection; Gezel does not use DYLD_* variables',
  ],
  [
    'com.apple.security.network.client',
    'an App Sandbox capability with no effect when com.apple.security.app-sandbox is absent',
  ],
  [
    'com.apple.security.network.server',
    'an App Sandbox capability with no effect when com.apple.security.app-sandbox is absent',
  ],
]);

const FORBIDDEN = new Map([
  [
    'com.apple.security.get-task-allow',
    'development-only; lets other processes attach to Gezel and borrow its privacy grants',
  ],
  [
    'com.apple.security.app-sandbox',
    'incompatible with Gezel local workspaces, local tools and child-process model',
  ],
]);

async function sourceEntitlements() {
  return parseBooleanEntitlementsPlist(
    await readFile(plistPath, 'utf8'),
    'packages/app/entitlements.mac.plist',
  );
}

function macBlock(builder) {
  const block = builder.match(/^mac:$[\s\S]*?(?=^\S)/m);
  assert.ok(block, 'could not locate the mac: block in electron-builder.yml');
  return block[0];
}

function macScalar(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`^ {2}${escaped}:\\s*([^#\\n]+)`, 'm'))?.[1].trim();
}

/** `mac.extendInfo` as `key -> string | null` (null = removed from Info.plist). */
function macExtendInfo(mac) {
  const start = mac.indexOf('\n  extendInfo:');
  assert.notEqual(start, -1, 'mac.extendInfo is missing from electron-builder.yml');
  const entries = new Map();
  for (const line of mac.slice(start + '\n  extendInfo:'.length).split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const match = /^ {4}([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (!match) break;
    const raw = match[2].trim();
    entries.set(match[1], raw === 'null' || raw === '~' || raw === '' ? null : raw);
  }
  return entries;
}

/**
 * Hardened-runtime resource entitlements and the Info.plist usage string macOS
 * pairs with each. Either half alone is broken: without the entitlement the
 * resource is refused silently; without the string the app is terminated or
 * the prompt has nothing to say.
 */
const RESOURCE_ENTITLEMENT_USAGE_KEYS = new Map([
  ['com.apple.security.device.audio-input', 'NSMicrophoneUsageDescription'],
  ['com.apple.security.device.camera', 'NSCameraUsageDescription'],
  ['com.apple.security.automation.apple-events', 'NSAppleEventsUsageDescription'],
]);

test('source plist grants exactly the reviewed true entitlement set', async () => {
  const entitlements = await sourceEntitlements();
  assertExactReviewedEntitlements(entitlements, 'packages/app/entitlements.mac.plist');
  assert.deepEqual(new Set(entitlements.keys()), new Set(REVIEWED_ENTITLEMENTS.keys()));
});

test('strict plist parser rejects false values and malformed content', () => {
  const falseValue = parseBooleanEntitlementsPlist(
    '<?xml version="1.0"?><plist><dict><key>com.apple.security.cs.allow-jit</key><false/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
    'false-value fixture',
  );
  assert.throws(
    () => assertExactReviewedEntitlements(falseValue, 'false-value fixture'),
    /missing true entitlement com\.apple\.security\.cs\.allow-jit/,
  );
  assert.throws(
    () =>
      parseBooleanEntitlementsPlist(
        '<?xml version="1.0"?><plist><dict><key>broken</key><string>yes</string></dict></plist>',
        'malformed fixture',
      ),
    /unsupported or malformed XML/,
  );
});

test('does not reinstate removed or development-only entitlements', async () => {
  const entitlements = await sourceEntitlements();
  for (const [key, why] of [...REMOVED, ...FORBIDDEN]) {
    assert.ok(!entitlements.has(key), `${key} must not ship: ${why}`);
  }
});

test('electron-builder applies this plist to hardened app and helper signatures', async () => {
  const builder = await readFile(builderPath, 'utf8');
  const mac = macBlock(builder);
  assert.equal(macScalar(mac, 'hardenedRuntime'), 'true');
  assert.equal(macScalar(mac, 'entitlements'), 'entitlements.mac.plist');
  assert.equal(macScalar(mac, 'entitlementsInherit'), 'entitlements.mac.plist');
});

test('every declared privacy usage string ships with its hardened-runtime entitlement', async () => {
  const [entitlements, builder] = await Promise.all([
    sourceEntitlements(),
    readFile(builderPath, 'utf8'),
  ]);
  const extendInfo = macExtendInfo(macBlock(builder));
  for (const [entitlement, usageKey] of RESOURCE_ENTITLEMENT_USAGE_KEYS) {
    const declared = typeof extendInfo.get(usageKey) === 'string';
    const granted = entitlements.get(entitlement) === true;
    assert.equal(
      granted,
      declared,
      declared
        ? `${usageKey} promises this access, but hardened runtime refuses it without ${entitlement}`
        : `${entitlement} is granted, but ${usageKey} is not declared for the consent prompt`,
    );
  }
});

test('Electron stays new enough to omit unsigned executable memory on every architecture', async () => {
  const manifest = JSON.parse(await readFile(appPackagePath, 'utf8'));
  const electronRange = manifest.devDependencies?.electron;
  assert.equal(typeof electronRange, 'string', 'packages/app must declare its Electron version');
  const major = Number(electronRange.match(/\d+/)?.[0]);
  assert.ok(Number.isInteger(major), `could not read Electron major from ${electronRange}`);
  assert.ok(
    major >= 12,
    `Electron ${electronRange} predates the MAP_JIT-only guidance. Restore com.apple.security.cs.allow-unsigned-executable-memory before using Electron 11 or older.`,
  );
});

test('each vendor allowlist entry pins a path, a team, an exact set and a reason', () => {
  assert.ok(VENDOR_SIGNED_ENTITLEMENTS.size > 0);
  for (const [path, entry] of VENDOR_SIGNED_ENTITLEMENTS) {
    assert.match(path, /^Contents\/Resources\/[^\\]+$/, `${path} must be app-relative`);
    assert.match(entry.teamIdentifier, /^[A-Z0-9]{10}$/, `${path} needs an Apple team id`);
    assert.ok(entry.vendor, `${path} must name its vendor`);
    assert.ok(entry.accepted, `${path} must record why its entitlements were accepted`);
    assert.ok(entry.entitlements.length > 0, `${path} lists no entitlements; drop the entry`);
    assert.equal(new Set(entry.entitlements).size, entry.entitlements.length);
    for (const key of entry.entitlements) assert.match(key, /^com\.apple\.security\./);
  }
});

test('get-task-allow is accepted only on the vendor-signed Node runtime', () => {
  const carriers = [...VENDOR_SIGNED_ENTITLEMENTS]
    .filter(([, entry]) => entry.entitlements.includes('com.apple.security.get-task-allow'))
    .map(([path]) => path);
  assert.deepEqual(carriers, ['Contents/Resources/app.asar.unpacked/dist/node-bundle/node']);
});

test('vendor entitlement check fails on any drift from the pinned set', () => {
  const [path, entry] = [...VENDOR_SIGNED_ENTITLEMENTS][0];
  const exact = new Map(entry.entitlements.map((key) => [key, true]));
  assertExactVendorEntitlements(exact, entry, path);

  const added = new Map([...exact, ['com.apple.security.device.camera', true]]);
  assert.throws(
    () => assertExactVendorEntitlements(added, entry, path),
    /carries com\.apple\.security\.device\.camera, which the reviewed/,
  );

  const dropped = new Map([...exact].slice(1));
  assert.throws(() => assertExactVendorEntitlements(dropped, entry, path), /no longer carries/);
  assert.throws(() => assertExactVendorEntitlements(null, entry, path), /no longer carries/);

  const falseValue = new Map(exact);
  falseValue.set(entry.entitlements[0], false);
  assert.throws(() => assertExactVendorEntitlements(falseValue, entry, path), /no longer carries/);
});

test('app-relative paths match the allowlist keys on any platform separator', () => {
  const app = join(root, 'Gezel.app');
  const node = join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'node-bundle',
    'node',
  );
  assert.ok(VENDOR_SIGNED_ENTITLEMENTS.has(appRelativePath(app, node)));
});

test('the allowlisted Node team matches the release workflow signature pin', async () => {
  const workflow = await readFile(releaseWorkflowPath, 'utf8');
  const node = VENDOR_SIGNED_ENTITLEMENTS.get(
    'Contents/Resources/app.asar.unpacked/dist/node-bundle/node',
  );
  assert.ok(node);
  assert.ok(
    workflow.includes(`TeamIdentifier=${node.teamIdentifier}`),
    'release-electron.yml pins a different Node.js signing team than VENDOR_SIGNED_ENTITLEMENTS',
  );
});

test('macOS release verifies entitlements from the signed app payload', async () => {
  const workflow = await readFile(releaseWorkflowPath, 'utf8');
  assert.match(
    workflow,
    /node scripts\/verify-macos-entitlements\.mjs "\$app"/,
    'release must inspect effective entitlements after signing the packaged app',
  );
});
