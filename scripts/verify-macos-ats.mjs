#!/usr/bin/env node

/**
 * Verify the App Transport Security policy in a packaged app's Info.plist.
 *
 * electron-builder hardcodes `NSAllowsArbitraryLoads = true` into every
 * non-MAS macOS build (`configureLocalhostAts`), and `mac.extendInfo` cannot
 * override it — the deep-assign happens before that function runs. The
 * afterPack hook in packages/app/scripts/harden-mac-ats.cjs narrows it back
 * down before codesign seals the plist.
 *
 * That makes the shipped value depend on a hook continuing to fire inside a
 * build step whose success does not depend on it: if the hook is dropped, the
 * app still packs, still signs, still notarizes, and quietly ships a blanket
 * ATS exemption again. This runs in the release job, against the finished
 * bundle, so that cannot happen silently.
 *
 * Usage: node scripts/verify-macos-ats.mjs <path-to-.app>
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Loopback plaintext HTTP is legitimate: local engines and the preview server. */
const REQUIRED_EXCEPTION_DOMAINS = ['127.0.0.1', 'localhost'];

function plutilExtract(plistPath, keypath) {
  const result = spawnSync('/usr/bin/plutil', ['-extract', keypath, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
}

function plutilHasKey(plistPath, keypath) {
  return (
    spawnSync('/usr/bin/plutil', ['-extract', keypath, 'raw', '-o', '-', plistPath], {
      encoding: 'utf8',
    }).status === 0
  );
}

/**
 * plutil treats `.` as the keypath separator, so a key that contains dots —
 * `127.0.0.1` is exactly that — has to escape them or it reads as four nested
 * dictionaries and reports "no value at that key path" for a key that is
 * plainly there.
 */
function escapeKeypathSegment(segment) {
  return segment.replace(/\./g, '\\.');
}

export function verifyAts(plistPath) {
  const problems = [];

  const arbitrary = plutilExtract(plistPath, 'NSAppTransportSecurity.NSAllowsArbitraryLoads');
  if (arbitrary === true) {
    problems.push(
      'NSAllowsArbitraryLoads is true — the app ships a blanket App Transport Security ' +
        'exemption. The afterPack hook in packages/app/scripts/harden-mac-ats.cjs should ' +
        'have narrowed this; check that it still runs for darwin.',
    );
  } else if (arbitrary !== false && arbitrary !== null) {
    problems.push(`NSAllowsArbitraryLoads has an unexpected value: ${String(arbitrary)}`);
  }

  // Only meaningful when an ATS block exists at all. If electron-builder ever
  // stops writing one, the strict default applies and there is nothing to check.
  if (plutilHasKey(plistPath, 'NSAppTransportSecurity')) {
    for (const domain of REQUIRED_EXCEPTION_DOMAINS) {
      const keypath = `NSAppTransportSecurity.NSExceptionDomains.${escapeKeypathSegment(domain)}`;
      if (!plutilHasKey(plistPath, keypath)) {
        problems.push(
          `NSExceptionDomains is missing ${domain} — loopback plaintext HTTP (local model servers, the preview port) would no longer be explicitly authorized.`,
        );
      }
    }
  }

  return { problems, arbitraryLoads: arbitrary };
}

function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('usage: verify-macos-ats.mjs <path-to-.app>');
    process.exit(1);
  }
  const plistPath = join(resolve(appPath), 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) {
    console.error(`✗ no Info.plist at ${plistPath}`);
    process.exit(1);
  }

  const { problems, arbitraryLoads } = verifyAts(plistPath);
  if (problems.length > 0) {
    console.error('✗ App Transport Security policy check failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `✓ App Transport Security narrowed (NSAllowsArbitraryLoads=${String(arbitraryLoads)}); ` +
      `loopback exceptions present for ${REQUIRED_EXCEPTION_DOMAINS.join(', ')}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
