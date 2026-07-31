#!/usr/bin/env node

/**
 * Verify the entitlements that codesign actually embedded in a packaged app.
 *
 * The source plist is only intent. electron-builder may stop reading it, use
 * a different inherited plist, or transform it while signing. The macOS
 * release job runs this after codesign verification so that the signed app and
 * every Electron executable host carry exactly the reviewed set.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMachOBinaries } from './sign-macho-tree.mjs';

export const REVIEWED_ENTITLEMENTS = new Map([
  ['com.apple.security.cs.allow-jit', 'V8/Chromium JIT through MAP_JIT'],
  [
    'com.apple.security.cs.disable-library-validation',
    'vendor-signed Mach-Os and native addons loaded by Electron hosts',
  ],
]);

/**
 * Parse the deliberately small plist shape used for hardened-runtime
 * entitlements: one top-level dictionary containing Boolean values only.
 * Rejecting every other shape makes malformed XML, duplicate keys and a
 * surprising non-Boolean value fail the contract instead of being hidden by a
 * key-only regex.
 */
export function parseBooleanEntitlementsPlist(raw, label = 'entitlements plist') {
  const xmlStart = raw.indexOf('<?xml');
  const plistEnd = raw.lastIndexOf('</plist>');
  if (xmlStart === -1 || plistEnd === -1) {
    throw new Error(`${label} is not an XML property list`);
  }

  const xml = raw
    .slice(xmlStart, plistEnd + '</plist>'.length)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '');
  const wrapper = /^\s*<plist\b[^>]*>\s*<dict>([\s\S]*?)<\/dict>\s*<\/plist>\s*$/.exec(xml);
  if (!wrapper) {
    throw new Error(`${label} must contain one top-level dictionary`);
  }

  const body = wrapper[1];
  const entry = /\s*<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gy;
  const parsed = new Map();
  let offset = 0;
  while (offset < body.length) {
    entry.lastIndex = offset;
    const match = entry.exec(body);
    if (!match) {
      if (/^\s*$/.test(body.slice(offset))) break;
      throw new Error(`${label} contains unsupported or malformed XML near offset ${offset}`);
    }
    const key = match[1].trim();
    if (parsed.has(key)) throw new Error(`${label} contains duplicate key ${key}`);
    parsed.set(key, match[2] === 'true');
    offset = entry.lastIndex;
  }
  return parsed;
}

export function assertExactReviewedEntitlements(actual, label) {
  for (const [key, why] of REVIEWED_ENTITLEMENTS) {
    if (actual.get(key) !== true) {
      throw new Error(`${label} is missing true entitlement ${key} — required for: ${why}`);
    }
  }
  for (const [key, value] of actual) {
    if (!REVIEWED_ENTITLEMENTS.has(key)) {
      throw new Error(`${label} carries unreviewed entitlement ${key}`);
    }
    if (value !== true) {
      throw new Error(
        `${label} includes ${key} with value false; omit false entitlements entirely`,
      );
    }
  }
}

function codesignEntitlements(path) {
  const inspected = spawnSync('codesign', ['--display', '--entitlements', ':-', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspected.error || inspected.status !== 0) {
    const detail = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`.trim();
    throw new Error(`codesign could not inspect ${path}${detail ? `: ${detail}` : ''}`);
  }
  const output = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
  return output.includes('<plist') ? parseBooleanEntitlementsPlist(output, path) : null;
}

function isElectronExecutableHost(path, appPath) {
  if (path.startsWith(`${join(appPath, 'Contents', 'MacOS')}/`)) return true;
  if (path.includes('.app/Contents/MacOS/')) return true;
  return basename(path) === 'chrome_crashpad_handler' || basename(path) === 'ShipIt';
}

export async function verifyMacosEntitlements(appPath) {
  if (process.platform !== 'darwin') {
    throw new Error('effective macOS entitlement verification must run on macOS');
  }

  const resolvedApp = resolve(appPath);
  const sourcePlist = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'app',
    'entitlements.mac.plist',
  );
  const source = parseBooleanEntitlementsPlist(
    await readFile(sourcePlist, 'utf8'),
    'packages/app/entitlements.mac.plist',
  );
  assertExactReviewedEntitlements(source, 'packages/app/entitlements.mac.plist');

  const binaries = [
    ...(await findMachOBinaries(join(resolvedApp, 'Contents', 'MacOS'))),
    ...(await findMachOBinaries(join(resolvedApp, 'Contents', 'Frameworks'))),
  ];
  const hosts = binaries.filter((path) => isElectronExecutableHost(path, resolvedApp));
  if (hosts.length < 2) {
    throw new Error(`expected the main executable and Electron helpers under ${resolvedApp}`);
  }

  for (const host of hosts) {
    const actual = codesignEntitlements(host);
    if (!actual) throw new Error(`${host} has no embedded entitlements`);
    assertExactReviewedEntitlements(actual, host);
  }

  // Also reject an unexpected entitlement on another executable or framework
  // binary even if it is not one of the hosts that must receive allow-jit.
  for (const binary of binaries.filter((path) => !hosts.includes(path))) {
    const actual = codesignEntitlements(binary);
    if (actual) assertExactReviewedEntitlements(actual, binary);
  }

  console.log(`✓ verified exact entitlement set on ${hosts.length} macOS executable hosts`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('usage: node scripts/verify-macos-entitlements.mjs <Gezel.app>');
    process.exit(2);
  }
  verifyMacosEntitlements(appPath).catch((error) => {
    console.error(`macOS entitlement verification failed: ${error.message ?? error}`);
    process.exit(1);
  });
}
