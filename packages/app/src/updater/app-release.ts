/**
 * GitHub hosts both whole-app releases (`v1.2.3`) and native-engine releases
 * (`native-v1.2.3`) in the same repository. GitHub's repository-wide
 * `/releases/latest` endpoint cannot distinguish them, so electron-updater's
 * built-in GitHub provider is not a safe discovery mechanism for Gezel.
 *
 * This module establishes an explicit app-release namespace: the latest
 * redirect is accepted only when its tag is exactly `v<semver>`. The updater
 * is then pointed at that immutable release through its generic provider;
 * native releases can never participate in metadata or downloads.
 */

const GITHUB_LATEST_RELEASE = 'https://github.com/bendyline/gezel/releases/latest';
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

/**
 * Resolve GitHub's latest release without following it. This is deliberately
 * the small, non-API redirect endpoint: it avoids the public Releases API's
 * shared-IP rate limit while still exposing the chosen tag for validation.
 */
export async function discoverLatestAppRelease(
  options: AppReleaseDiscoveryOptions,
): Promise<PublishedAppRelease | null> {
  const response = await options.fetch(GITHUB_LATEST_RELEASE, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });

  // A repository with no published releases has no app update yet. This is
  // normal while testing the first application release as a draft.
  if (response.status === 404) return null;
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(
      `GitHub latest-release discovery returned HTTP ${response.status} instead of a redirect`,
    );
  }

  const location = response.headers.get('location');
  if (!location) throw new Error('GitHub latest-release discovery returned no redirect target');

  const target = new URL(location, GITHUB_LATEST_RELEASE);
  const prefix = '/bendyline/gezel/releases/tag/';
  if (
    target.protocol !== 'https:' ||
    target.host !== 'github.com' ||
    !target.pathname.startsWith(prefix)
  ) {
    throw new Error(
      `GitHub latest-release discovery returned an unexpected target: ${target.href}`,
    );
  }

  const encodedTag = target.pathname.slice(prefix.length);
  let tag: string;
  try {
    tag = decodeURIComponent(encodedTag);
  } catch {
    throw new Error('GitHub latest-release discovery returned an invalid encoded tag');
  }
  const parsed = parseAppTag(tag);
  if (!parsed) return null;

  return {
    ...parsed,
    downloadBaseUrl: `${GITHUB_RELEASES_WEB}/download/${parsed.tagName}/`,
  };
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
