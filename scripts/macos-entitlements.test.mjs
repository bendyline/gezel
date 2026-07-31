/**
 * Pin both the intended and effective macOS hardened-runtime entitlement set.
 *
 * Every hardened-runtime exception gives back a protection, so additions are
 * deliberate and reviewed. The v1.26211.26 audit removed unsigned executable
 * memory and DYLD environment variables. This follow-up also removed two
 * App Sandbox-only network keys that had no effect because Gezel is not App
 * Sandbox-enabled.
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
  assertExactReviewedEntitlements,
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
    'development-only; breaks notarization and lets other processes attach',
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

test('macOS release verifies entitlements from the signed app payload', async () => {
  const workflow = await readFile(releaseWorkflowPath, 'utf8');
  assert.match(
    workflow,
    /node scripts\/verify-macos-entitlements\.mjs "\$app"/,
    'release must inspect effective entitlements after signing the packaged app',
  );
});
