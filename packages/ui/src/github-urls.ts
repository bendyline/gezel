/**
 * The one statement of where Gezel lives on GitHub. Releases, issues, and
 * anything else that has to name `bendyline/gezel` reads it from here — an
 * org or repo rename should be a one-line change.
 */

export const GITHUB_REPO_URL = 'https://github.com/bendyline/gezel';
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const ISSUES_NEW_URL = `${GITHUB_REPO_URL}/issues/new`;

export function releaseUrl(version?: string): string {
  return version ? `${RELEASES_URL}/tag/v${encodeURIComponent(version)}` : RELEASES_URL;
}
