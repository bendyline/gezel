/**
 * GitHub hosts both whole-app releases (`v1.2.3`) and native-engine releases
 * (`native-v1.2.3`) and legacy npm-package releases in the same repository.
 * GitHub's repository-wide `/releases/latest` endpoint cannot distinguish
 * them, so electron-updater's built-in GitHub provider is not a safe discovery
 * mechanism for Gezel.
 *
 * This module establishes an explicit app-release namespace by listing public
 * releases and selecting the greatest stable tag that is exactly `v<semver>`.
 * The updater is then pointed at that immutable release through its generic
 * provider; native and legacy package releases can never participate in
 * metadata or downloads.
 */

const GITHUB_RELEASES_API = 'https://api.github.com/repos/bendyline/gezel/releases?per_page=100';
const GITHUB_RELEASES_WEB = 'https://github.com/bendyline/gezel/releases';
const APP_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface PublishedAppRelease {
  version: string;
  tagName: string;
  downloadBaseUrl: string;
}

export interface AppReleaseDiscoveryOptions {
  fetch: typeof globalThis.fetch;
}

export interface AppReleaseFeedConfiguration {
  provider: 'generic';
  url: string;
  useMultipleRangeRequest: false;
}

function parseAppTag(tag: string): { version: string; tagName: string } | null {
  const match = APP_TAG.exec(tag);
  if (!match) return null;
  const version = `${match[1]!}.${match[2]!}.${match[3]!}`;
  return { version, tagName: `v${version}` };
}

interface GitHubReleaseRecord {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Select the greatest published stable app tag from an untrusted API body. */
export function latestPublishedAppRelease(records: unknown): PublishedAppRelease | null {
  if (!Array.isArray(records)) {
    throw new Error('GitHub release discovery returned an invalid response body');
  }

  let latest: { version: string; tagName: string } | null = null;
  for (const value of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const release = value as GitHubReleaseRecord;
    if (release.draft === true || release.prerelease === true) continue;
    if (typeof release.tag_name !== 'string') continue;
    const parsed = parseAppTag(release.tag_name);
    if (!parsed) continue;
    if (!latest || compareVersions(parsed.version, latest.version) > 0) latest = parsed;
  }

  return latest
    ? {
        ...latest,
        downloadBaseUrl: `${GITHUB_RELEASES_WEB}/download/${latest.tagName}/`,
      }
    : null;
}

/**
 * Resolve the latest application release independently of GitHub's mutable
 * repository-wide "latest" pointer. One 100-entry API page leaves ample room
 * for the legacy npm package releases interleaved between desktop releases,
 * while keeping automatic launch checks to one public request.
 */
export async function discoverLatestAppRelease(
  options: AppReleaseDiscoveryOptions,
): Promise<PublishedAppRelease | null> {
  const response = await options.fetch(GITHUB_RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // A repository with no public releases has no app update yet. This is normal
  // while testing the first application release as a draft.
  if (response.status === 404) return null;
  if (!response.ok) {
    const rateRemaining = response.headers.get('x-ratelimit-remaining');
    const rateHint = rateRemaining === '0' ? ' (public GitHub rate limit exhausted)' : '';
    throw new Error(`GitHub release discovery returned HTTP ${response.status}${rateHint}`);
  }

  try {
    return latestPublishedAppRelease(await response.json());
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('GitHub release discovery')) throw err;
    throw new Error('GitHub release discovery returned invalid JSON');
  }
}

export function appReleaseFeedConfiguration(
  release: PublishedAppRelease,
): AppReleaseFeedConfiguration {
  return {
    provider: 'generic',
    url: release.downloadBaseUrl,
    // GitHub release downloads ultimately resolve to object storage. Match
    // electron-updater's GitHub provider and avoid multipart range requests.
    useMultipleRangeRequest: false,
  };
}
