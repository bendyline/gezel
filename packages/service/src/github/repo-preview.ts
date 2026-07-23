import type { GithubRepoPreviewResponse } from '@bendyline/gezel';
import { Octokit } from '@octokit/rest';
import { githubOauthClientId } from './oauth-config.js';
import { parseGithubUrl } from './url.js';

/**
 * Fetch the metadata + README for a GitHub repo URL — fed into the
 * project-about generator so the New Project dialog can pre-fill the
 * About / Mission objectives sections from a real repo.
 *
 * Errors land as one of three buckets:
 *   - InvalidUrlError: the input doesn't parse as a GitHub repo URL.
 *   - NotFoundError:   the API returned 404 (repo doesn't exist or
 *                      the token can't see it). The UI maps this to
 *                      "we can't read this repo — check the URL or
 *                      sign in again with broader scopes".
 *   - everything else: bubbles up as the underlying error.
 */

const README_BYTE_LIMIT = 6 * 1024;

export class InvalidGithubUrlError extends Error {
  constructor(input: string) {
    super(`Not a recognizable GitHub URL: ${input}`);
    this.name = 'InvalidGithubUrlError';
  }
}

export class GithubRepoNotFoundError extends Error {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
  ) {
    super(`GitHub repo ${owner}/${repo} not found or not accessible with current token.`);
    this.name = 'GithubRepoNotFoundError';
  }
}

/**
 * 401 / 403 from the API. Distinct from "not found" because the
 * remediation differs: re-auth for 401, OAuth-App-org-approval or
 * broader scopes for 403.
 */
export class GithubAccessDeniedError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly hint: string,
    /** Direct URL the user can open to fix it (e.g. the OAuth App
     *  approval page for the org that's blocking access). */
    public readonly fixUrl?: string,
  ) {
    super(hint);
    this.name = 'GithubAccessDeniedError';
  }
}

export async function previewGithubRepo(
  token: string | null,
  url: string,
): Promise<GithubRepoPreviewResponse> {
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new InvalidGithubUrlError(url);
  const { owner, repo, canonical } = parsed;

  const octo = new Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: 'gezel/0.0.0',
  });

  let repoData: Awaited<ReturnType<typeof octo.repos.get>>['data'];
  try {
    const res = await octo.repos.get({ owner, repo });
    repoData = res.data;
  } catch (err) {
    if (isNotFound(err)) throw new GithubRepoNotFoundError(owner, repo);
    const denied = asAccessDenied(err, token, owner);
    if (denied) throw denied;
    throw err;
  }

  let readme = '';
  let truncated = false;
  try {
    const res = await octo.repos.getReadme({ owner, repo });
    const decoded = Buffer.from(res.data.content, res.data.encoding as BufferEncoding).toString(
      'utf8',
    );
    if (decoded.length > README_BYTE_LIMIT) {
      readme = decoded.slice(0, README_BYTE_LIMIT);
      truncated = true;
    } else {
      readme = decoded;
    }
  } catch (err) {
    if (isNotFound(err)) {
      // README missing is fine — the generator handles empty input.
    } else {
      const denied = asAccessDenied(err, token, owner);
      if (denied) throw denied;
      throw err;
    }
  }

  return {
    owner,
    repo,
    canonicalUrl: canonical,
    ...(repoData.default_branch ? { defaultBranch: repoData.default_branch } : {}),
    ...(repoData.description ? { description: repoData.description } : {}),
    ...(repoData.topics && repoData.topics.length > 0 ? { topics: repoData.topics } : {}),
    ...(repoData.language ? { language: repoData.language } : {}),
    readme,
    readmeTruncated: truncated,
  };
}

function isNotFound(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status?: number }).status === 404;
  }
  return false;
}

/**
 * Extracts GitHub's response body from an Octokit-shaped error. The
 * body usually contains a `message` (and a `documentation_url`) that
 * explains the *exact* reason — for 403 it'll either be an
 * OAuth-App-restrictions message ("…the `acme` organization has
 * enabled OAuth App access restrictions…"), a SAML SSO message, a
 * scope problem, or a rate-limit notice. Surfacing GitHub's own text
 * is far more useful than guessing.
 */
function readGithubMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const data = (err as { response?: { data?: { message?: unknown } } }).response?.data;
  if (data && typeof data === 'object' && typeof data.message === 'string') {
    return data.message;
  }
  // Fallback: Octokit copies `data.message` onto `error.message`.
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

function asAccessDenied(
  err: unknown,
  token: string | null,
  owner: string,
): GithubAccessDeniedError | null {
  if (!err || typeof err !== 'object' || !('status' in err)) return null;
  const status = (err as { status?: number }).status;
  if (status === 401) {
    return new GithubAccessDeniedError(
      401,
      token
        ? 'GitHub rejected the stored token (401). Sign out and sign in again to refresh it.'
        : 'GitHub requires authentication to read this repo. Sign in to continue.',
    );
  }
  if (status !== 403) return null;

  const githubMessage = readGithubMessage(err);
  const clientId = githubOauthClientId();
  // The owner-side OAuth App approval page. Org owners go here to
  // approve; non-owners can request approval from the same URL.
  const orgApprovalUrl = `https://github.com/organizations/${owner}/settings/oauth_application_policy`;
  // The user-side connection page. Always works — shows the user
  // which orgs have granted/denied/pending access for this app.
  const userConnectionUrl = `https://github.com/settings/connections/applications/${clientId}`;

  if (githubMessage && /OAuth App access restrictions/i.test(githubMessage)) {
    return new GithubAccessDeniedError(
      403,
      `${githubMessage} Open the connection page below and request access (or, if you own ${owner}, approve the Gezel OAuth App at ${orgApprovalUrl}).`,
      userConnectionUrl,
    );
  }
  if (githubMessage && /SAML/i.test(githubMessage)) {
    return new GithubAccessDeniedError(
      403,
      `${githubMessage} Open the connection page to authorize SSO for the Gezel OAuth App.`,
      userConnectionUrl,
    );
  }
  if (githubMessage && /rate limit/i.test(githubMessage)) {
    return new GithubAccessDeniedError(403, `${githubMessage} Wait a few minutes and try again.`);
  }
  // Generic 403 fallback — surface GitHub's text if it had any, plus
  // both useful URLs.
  const detail = githubMessage ? ` GitHub said: "${githubMessage}".` : '';
  return new GithubAccessDeniedError(
    403,
    `GitHub returned 403.${detail} If ${owner} is an organization with OAuth App restrictions, open ${userConnectionUrl} to request access; otherwise the OAuth grant may lack \`repo\` scope — sign out and back in to refresh.`,
    userConnectionUrl,
  );
}
