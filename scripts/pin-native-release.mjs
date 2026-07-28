#!/usr/bin/env node
/**
 * Pin the native engine release that this build trusts.
 *
 * Fetches a `native-v<X.Y.Z>` GitHub release, hashes and parses its
 * `SHA256SUMS` asset, and writes the complete trust manifest into
 * `packages/service/src/engines/native-manifest.ts`:
 *
 *   NATIVE_ENGINE_RELEASE  the version the engine resolver downloads
 *   SHA256SUMS_DIGEST      sha256 of that release's SHA256SUMS asset
 *   NATIVE_ENGINE_ARCHIVE_SHA256  every archive hash in SHA256SUMS
 *   NATIVE_ENGINE_MACOS_NOTARIZED whether standalone macOS artifacts
 *                                  were notarized by the native workflow
 *
 * Why the digest matters: the resolver verifies the downloaded
 * `SHA256SUMS` against the baked-in digest, requires its selected archive
 * line to agree with the separately-baked archive map, then hashes the
 * download against that map. That makes the published gezel package —
 * not the GitHub release — the root of trust. Never hand-edit a digest to
 * match a download; run this script, review the diff, and commit it.
 *
 * Usage:
 *   node scripts/pin-native-release.mjs native-v0.1.19
 *   node scripts/pin-native-release.mjs 0.1.19
 *   node scripts/pin-native-release.mjs --latest
 *   node scripts/pin-native-release.mjs native-v0.1.19 --print   # don't write
 *   node scripts/pin-native-release.mjs 0.1.20 --macos-notarized
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
const macosNotarized = argv.includes('--macos-notarized');
const positional = argv.find((a) => !a.startsWith('--'));

if (!positional && !wantLatest) {
  console.error(
    'usage: pin-native-release.mjs (<native-vX.Y.Z> | --latest) [--print] [--macos-notarized]',
  );
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
const archiveHashes = parseSha256sums(bytes.toString('utf8'));
if (archiveHashes.size === 0) {
  throw new Error(`SHA256SUMS for ${release.tag_name} parsed to zero entries`);
}
const releaseAssetNames = new Set(release.assets.map((asset) => asset.name));
for (const filename of archiveHashes.keys()) {
  if (!releaseAssetNames.has(filename)) {
    throw new Error(`SHA256SUMS lists '${filename}', but the release has no matching asset`);
  }
}
const archiveBlock = renderArchiveHashes(version, archiveHashes);

if (printOnly) {
  console.log(`NATIVE_ENGINE_RELEASE = ${version}`);
  console.log(`SHA256SUMS_DIGEST     = ${digest}`);
  console.log(`NATIVE_ENGINE_MACOS_NOTARIZED = ${macosNotarized}`);
  console.log(archiveBlock);
  console.log(`(${archiveHashes.size} archive hashes)`);
  process.exit(0);
}

const source = await readFile(pinFile, 'utf8');
let next = source.replace(/(export const NATIVE_ENGINE_RELEASE = ')[^']*(')/, `$1${version}$2`);
next = next.replace(/(export const SHA256SUMS_DIGEST =\s*')[^']*(')/, `$1${digest}$2`);
next = next.replace(
  /\/\/ BEGIN PINNED NATIVE ARCHIVE HASHES[\s\S]*?\/\/ END PINNED NATIVE ARCHIVE HASHES/,
  archiveBlock,
);
next = next.replace(
  /(export const NATIVE_ENGINE_MACOS_NOTARIZED = )(?:true|false)(;)/,
  `$1${macosNotarized}$2`,
);

if (next === source) {
  console.log(
    `already pinned to native-v${version} (${digest.slice(0, 12)}…, ${archiveHashes.size} archive hashes)`,
  );
  process.exit(0);
}
if (
  !next.includes(version) ||
  !next.includes(digest) ||
  !next.includes(archiveBlock) ||
  !next.includes(`NATIVE_ENGINE_MACOS_NOTARIZED = ${macosNotarized}`)
) {
  throw new Error(
    `could not rewrite the pins in ${pinFile} — the constant declarations moved. Update the regexes in this script.`,
  );
}

await writeFile(pinFile, next);
console.log(`pinned ${pinFile}`);
console.log(`  NATIVE_ENGINE_RELEASE → ${version}`);
console.log(`  SHA256SUMS_DIGEST     → ${digest}`);
console.log(`  ARCHIVE_SHA256        → ${archiveHashes.size} exact archive hashes`);
console.log(`  MACOS_NOTARIZED       → ${macosNotarized}`);

function parseSha256sums(text) {
  const entries = new Map();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line ${index + 1}: ${JSON.stringify(raw)}`);
    const hash = match[1].toLowerCase();
    const filename = match[2].trim();
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error(
        `unsafe SHA256SUMS filename on line ${index + 1}: ${JSON.stringify(filename)}`,
      );
    }
    if (entries.has(filename)) {
      throw new Error(`duplicate SHA256SUMS entry: ${filename}`);
    }
    entries.set(filename, hash);
  }
  return new Map([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

function renderArchiveHashes(version, hashes) {
  const lines = [
    '// BEGIN PINNED NATIVE ARCHIVE HASHES',
    `/** Exact SHA256 values for every archive published by native-v${version}. */`,
    'export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({',
  ];
  for (const [filename, hash] of hashes) {
    lines.push(`  '${filename}':`, `    '${hash}',`);
  }
  lines.push('});', '// END PINNED NATIVE ARCHIVE HASHES');
  return lines.join('\n');
}
