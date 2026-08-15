#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

/**
 * Assert that the Electron app namespace contains a discoverable stable release.
 *
 * The repository also hosts `native-v*` engine and legacy npm-package releases. The
 * desktop updater therefore lists releases and selects the greatest stable tag
 * exactly matching `v<semver>`; GitHub's repository-wide "latest" pointer is
 * deliberately irrelevant. Keep this script aligned with
 * packages/app/src/updater/app-release.ts.
 *
 * Run this after publishing a draft app release, and any time the release list
 * has been edited in the GitHub UI.
 *
 *   node scripts/check-latest-release-namespace.mjs
 *   node scripts/check-latest-release-namespace.mjs --repo owner/name
 *   node scripts/check-latest-release-namespace.mjs --expect 1.26214.29
 */
const APP_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEFAULT_REPO = 'bendyline/gezel';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

function compareTags(left, right) {
  const a = APP_TAG.exec(left)?.slice(1).map(Number);
  const b = APP_TAG.exec(right)?.slice(1).map(Number);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function selectLatestAppTag(releases, expectedVersion) {
  if (!Array.isArray(releases)) {
    return { ok: false, reason: 'GitHub returned an invalid release listing.' };
  }
  const tags = releases
    .filter((release) => release?.draft !== true && release?.prerelease !== true)
    .map((release) => release?.tag_name)
    .filter((tag) => typeof tag === 'string' && APP_TAG.test(tag))
    .sort(compareTags);
  const tag = tags.at(-1);
  if (!tag) {
    return { ok: false, reason: 'GitHub reported no published stable app release.' };
  }
  if (expectedVersion && tag !== `v${expectedVersion}`) {
    return {
      ok: false,
      reason: `The app namespace resolves to '${tag}', expected 'v${expectedVersion}'.`,
    };
  }
  return { ok: true, tag };
}

async function main() {
  const repo = arg('--repo') ?? process.env.GH_REPO ?? DEFAULT_REPO;
  const expected = arg('--expect');

  const headers = { Accept: 'application/vnd.github+json' };
  // Unauthenticated is fine for a public repo and keeps this runnable by anyone
  // auditing a release; a token only lifts the shared-IP rate limit.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers,
  });
  if (!response.ok) {
    console.error(
      `check-latest-release-namespace: GitHub returned HTTP ${response.status} for ${repo}`,
    );
    process.exit(1);
  }

  const verdict = selectLatestAppTag(await response.json(), expected);
  if (!verdict.ok) {
    console.error(`✗ ${verdict.reason}`);
    process.exit(1);
  }

  console.log(`✓ ${repo} app update namespace resolves to ${verdict.tag} — discovery is live.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
