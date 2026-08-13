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

function assertCredentialUrl(label: string, raw: string): void {
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

/** OAuth endpoints are credential destinations; accept exact HTTPS URLs only. */
export function validateOAuthEndpoints(endpoints: OAuthEndpoints): OAuthEndpoints {
  assertCredentialUrl('authorization', endpoints.authEndpoint);
  assertCredentialUrl('token', endpoints.tokenEndpoint);
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

/**
 * Meta's Instagram platform never returns a refresh token: the code exchange
 * yields a short-lived token that must be traded (`ig_exchange_token`) for a
 * ~60-day token, which is itself refreshed in place (`ig_refresh_token`)
 * before it expires. A connector type opts in via
 * `secretShape.longLivedExchange`; both URLs are credential destinations, so
 * they get the same exact-HTTPS validation as token endpoints.
 */
export interface LongLivedExchange {
  exchangeUrl: string;
  refreshUrl: string;
}

/**
 * Parse a manifest's `secretShape.longLivedExchange`. Absent/empty returns
 * undefined (the default refresh-token contract stays in force); a partial or
 * non-HTTPS shape throws so a broken manifest fails at link start.
 */
export function parseLongLivedExchange(raw: unknown): LongLivedExchange | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { exchangeUrl?: unknown; refreshUrl?: unknown };
  const exchangeUrl = typeof value.exchangeUrl === 'string' ? value.exchangeUrl.trim() : '';
  const refreshUrl = typeof value.refreshUrl === 'string' ? value.refreshUrl.trim() : '';
  if (!exchangeUrl && !refreshUrl) return undefined;
  assertCredentialUrl('long-lived exchange', exchangeUrl);
  assertCredentialUrl('long-lived refresh', refreshUrl);
  return { exchangeUrl, refreshUrl };
}

export interface ExchangeLongLivedTokenParams {
  exchangeUrl: string;
  /** The short-lived token the code exchange returned. */
  accessToken: string;
  clientSecret?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Trade a short-lived Meta token for its long-lived (~60 day) form. */
export async function exchangeLongLivedToken(
  params: ExchangeLongLivedTokenParams,
): Promise<OAuthTokens> {
  assertCredentialUrl('long-lived exchange', params.exchangeUrl);
  const url = new URL(params.exchangeUrl);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  if (params.clientSecret) url.searchParams.set('client_secret', params.clientSecret);
  url.searchParams.set('access_token', params.accessToken);
  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch(url.toString(), {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readBoundedOAuthJson(res);
  if (!res.ok) {
    // Meta wraps errors as `{error: {message}}` rather than OAuth's string.
    const metaMessage =
      json.error && typeof json.error === 'object'
        ? (json.error as { message?: unknown }).message
        : json.error;
    const err = json.error_description ?? metaMessage ?? `HTTP ${res.status}`;
    throw new Error(`long-lived token exchange failed: ${String(err)}`);
  }
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) throw new Error('long-lived token exchange returned no access token');
  return { accessToken, expiresAt: expiresAtFrom(json.expires_in) };
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
  const clientId = readOAuthClientEnv(clientIdEnv, clientSecretEnv)?.clientId;
  if (!clientId) {
    throw new Error(
      `OAuth is not configured for this connector — set ${clientIdEnv}${clientSecretEnv ? ` (and ${clientSecretEnv})` : ''}.`,
    );
  }
  const clientSecret = clientSecretEnv ? process.env[clientSecretEnv] : undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

const OAUTH_CLIENT_ENV_NAME = /^GEZEL_[A-Z0-9_]{1,120}$/;

function readOAuthClientEnv(clientIdEnv: string, clientSecretEnv?: string): OAuthClient | null {
  if (
    !OAUTH_CLIENT_ENV_NAME.test(clientIdEnv) ||
    (clientSecretEnv && !OAUTH_CLIENT_ENV_NAME.test(clientSecretEnv))
  ) {
    throw new Error('OAuth manifest contains an invalid client environment-variable name');
  }
  const clientId = process.env[clientIdEnv];
  if (!clientId) return null;
  const clientSecret = clientSecretEnv ? process.env[clientSecretEnv] : undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** SecretStore namespace for install-registered OAuth app secrets. */
export const OAUTH_CLIENT_TOOLSET_ID = 'oauth-client';

/**
 * SecretStore key for a bring-your-own OAuth app's client secret. Keyed by
 * the manifest's `clientIdEnv` name — the same key `config.oauthClients`
 * uses — so one provider app registered once serves every connector type
 * that names the same env pair (mail-gmail + calendar-google).
 */
export function oauthClientSecretKey(clientKey: string): {
  kind: 'toolset';
  toolsetId: string;
  fieldId: string;
} {
  return { kind: 'toolset', toolsetId: OAUTH_CLIENT_TOOLSET_ID, fieldId: clientKey };
}

export interface ResolveOAuthClientOptions {
  clientIdEnv?: string;
  clientSecretEnv?: string;
  /**
   * Lazy read of the install's configured clients (`config.oauthClients`).
   * Only consulted on an env miss, so the operator-override fast path never
   * pays a config read.
   */
  getConfiguredClients?: () => Promise<Record<string, { clientId: string }> | undefined>;
  /** Secret lookup for the configured client's secret. */
  getSecret: (key: ReturnType<typeof oauthClientSecretKey>) => Promise<string | null>;
}

/**
 * Resolve the OAuth app identity for a connector: environment variables
 * (the operator/dev override) win when set; otherwise the install's
 * Settings-registered client (`config.oauthClients` + SecretStore secret).
 * Gezel is open source and ships no OAuth client of its own — when neither
 * source is configured, the error names both remedies.
 */
export async function resolveOAuthClient(opts: ResolveOAuthClientOptions): Promise<OAuthClient> {
  const clientIdEnv = opts.clientIdEnv ?? '';
  const fromEnv = readOAuthClientEnv(clientIdEnv, opts.clientSecretEnv);
  if (fromEnv) return fromEnv;

  const configured = (await opts.getConfiguredClients?.().catch(() => undefined))?.[clientIdEnv];
  if (configured?.clientId) {
    const secret = await opts.getSecret(oauthClientSecretKey(clientIdEnv)).catch(() => null);
    return { clientId: configured.clientId, ...(secret ? { clientSecret: secret } : {}) };
  }

  throw new Error(
    `OAuth is not configured for this connector — add your own app's client ID under Settings (Connections), or set ${clientIdEnv}${
      opts.clientSecretEnv ? ` (and ${opts.clientSecretEnv})` : ''
    }.`,
  );
}
