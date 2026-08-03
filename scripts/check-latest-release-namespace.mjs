#!/usr/bin/env node
/**
 * Assert that GitHub's /releases/latest belongs to the Electron app namespace.
 *
 * The desktop updater discovers releases by resolving that endpoint and
 * accepting the target only when its tag is exactly `v<semver>` — see
 * packages/app/src/updater/app-release.ts. The repository also hosts
 * `native-v*` engine releases, and GitHub picks "latest" by publish time
 * across every non-draft, non-prerelease release regardless of tag shape.
 *
 * So a published native release with the prerelease flag cleared does not make
 * clients download the wrong thing: discovery refuses the tag and returns null,
 * and the app reports "no published application release exists yet". Auto-update
 * stops, silently, for everyone already installed. That happened in Aug 2026 —
 * native-v0.1.29 was cut before build-native.yml carried `prerelease: true` and
 * held the stable channel until it was re-flagged by hand.
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

export function classifyLatestTag(tag, expectedVersion) {
  if (typeof tag !== 'string' || tag.length === 0) {
    return { ok: false, reason: 'GitHub reported no latest release for this repository.' };
  }
  if (!APP_TAG.test(tag)) {
    return {
      ok: false,
      reason: [
        `/releases/latest resolves to '${tag}', which is not an app release tag.`,
        'The desktop updater accepts only a bare v<semver> tag, so it will find no',
        'update at all and installed clients stay pinned to their current version.',
        `Fix with:  gh release edit ${tag} --prerelease`,
      ].join('\n'),
    };
  }
  if (expectedVersion && tag !== `v${expectedVersion}`) {
    return {
      ok: false,
      reason: `/releases/latest resolves to '${tag}', expected 'v${expectedVersion}'.`,
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

  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) {
    console.error(
      `check-latest-release-namespace: GitHub returned HTTP ${response.status} for ${repo}`,
    );
    process.exit(1);
  }

  const { tag_name: tag } = await response.json();
  const verdict = classifyLatestTag(tag, expected);
  if (!verdict.ok) {
    console.error(`✗ ${verdict.reason}`);
    process.exit(1);
  }

  console.log(`✓ ${repo} /releases/latest resolves to ${verdict.tag} — update discovery is live.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
