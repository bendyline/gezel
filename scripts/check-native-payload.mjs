#!/usr/bin/env node
/**
 * Assert that a staged native tree actually contains every engine binary
 * its platform is supposed to ship.
 *
 * Two callers, two modes:
 *
 *   node scripts/check-native-payload.mjs --root native/build --all
 *     `.github/workflows/build-native.yml`'s draft-release job, after it
 *     unpacks the matrix artifacts and before it packs the tarballs.
 *
 *   node scripts/check-native-payload.mjs --root packages/app/native-bin
 *     `.github/workflows/release-electron.yml`'s three platform jobs,
 *     after `fetch-native-binaries.mjs` stages the release assets. Checks
 *     only the host platform's keys, which is all that installer carries.
 *
 * Why this exists: the draft-release job already validates the *set of
 * archives*, and `needs: build` means every matrix leg was green. Neither
 * catches a leg that was **preflight-skipped** — an engine whose VERSION
 * file still holds the all-zeros placeholder, or a `workflow_dispatch`
 * with an engine subset, exits success and uploads nothing. The archive
 * set then looks complete while `linux-x64.tar.gz` quietly ships without
 * `gezel-ds4-server`, and the first symptom is a user whose local model
 * won't start. Check the contents, not just the container.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allPlatformKeys,
  detectPlatform,
  expectedBinaries,
  platformVariants,
} from './native-payload.mjs';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx === -1 ? null : args[rootIdx + 1];
const all = args.includes('--all');

// Both workflows need the archive names a native release publishes — the
// draft-release job to gate what it packed, the Electron preflight to gate
// what it is about to download. Emitting the key list here keeps that list
// derived from the payload table rather than hand-copied into two YAML
// arrays that drift the next time a variant is added.
if (args.includes('--list-keys')) {
  console.log(allPlatformKeys().join('\n'));
  process.exit(0);
}

if (!root) {
  console.error('usage: check-native-payload.mjs (--root <dir> [--all] | --list-keys)');
  console.error('  --all         check every published platform key (build side).');
  console.error('                Default: only the host platform keys (consumer side).');
  console.error('  --list-keys   print every published platform key, one per line.');
  process.exit(2);
}

const rootDir = resolve(root);

let keys;
if (all) {
  keys = allPlatformKeys();
} else {
  const platform = detectPlatform();
  if (!platform) {
    console.error(`error: unsupported host platform/arch: ${process.platform}/${process.arch}`);
    process.exit(1);
  }
  keys = platformVariants(platform);
  if (keys.length === 0) {
    console.error(`error: no native payload is published for ${platform}.`);
    process.exit(1);
  }
  console.log(`host platform ${platform} → ${keys.join(', ')}`);
}

const problems = [];
for (const key of keys) {
  const dir = join(rootDir, key);
  if (!existsSync(dir)) {
    problems.push(`${key}: directory missing at ${dir}`);
    continue;
  }
  const missing = expectedBinaries(key).filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    problems.push(`${key}: missing ${missing.join(', ')}`);
    continue;
  }
  console.log(`  ok ${key}: ${expectedBinaries(key).join(', ')}`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::native payload incomplete — ${problem}`);
  }
  console.error(
    'A build-matrix leg was skipped or renamed its output. Check the run summary for ' +
      '"unpinned"/"not selected" preflight notices, and keep scripts/native-payload.mjs ' +
      'in step with the matrix in .github/workflows/build-native.yml.',
  );
  process.exit(1);
}

console.log(`Verified native payload for ${keys.length} platform key(s) under ${rootDir}.`);
