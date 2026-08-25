#!/usr/bin/env node
/**
 * Resolve the latest published desktop-app release and render it as the static
 * `releases.json` that the gezel.com landing page reads.
 *
 * The site used to call the GitHub releases API from the visitor's browser and
 * page past ~90 npm-package releases to find the desktop build. That is slow on
 * a good day and returns nothing at all once a shared IP exhausts the anonymous
 * rate limit. Publishing the answer as a file beside index.html turns it into
 * one same-origin request that cannot rate-limit.
 *
 * Selection follows the app-release namespace defined in
 * packages/app/src/updater/app-release.ts: the greatest stable tag that is
 * exactly `v<semver>`. Native-engine (`native-v*`) and npm-package releases
 * share this repository and must never surface as a download.
 *
 *   node scripts/latest-app-release.mjs --out ../gezel-site/releases.json
 *   node scripts/latest-app-release.mjs --repo owner/name --print
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_REPO = 'bendyline/gezel';
export const SCHEMA_VERSION = 1;

const APP_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Release assets are named Gezel-<version>-<os>-<arch>.<ext>. Everything else in
 * the release — blockmaps, electron-updater manifests, the SBOM, SHA256SUMS —
 * is machinery rather than something a person downloads, so this is an
 * allow-list rather than a set of exclusions.
 *
 * .zip is deliberately absent: the mac zip exists only so electron-updater has
 * something to pull for auto-updates, alongside latest-mac.yml and the
 * blockmap. The .pkg is the installer a person actually wants.
 */
const ASSET_RE = /^Gezel-.+-(mac|windows|linux)-([a-z0-9_]+)\.(pkg|dmg|exe|msi|deb|rpm|appimage)$/i;

const CHECKSUMS_RE = /^SHA256SUMS$/i;

const ARCH_ALIASES = { aarch64: 'arm64', arm64: 'arm64', amd64: 'x64', x86_64: 'x64', x64: 'x64' };

function parseAppTag(tag) {
  const match = APP_TAG.exec(tag);
  if (!match) return null;
  return { version: `${match[1]}.${match[2]}.${match[3]}`, tag };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Pick the greatest stable `v<semver>` release out of an untrusted API body.
 *
 * The draft filter is load-bearing rather than cosmetic. This script runs with a
 * maintainer token far more often than not, and an authenticated listing
 * includes draft releases whose asset URLs 404 for every visitor — publishing
 * one would point the whole site at downloads nobody can fetch.
 */
export function selectLatestAppRelease(records) {
  if (!Array.isArray(records)) {
    throw new Error('GitHub release discovery returned an invalid response body');
  }

  let latest = null;
  for (const value of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (value.draft === true || value.prerelease === true) continue;
    if (typeof value.tag_name !== 'string') continue;
    const parsed = parseAppTag(value.tag_name);
    if (!parsed) continue;
    if (!latest || compareVersions(parsed.version, latest.parsed.version) > 0) {
      latest = { parsed, record: value };
    }
  }

  return latest ? { ...latest.parsed, record: latest.record } : null;
}

/** Classify a release's assets into the native desktop builds the site offers. */
export function classifyBuilds(assets) {
  return (Array.isArray(assets) ? assets : [])
    .map((asset) => {
      if (!asset || typeof asset.name !== 'string') return null;
      const match = ASSET_RE.exec(asset.name);
      if (!match) return null;
      const arch = match[2].toLowerCase();
      return {
        name: asset.name,
        platform: match[1].toLowerCase(),
        arch: ARCH_ALIASES[arch] ?? arch,
        format: match[3].toLowerCase(),
        size: typeof asset.size === 'number' ? asset.size : 0,
        url: asset.browser_download_url,
      };
    })
    .filter((build) => build && typeof build.url === 'string')
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.arch.localeCompare(b.arch) ||
        a.format.localeCompare(b.format),
    );
}

/**
 * Locate the Handboek "What's new" article for a release, as a path relative to
 * the listing file — so the landing page can link the notes for the version it
 * is offering instead of the index of every release.
 *
 * Article ids are `whats-new/<major>.<minor>`; the third segment is the build
 * number and never appears in the content tree. The existence check is the
 * whole point: releases do not always get an article (a rebuild, a hotfix), and
 * a landing page linking a 404 is worse than one linking the index. A null here
 * means "fall back to the index", which is what index.html does with it.
 *
 * Callers pass the directory the Handboek was just rendered into, so this stays
 * correct for a non-default --out. An article outside the listing's own
 * directory tree is refused rather than linked through `../` — the listing is
 * read by a page at the site root, so upward paths cannot resolve for a visitor.
 */
export function handboekNotesPath(version, options = {}) {
  const listingDir = resolve(options.listingDir ?? '.');
  const docsDir = resolve(options.docsDir ?? join(listingDir, 'docs'));
  const segments = String(version).split('.');
  if (segments.length < 2) return null;
  const slug = `${segments[0]}.${segments[1]}`;
  const articleDir = join(docsDir, 'whats-new', slug);
  if (!existsSync(join(articleDir, 'index.html'))) return null;
  const rel = relative(listingDir, articleDir);
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) return null;
  return `${rel.split(sep).join('/')}/`;
}

/** Render the selected release as the payload index.html consumes. */
export function buildReleaseListing(selected, options = {}) {
  const repo = options.repo ?? DEFAULT_REPO;
  const releasesUrl = `https://github.com/${repo}/releases`;
  const assets = selected.record?.assets ?? [];
  const checksums = (Array.isArray(assets) ? assets : []).find(
    (asset) => asset && CHECKSUMS_RE.test(asset.name ?? ''),
  );

  return {
    schema: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repo,
    releasesUrl,
    tag: selected.tag,
    version: selected.version,
    published: selected.record?.published_at ?? selected.record?.created_at ?? '',
    notesUrl: selected.record?.html_url ?? releasesUrl,
    notesPath: options.notesPath ?? null,
    checksumsUrl: checksums?.browser_download_url ?? null,
    builds: classifyBuilds(assets),
  };
}

/**
 * Walk the release listing newest-first until a page yields an app release.
 *
 * GitHub orders releases by creation, so the newest app release is on the first
 * page that contains any app release at all; later pages can only hold older
 * ones. Paging exists because npm-package releases share this repository and
 * can fill an entire page on their own.
 */
export async function fetchLatestAppRelease(options = {}) {
  const repo = options.repo ?? DEFAULT_REPO;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxPages = options.maxPages ?? 5;

  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  // Unauthenticated works against a public repo and keeps this runnable by
  // anyone with a checkout; a token only lifts the shared-IP rate limit.
  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  for (let page = 0; page < maxPages && url; page += 1) {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      const exhausted = response.headers?.get?.('x-ratelimit-remaining') === '0';
      throw new Error(
        `GitHub returned HTTP ${response.status} for ${repo}${exhausted ? ' (rate limit exhausted)' : ''}`,
      );
    }
    const selected = selectLatestAppRelease(await response.json());
    if (selected) return selected;
    const link = response.headers?.get?.('Link') ?? '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return null;
}

/** Fetch, render and write the listing. Returns the payload that was written. */
export async function writeReleaseListing(outPath, options = {}) {
  const selected = await fetchLatestAppRelease(options);
  if (!selected) {
    throw new Error(`no published stable app release found in ${options.repo ?? DEFAULT_REPO}`);
  }
  const listingDir = dirname(resolve(outPath));
  const listing = buildReleaseListing(selected, {
    ...options,
    notesPath:
      options.notesPath ??
      handboekNotesPath(selected.version, { listingDir, docsDir: options.docsDir }),
  });
  if (!listing.builds.length) {
    throw new Error(`${listing.tag} publishes no downloadable desktop build`);
  }
  await writeFile(outPath, `${JSON.stringify(listing, null, 2)}\n`, 'utf8');
  return listing;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node scripts/latest-app-release.mjs [options]

  --out <file>   where to write the listing (default: ../gezel-site/releases.json)
  --repo <o/n>   repository to read releases from (default: ${DEFAULT_REPO})
  --print        also print the rendered JSON
`);
    return;
  }

  const out = resolve(repoRoot, value('--out') ?? '../gezel-site/releases.json');
  const listing = await writeReleaseListing(out, {
    repo: value('--repo') ?? process.env.GH_REPO ?? DEFAULT_REPO,
  });
  if (argv.includes('--print')) console.log(JSON.stringify(listing, null, 2));
  console.log(`[releases] ${listing.tag} — ${listing.builds.length} builds → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((err) => {
    console.error(`latest-app-release: ${err.message}`);
    process.exit(1);
  });
}
