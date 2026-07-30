import type { GitHubIdentity } from '@bendyline/gezel';
import { Octokit } from '@octokit/rest';
import type { SecretStore } from '../secrets/types.js';

/**
 * GitHub auth glue that the New Project flow + Settings sign-in chip
 * share. Two responsibilities:
 *   - Fetch the signed-in user's identity from a token.
 *   - Persist a freshly-acquired token into both secret slots that
 *     other code paths in the app already read from, so the GitHub
 *     manager (clones, pulls, PR queries) and the Settings page (PAT
 *     mask + "configured" indicator) both see it without duplicate
 *     plumbing.
 *
 * The dual-write is deliberate. Today the GitHub manager reads from
 * `toolset/github/token` while the Settings UI writes to
 * `providerCredential/githubToken` — those slots live in the same
 * SecretStore but aren't bridged. Until that drift is cleaned up, the
 * OAuth completion writes both so the user sees one consistent state.
 */

const GITHUB_TOOLSET_ID = 'github';
const TOKEN_FIELD_ID = 'token';

/** Read the stored GitHub token, regardless of which slot it ended up in. */
export async function getStoredGitHubToken(secrets: SecretStore): Promise<string | null> {
  const toolset = await secrets.get({
    kind: 'toolset',
    toolsetId: GITHUB_TOOLSET_ID,
    fieldId: TOKEN_FIELD_ID,
  });
  if (toolset) return toolset;
  return secrets.get({ kind: 'providerCredential', name: 'githubToken' });
}

/** Persist a token into both slots so every consumer in the app sees it. */
export async function storeGitHubToken(secrets: SecretStore, token: string): Promise<void> {
  await Promise.all([
    secrets.set({ kind: 'toolset', toolsetId: GITHUB_TOOLSET_ID, fieldId: TOKEN_FIELD_ID }, token),
    secrets.set({ kind: 'providerCredential', name: 'githubToken' }, token),
  ]);
}

/** Wipe the token from both slots. Used by the sign-out endpoint. */
export async function clearGitHubToken(secrets: SecretStore): Promise<void> {
  await Promise.all([
    secrets.delete({ kind: 'toolset', toolsetId: GITHUB_TOOLSET_ID, fieldId: TOKEN_FIELD_ID }),
    secrets.delete({ kind: 'providerCredential', name: 'githubToken' }),
  ]);
}

/**
 * Fetch the signed-in user's identity. Throws on auth failure (401),
 * lets the caller render "not signed in" or surface the error.
 */
export async function fetchGitHubIdentity(token: string): Promise<GitHubIdentity> {
  const octokit = new Octokit({
    auth: token,
    userAgent: 'gezel/0.0.0',
  });
  const { data } = await octokit.users.getAuthenticated();
  return {
    login: data.login,
    ...(data.name ? { name: data.name } : {}),
    ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
  };
}
