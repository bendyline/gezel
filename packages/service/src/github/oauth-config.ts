/**
 * GitHub OAuth App configuration for the device-flow sign-in.
 *
 * The Client ID is hardcoded here, mirroring how VS Code, gh-cli, etc.
 * ship their OAuth IDs in the binary — this is not a secret. The
 * `GEZEL_GITHUB_CLIENT_ID` env var overrides at runtime so a fork or
 * a self-hoster can point at their own OAuth App without rebuilding.
 *
 * The OAuth App must have **Device Flow enabled** in its settings on
 * github.com. Scopes are requested per-call against `startDeviceFlow`.
 */

const FALLBACK_CLIENT_ID = 'Ov23liIszlOUQx24tett';

export function githubOauthClientId(): string {
  const fromEnv = process.env.GEZEL_GITHUB_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  return FALLBACK_CLIENT_ID;
}

/**
 * Default scopes requested when the user signs in from the New Project
 * dialog or Settings. `repo` covers private + public clone, fetch,
 * push; `read:user` lets us call `GET /user` to display the signed-in
 * identity.
 */
export const DEFAULT_GITHUB_SCOPES: readonly string[] = ['repo', 'read:user'];
