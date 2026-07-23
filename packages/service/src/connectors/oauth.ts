/**
 * Provider-agnostic OAuth 2.0 (Authorization Code + PKCE) primitives, lifted
 * from the mail pipeline. Parameterized by an {@link OAuthEndpoints} descriptor
 * (authorize/token URLs + scopes) rather than a hard provider enum, so any
 * connector type — mail, calendar, a harvested Prismatic connection — drives the
 * same flow.
 *
 * Split so the desktop/web shell owns the browser round-trip:
 *   1. `buildAuthorizeUrl` → the shell opens it; the user consents.
 *   2. the shell captures the redirect `code` and hands it back.
 *   3. `exchangeAuthCode` → tokens.
 * `refreshToken` keeps the access token fresh during sync/send.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 PKCE: a high-entropy verifier + its S256 challenge. */
export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Opaque CSRF/correlation token for the auth round-trip. */
export function randomState(): string {
  return randomBytes(16).toString('base64url');
}

/** Tokens returned by the token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  /** Absent on refresh responses that don't rotate the refresh token. */
  refreshToken?: string;
  /** ISO expiry, computed from `expires_in`. */
  expiresAt: string;
}

/** Authorize/token endpoints + scopes for one source. */
export interface OAuthEndpoints {
  authEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
}

/** OAuth endpoints are credential destinations; accept exact HTTPS URLs only. */
export function validateOAuthEndpoints(endpoints: OAuthEndpoints): OAuthEndpoints {
  for (const [label, raw] of [
    ['authorization', endpoints.authEndpoint],
    ['token', endpoints.tokenEndpoint],
  ] as const) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`OAuth ${label} endpoint is not a valid URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error(`OAuth ${label} endpoint must be an exact HTTPS URL`);
    }
  }
  return endpoints;
}

export function expiresAtFrom(expiresIn: unknown): string {
  const secs = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  // 60s safety margin so we refresh before the server considers it expired.
  return new Date(Date.now() + (secs - 60) * 1000).toISOString();
}

async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<OAuthTokens> {
  validateOAuthEndpoints({ authEndpoint: tokenEndpoint, tokenEndpoint, scopes: [] });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readBoundedOAuthJson(res);
  if (!res.ok) {
    const err = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    throw new Error(`oauth token request failed: ${err}`);
  }
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) throw new Error('oauth token response did not include an access token');
  return {
    accessToken,
    ...(json.refresh_token ? { refreshToken: String(json.refresh_token) } : {}),
    expiresAt: expiresAtFrom(json.expires_in),
  };
}

async function readBoundedOAuthJson(res: Response): Promise<Record<string, unknown>> {
  const maxBytes = 1024 * 1024;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error('oauth token response exceeded 1 MiB');
  }
  if (!res.body) return {};
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('oauth token response exceeded 1 MiB');
      chunks.push(value);
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface BuildAuthorizeUrlParams {
  endpoints: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  /** Provider quirks appended after the standard params (e.g. Google's
   *  `access_type=offline` + `prompt=consent`), in insertion order. */
  extraParams?: Record<string, string>;
  loginHint?: string;
}

/** Build the authorization URL the shell opens in the browser. */
export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  validateOAuthEndpoints(params.endpoints);
  const url = new URL(params.endpoints.authEndpoint);
  const q = url.searchParams;
  q.set('client_id', params.clientId);
  q.set('redirect_uri', params.redirectUri);
  q.set('response_type', 'code');
  q.set('scope', params.endpoints.scopes.join(' '));
  q.set('state', params.state);
  q.set('code_challenge', params.challenge);
  q.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(params.extraParams ?? {})) q.set(k, v);
  if (params.loginHint) q.set('login_hint', params.loginHint);
  return url.toString();
}

export interface ExchangeAuthCodeParams {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Exchange an authorization code for tokens. */
export function exchangeAuthCode(params: ExchangeAuthCodeParams): Promise<OAuthTokens> {
  return postToken(params.endpoints.tokenEndpoint, {
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  });
}

export interface RefreshTokenParams {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

/** Trade a refresh token for a fresh access token. */
export function refreshToken(params: RefreshTokenParams): Promise<OAuthTokens> {
  return postToken(params.endpoints.tokenEndpoint, {
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
  });
}

/** True when a credential's access token is expired (or within the margin). */
export function isExpired(cred: { expiresAt?: string }): boolean {
  return !cred.expiresAt || Date.parse(cred.expiresAt) <= Date.now();
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Resolve an install's OAuth client from env vars named by the connector-type's
 * `secretShape` (`clientIdEnv` / `clientSecretEnv`). Each deployment registers
 * its own OAuth app — no client ids are shipped.
 */
export function resolveOAuthClientFromEnv(
  clientIdEnv: string,
  clientSecretEnv?: string,
): OAuthClient {
  const envName = /^GEZEL_[A-Z0-9_]{1,120}$/;
  if (!envName.test(clientIdEnv) || (clientSecretEnv && !envName.test(clientSecretEnv))) {
    throw new Error('OAuth manifest contains an invalid client environment-variable name');
  }
  const clientId = process.env[clientIdEnv];
  if (!clientId) {
    throw new Error(
      `OAuth is not configured for this connector — set ${clientIdEnv}${clientSecretEnv ? ` (and ${clientSecretEnv})` : ''}.`,
    );
  }
  const clientSecret = clientSecretEnv ? process.env[clientSecretEnv] : undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}
