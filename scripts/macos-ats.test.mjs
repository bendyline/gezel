/**
 * The macOS ATS posture is produced by an afterPack hook, not by config, and a
 * build that loses the hook still packs, signs and notarizes cleanly. These
 * cover the two halves that keep that from shipping silently: the hook's
 * decision policy, and the release gate that inspects the finished bundle.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideAtsAction } from '../packages/app/scripts/harden-mac-ats.cjs';
import { verifyAts } from './verify-macos-ats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('the hook narrows a blanket exemption and leaves everything else alone', () => {
  assert.deepEqual(decideAtsAction(true), { act: true, reason: 'narrowing' });
  assert.deepEqual(decideAtsAction(false), { act: false, reason: 'already-narrow' });
  // Key absent: already the strict default, nothing to do and nothing to warn about.
  assert.deepEqual(decideAtsAction(null), { act: false, reason: 'absent' });
  // Anything else means the plist shape changed; do not guess at it.
  assert.equal(decideAtsAction('YES').act, false);
  assert.match(decideAtsAction('YES').reason, /^unexpected-value:/);
});

test('the hook is wired into the afterPack chain for darwin', () => {
  const afterPack = readFileSync(join(root, 'packages/app/scripts/after-pack.cjs'), 'utf8');
  assert.match(afterPack, /require\('\.\/harden-mac-ats\.cjs'\)/);
  assert.match(afterPack, /await hardenMacAts\(context\)/);

  const hook = readFileSync(join(root, 'packages/app/scripts/harden-mac-ats.cjs'), 'utf8');
  assert.match(
    hook,
    /electronPlatformName !== 'darwin'/,
    'the hook must no-op on non-darwin packs',
  );
  // Surgical replacement, not a parse/serialize round-trip: JSON cannot express
  // plist `data` or `date` values, so a round-trip would silently drop them.
  assert.match(hook, /'-replace', ATS_KEYPATH, '-bool', 'NO'/);
  assert.doesNotMatch(hook, /-convert', 'json/);
});

test('the release job verifies the shipped plist, not just the source config', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release-electron.yml'), 'utf8');
  assert.match(
    workflow,
    /node scripts\/verify-macos-ats\.mjs "\$app"/,
    'release-electron.yml no longer asserts the ATS policy on the packaged app',
  );
});

// Both the fixture writer and the gate itself shell out to `plutil`, which
// only exists on macOS. The gate runs on the macOS release runner; the three
// tests above are plain file reads and stay platform-independent.
test(
  'the gate accepts a narrowed plist and rejects a blanket one',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'gezel-ats-'));
    try {
      const write = (ats) => {
        const path = join(dir, 'Info.plist');
        writeFileSync(path, JSON.stringify({ CFBundleIdentifier: 'com.example', ...ats }));
        execFileSync('/usr/bin/plutil', ['-convert', 'xml1', path]);
        return path;
      };
      const loopback = {
        '127.0.0.1': { NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
        localhost: { NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
      };

      const good = write({
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
          NSExceptionDomains: loopback,
        },
      });
      assert.deepEqual(verifyAts(good).problems, []);

      const blanket = write({
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
          NSExceptionDomains: loopback,
        },
      });
      assert.match(verifyAts(blanket).problems.join('\n'), /NSAllowsArbitraryLoads is true/);

      // A dotted domain key must survive plutil's keypath parsing — `127.0.0.1`
      // reads as four nested keys unless the dots are escaped, which produced a
      // false "missing" report before the gate escaped them.
      const missingLoopback = write({
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSExceptionDomains: { localhost: {} },
        },
      });
      const problems = verifyAts(missingLoopback).problems.join('\n');
      assert.match(problems, /missing 127\.0\.0\.1/);
      assert.doesNotMatch(problems, /missing localhost/);

      // No ATS block at all is the strict default; nothing to complain about.
      const none = write({});
      assert.deepEqual(verifyAts(none).problems, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
