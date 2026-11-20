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
  /** The OpenID Connect ID token, when `openid` was asked for. */
  idToken?: string;
  /** The scopes the provider says it granted (space-separated), when it says. */
  scope?: string;
}

/** Authorize/token endpoints + scopes for one source. */
export interface OAuthEndpoints {
  authEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  /**
   * How a confidential client proves itself at the token endpoint: the secret
   * in the form (`post`, the default) or an HTTP Basic header (`basic`).
   * A manifest sets it with `secretShape.tokenAuth`.
   */
  clientAuth?: 'post' | 'basic';
}

/** Token hosts that refuse a secret in the form and require Basic (X documents this). */
const BASIC_CLIENT_AUTH_HOSTS = new Set(['api.x.com', 'api.twitter.com']);

/** The client authentication a token endpoint takes: the manifest's choice, else the host's. */
export function clientAuthFor(
  endpoints: Pick<OAuthEndpoints, 'tokenEndpoint' | 'clientAuth'>,
): 'post' | 'basic' {
  if (endpoints.clientAuth) return endpoints.clientAuth;
  try {
    return BASIC_CLIENT_AUTH_HOSTS.has(new URL(endpoints.tokenEndpoint).hostname)
      ? 'basic'
      : 'post';
  } catch {
    return 'post';
  }
}

/** A `secretShape.tokenAuth` value, or undefined when absent or unknown. */
export function parseTokenAuth(raw: unknown): 'post' | 'basic' | undefined {
  return raw === 'basic' || raw === 'post' ? raw : undefined;
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

/**
 * The client's identity for a token request. With Basic, a confidential
 * client's id and secret go in the header (form-encoded, RFC 6749 §2.3.1) and
 * neither is repeated in the form; a public client always sends its id in the form.
 */
function clientCredentials(
  endpoints: Pick<OAuthEndpoints, 'tokenEndpoint' | 'clientAuth'>,
  clientId: string,
  clientSecret: string | undefined,
): { form: Record<string, string>; headers: Record<string, string> } {
  if (clientSecret && clientAuthFor(endpoints) === 'basic') {
    const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    return {
      form: {},
      headers: { Authorization: `Basic ${Buffer.from(pair).toString('base64')}` },
    };
  }
  return {
    form: { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) },
    headers: {},
  };
}

async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<OAuthTokens> {
  validateOAuthEndpoints({ authEndpoint: tokenEndpoint, tokenEndpoint, scopes: [] });
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
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
    ...(typeof json.id_token === 'string' ? { idToken: json.id_token } : {}),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
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
  /** Injectable for tests and the provider simulator; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Exchange an authorization code for tokens. */
export function exchangeAuthCode(params: ExchangeAuthCodeParams): Promise<OAuthTokens> {
  const client = clientCredentials(params.endpoints, params.clientId, params.clientSecret);
  return postToken(
    params.endpoints.tokenEndpoint,
    {
      ...client.form,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    },
    params.fetchImpl,
    client.headers,
  );
}

export interface RefreshTokenParams {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /** Injectable for tests and the provider simulator; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Trade a refresh token for a fresh access token. */
export function refreshToken(params: RefreshTokenParams): Promise<OAuthTokens> {
  const client = clientCredentials(params.endpoints, params.clientId, params.clientSecret);
  return postToken(
    params.endpoints.tokenEndpoint,
    {
      ...client.form,
      refresh_token: params.refreshToken,
      grant_type: 'refresh_token',
    },
    params.fetchImpl,
    client.headers,
  );
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
 * `secretShape` (`clientIdEnv` / `clientSecretEnv`) alone. The connect flow
 * uses {@link resolveOAuthClient}, which also tries saved and built-in apps.
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

/** An OAuth client supplied by environment variables, as `/api/oauth-clients` lists it. */
export interface EnvOAuthClient {
  key: string;
  clientId: string;
  hasSecret: boolean;
}

/**
 * The OAuth clients this daemon's environment supplies. They win over apps
 * saved in Settings ({@link resolveOAuthClient}), so the bind flow lists them
 * rather than offering a form whose entry would be ignored. Reads the
 * `GEZEL_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` pair every catalog manifest
 * uses: a manifest naming its pair another way still connects through its env
 * vars, it just goes unlisted here.
 */
export function listEnvOAuthClients(env: NodeJS.ProcessEnv = process.env): EnvOAuthClient[] {
  const out: EnvOAuthClient[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('_CLIENT_ID') || !OAUTH_CLIENT_ENV_NAME.test(key)) continue;
    const clientId = value?.trim();
    if (!clientId) continue;
    const secret = env[`${key.slice(0, -'_CLIENT_ID'.length)}_CLIENT_SECRET`]?.trim();
    out.push({ key, clientId, hasSecret: Boolean(secret) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
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
  /**
   * Gezel's own app, when it may serve this connection
   * (`builtinOAuthClientFor`). Tried last, so an app the person or operator
   * chose always wins.
   */
  builtin?: OAuthClient | null;
  /**
   * Gezel has an app for this provider, but not one that may ask for what
   * this connection needs: the error says so instead of implying there is none.
   */
  builtinTooNarrow?: boolean;
}

/**
 * Resolve the OAuth app identity for a connector, in this order: environment
 * variables (the operator/dev override); the client the person saved under
 * Settings (`config.oauthClients` + SecretStore secret); Gezel's own app
 * (`builtin-oauth-clients.ts`) when it covers the connection's scopes. With
 * none, the error names the remedies.
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

  if (opts.builtin) {
    return {
      clientId: opts.builtin.clientId,
      ...(opts.builtin.clientSecret ? { clientSecret: opts.builtin.clientSecret } : {}),
    };
  }

  const remedy = `your own app's client ID under Settings (Connections), or set ${clientIdEnv}${
    opts.clientSecretEnv ? ` (and ${opts.clientSecretEnv})` : ''
  }.`;
  throw new Error(
    opts.builtinTooNarrow
      ? `OAuth is not configured for this connector — Gezel's own app can only read, and this connection asks for more. Add ${remedy}`
      : `OAuth is not configured for this connector — add ${remedy}`,
  );
}
