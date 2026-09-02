#!/usr/bin/env node

/**
 * Verify the entitlements codesign actually embedded in the Mac App Store build.
 *
 * A deliberate sibling of verify-macos-entitlements.mjs rather than a shared
 * implementation with a swappable list. That script's REVIEWED_ENTITLEMENTS is
 * the hardened-runtime set, and the two are not variants of one thing: a key
 * that is load-bearing under hardened runtime can be meaningless under the
 * sandbox and vice versa (see the headers on both plists). Making one function
 * serve both would invite exactly the mistake both files exist to prevent —
 * a key drifting from the lane it belongs to. The parser is shaped differently
 * too: this set includes an array value, which the boolean-only parser next
 * door correctly rejects.
 *
 * Run against the signed .app after codesign verification in the MAS lane.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMachOBinaries } from './sign-macho-tree.mjs';

/** The app group both Gezel builds share, so the store app can find a running daemon. */
export const GEZEL_APP_GROUP = 'JXA5M4VK3V.com.bendyline.gezel';

/**
 * The reviewed sandbox capability set. Values are `true` for a Boolean
 * entitlement or an array of exact strings for a list-valued one.
 */
export const MAS_REVIEWED_ENTITLEMENTS = new Map([
  ['com.apple.security.app-sandbox', true],
  ['com.apple.security.network.client', true],
  ['com.apple.security.network.server', true],
  ['com.apple.security.cs.allow-jit', true],
  ['com.apple.security.files.user-selected.read-write', true],
  ['com.apple.security.device.audio-input', true],
  ['com.apple.security.application-groups', [GEZEL_APP_GROUP]],
]);

/** What a child Mach-O must carry: the sandbox, inheritance, and JIT — nothing else. */
export const MAS_INHERIT_ENTITLEMENTS = new Map([
  ['com.apple.security.app-sandbox', true],
  ['com.apple.security.inherit', true],
  ['com.apple.security.cs.allow-jit', true],
]);

/**
 * Parse the entitlement plist shape the MAS lane uses: one top-level dict whose
 * values are Booleans or arrays of strings. Everything else is rejected, so a
 * shape we do not understand fails the contract rather than being waved through
 * by a permissive regex.
 */
export function parseMasEntitlementsPlist(raw, label = 'entitlements plist') {
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
  if (!wrapper) throw new Error(`${label} must contain one top-level dictionary`);

  const body = wrapper[1];
  const entry = /\s*<key>([^<]+)<\/key>\s*(?:<(true|false)\s*\/>|<array>([\s\S]*?)<\/array>)/gy;
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
    if (match[2] !== undefined) {
      parsed.set(key, match[2] === 'true');
    } else {
      const items = [...match[3].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].trim());
      if (items.length === 0) throw new Error(`${label} has an empty array for ${key}`);
      parsed.set(key, items);
    }
    offset = entry.lastIndex;
  }
  return parsed;
}

function describe(value) {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/**
 * Exact-set comparison in both directions: every reviewed key present with the
 * reviewed value, and nothing else present at all. The second direction is the
 * one that matters at review time — an entitlement nobody meant to ship is
 * exactly what a store reviewer will ask about.
 */
export function assertExactMasEntitlements(actual, label, reviewed) {
  for (const [key, expected] of reviewed) {
    const found = actual.get(key);
    if (found === undefined) {
      throw new Error(`${label} is missing required entitlement ${key}`);
    }
    if (describe(found) !== describe(expected)) {
      throw new Error(`${label} has ${key} = ${describe(found)}, expected ${describe(expected)}`);
    }
  }
  for (const [key, value] of actual) {
    if (!reviewed.has(key)) throw new Error(`${label} carries unreviewed entitlement ${key}`);
    if (value === false) {
      throw new Error(`${label} includes ${key} with value false; omit it entirely`);
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
  return output.includes('<plist') ? parseMasEntitlementsPlist(output, path) : null;
}

function teamIdentifier(path) {
  const inspected = spawnSync('codesign', ['--display', '--verbose=4', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
  return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(output)?.[1] ?? null;
}

function isElectronExecutableHost(path, appPath) {
  if (path.startsWith(`${join(appPath, 'Contents', 'MacOS')}/`)) return true;
  if (path.includes('.app/Contents/MacOS/')) return true;
  return basename(path) === 'chrome_crashpad_handler';
}

export async function verifyMasEntitlements(appPath) {
  if (process.platform !== 'darwin') {
    throw new Error('effective MAS entitlement verification must run on macOS');
  }

  const resolvedApp = resolve(appPath);
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app');
  const source = parseMasEntitlementsPlist(
    await readFile(join(appRoot, 'entitlements.mas.plist'), 'utf8'),
    'packages/app/entitlements.mas.plist',
  );
  assertExactMasEntitlements(
    source,
    'packages/app/entitlements.mas.plist',
    MAS_REVIEWED_ENTITLEMENTS,
  );
  const inherit = parseMasEntitlementsPlist(
    await readFile(join(appRoot, 'entitlements.mas.inherit.plist'), 'utf8'),
    'packages/app/entitlements.mas.inherit.plist',
  );
  assertExactMasEntitlements(
    inherit,
    'packages/app/entitlements.mas.inherit.plist',
    MAS_INHERIT_ENTITLEMENTS,
  );

  const binaries = [
    ...(await findMachOBinaries(join(resolvedApp, 'Contents', 'MacOS'))),
    ...(await findMachOBinaries(join(resolvedApp, 'Contents', 'Frameworks'))),
    ...(await findMachOBinaries(join(resolvedApp, 'Contents', 'Resources'))),
  ];
  const hosts = binaries.filter((path) => isElectronExecutableHost(path, resolvedApp));
  if (hosts.length < 2) {
    throw new Error(`expected the main executable and Electron helpers under ${resolvedApp}`);
  }

  for (const host of hosts) {
    const actual = codesignEntitlements(host);
    if (!actual) throw new Error(`${host} has no embedded entitlements`);
    // The main app binary carries the full set; helpers carry the inherit set.
    const expected =
      host === join(resolvedApp, 'Contents', 'MacOS', basename(host)) &&
      actual.has('com.apple.security.application-groups')
        ? MAS_REVIEWED_ENTITLEMENTS
        : MAS_INHERIT_ENTITLEMENTS;
    assertExactMasEntitlements(actual, host, expected);
  }

  // Every Mach-O in the payload must be OURS. This is the check that would
  // catch a vendor signature surviving into the store build — node, DuckDB, or
  // a native engine kept byte-identical the way the Developer ID lane wants.
  // Under the sandbox such a binary cannot inherit the app's capabilities, and
  // the failure it produces at runtime looks like anything but a signing bug.
  const foreign = [];
  for (const binary of binaries) {
    const team = teamIdentifier(binary);
    if (team !== GEZEL_APP_GROUP.split('.')[0]) {
      foreign.push(`${binary} (TeamIdentifier=${team ?? 'none'})`);
    }
  }
  if (foreign.length > 0) {
    throw new Error(
      `MAS payload contains Mach-Os not signed with our Apple Distribution identity:\n  ${foreign.join('\n  ')}`,
    );
  }

  console.log(
    `✓ verified MAS entitlements on ${hosts.length} executable hosts and our team ID on ${binaries.length} Mach-Os`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('usage: node scripts/verify-mas-entitlements.mjs <Gezel.app>');
    process.exit(2);
  }
  verifyMasEntitlements(appPath).catch((error) => {
    console.error(`MAS entitlement verification failed: ${error.message ?? error}`);
    process.exit(1);
  });
}
