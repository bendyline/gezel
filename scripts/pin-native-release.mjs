#!/usr/bin/env node
/**
 * Pin the native engine release that this build trusts.
 *
 * Fetches a `native-v<X.Y.Z>` GitHub release, hashes its `SHA256SUMS`
 * asset, and writes both values into
 * `packages/service/src/engines/native-manifest.ts`:
 *
 *   NATIVE_ENGINE_RELEASE  the version the engine resolver downloads
 *   SHA256SUMS_DIGEST      sha256 of that release's SHA256SUMS asset
 *
 * Why the digest matters: the resolver verifies the downloaded
 * `SHA256SUMS` against this baked-in value BEFORE trusting any per-asset
 * hash inside it. That makes the published gezel package — not the
 * GitHub release — the root of trust, so a tampered release cannot swap
 * a binary. Never hand-edit the digest to match a download; that defeats
 * the entire mechanism. Run this script, review the diff, commit. The PR
 * is the audit trail.
 *
 * Usage:
 *   node scripts/pin-native-release.mjs native-v0.1.19
 *   node scripts/pin-native-release.mjs 0.1.19
 *   node scripts/pin-native-release.mjs --latest
 *   node scripts/pin-native-release.mjs native-v0.1.19 --print   # don't write
 *
 * Matches bump-node.mjs / bump-pnpm.mjs in shape and ergonomics.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

setDefaultAutoSelectFamilyAttemptTimeout(5000);

const REPO = 'bendyline/gezel';
const GITHUB_API = 'https://api.github.com';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pinFile = resolve(repoRoot, 'packages/service/src/engines/native-manifest.ts');

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const wantLatest = argv.includes('--latest');
const positional = argv.find((a) => !a.startsWith('--'));

if (!positional && !wantLatest) {
  console.error('usage: pin-native-release.mjs (<native-vX.Y.Z> | --latest) [--print]');
  process.exit(1);
}

/**
 * A token is optional — the repo is public. When present it only lifts
 * GitHub's 60-request/hour unauthenticated API rate limit, which is the
 * same contract the runtime resolver uses.
 */
function githubToken() {
  return process.env.GEZEL_GITHUB_TOKEN || process.env.GITHUB_TOKEN || null;
}

function headers(accept) {
  const token = githubToken();
  return {
    accept,
    'user-agent': 'gezel-pin-native-release',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function ghJson(url) {
  const res = await fetch(url, { headers: headers('application/vnd.github+json') });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function resolveRelease() {
  if (wantLatest) {
    const all = await ghJson(`${GITHUB_API}/repos/${REPO}/releases?per_page=100`);
    const release = all.find((r) => r.tag_name?.startsWith('native-v') && !r.draft);
    if (!release) throw new Error('no published native-v* release found');
    return release;
  }
  const version = positional.replace(/^native-v/, '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$/.test(version)) {
    throw new Error(`not a native release version: ${JSON.stringify(positional)}`);
  }
  return ghJson(`${GITHUB_API}/repos/${REPO}/releases/tags/native-v${version}`);
}

const release = await resolveRelease();

if (release.draft) {
  throw new Error(
    `${release.tag_name} is still a draft — publish it before pinning, or the digest will describe a release consumers cannot fetch.`,
  );
}

const version = release.tag_name.replace(/^native-v/, '');
const sums = release.assets?.find((a) => a.name === 'SHA256SUMS');
if (!sums) {
  throw new Error(`release ${release.tag_name} has no SHA256SUMS asset — nothing to anchor to`);
}

// Fetch through the API asset URL with an octet-stream accept so this works
// identically for public and (historically) private releases.
const res = await fetch(sums.url, {
  headers: headers('application/octet-stream'),
  redirect: 'follow',
});
if (!res.ok) throw new Error(`HTTP ${res.status} downloading SHA256SUMS`);
const bytes = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');

const entryCount = bytes
  .toString('utf8')
  .split('\n')
  .filter((line) => line.trim()).length;
if (entryCount === 0) {
  throw new Error(`SHA256SUMS for ${release.tag_name} parsed to zero entries`);
}

if (printOnly) {
  console.log(`NATIVE_ENGINE_RELEASE = ${version}`);
  console.log(`SHA256SUMS_DIGEST     = ${digest}`);
  console.log(`(${entryCount} asset hashes)`);
  process.exit(0);
}

const source = await readFile(pinFile, 'utf8');
let next = source.replace(/(export const NATIVE_ENGINE_RELEASE = ')[^']*(')/, `$1${version}$2`);
next = next.replace(/(export const SHA256SUMS_DIGEST =\s*')[^']*(')/, `$1${digest}$2`);

if (next === source) {
  console.log(`already pinned to native-v${version} (${digest.slice(0, 12)}…)`);
  process.exit(0);
}
if (!next.includes(version) || !next.includes(digest)) {
  throw new Error(
    `could not rewrite the pins in ${pinFile} — the constant declarations moved. Update the regexes in this script.`,
  );
}

await writeFile(pinFile, next);
console.log(`pinned ${pinFile}`);
console.log(`  NATIVE_ENGINE_RELEASE → ${version}`);
console.log(`  SHA256SUMS_DIGEST     → ${digest}  (${entryCount} asset hashes)`);
