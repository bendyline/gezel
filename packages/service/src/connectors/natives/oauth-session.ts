/**
 * The per-pass OAuth session and JSON transport shared by the REST-shaped
 * native adapters (Google Calendar, Google Drive, YouTube, Microsoft Graph
 * calendar and files).
 *
 * Every one of them needs the same four things, and before this module each
 * re-derived them slightly differently: read the binding's credential blob,
 * refresh it when expired (re-persisting a rotated refresh token before the
 * pass continues, or the binding strands at the next refresh), turn a refused
 * refresh into a message a person can act on, and turn a non-2xx response
 * into an `HttpStatusError` the engine's retry and rate-limit handling
 * already understand.
 *
 * The transport is injectable (`AdapterDeps.fetch`), which is what lets the
 * provider fakes in `connectors/testing/` drive these adapters end to end.
 */

import { HttpStatusError, isRateLimitStatus } from '@bendyline/gezel';
import { type OAuthEndpoints, isExpired, refreshToken } from '../oauth.js';
import { connectorSecretKey } from '../registry.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';

/** The credential blob `ConnectorManager.completeOAuth` stores for oauth2 types. */
export interface StoredOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  /** Microsoft directory tenant, when the type pins one. */
  tenant?: string;
  /** The token endpoint that issued the grant (newer bindings only). */
  tokenUrl?: string;
}

export interface OAuthSessionOptions {
  /** Human name for messages: "Google", "Microsoft". */
  providerLabel: string;
  /** Token endpoint to refresh against when the credential names none. */
  defaultTokenUrl: (cred: StoredOAuthCredential) => string;
  /**
   * Origins a stored `tokenUrl` may point at. A refresh sends the refresh
   * token and client secret, so a blob naming any other origin is refused.
   */
  tokenOrigins: string[];
}

/** Thrown when a credential is missing, unrefreshable, or refused. */
export class ReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconnectRequiredError';
  }
}

/**
 * One binding's OAuth state for one pass. `token()` refreshes at most once per
 * expiry; `forceRefresh()` is for a 401 on a token that looked valid (revoked
 * early, clock skew).
 */
export class OAuthSession {
  private cred: StoredOAuthCredential | null = null;
  private readonly key: ReturnType<typeof connectorSecretKey>;

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly opts: OAuthSessionOptions,
  ) {
    this.key = connectorSecretKey(binding.type, binding.id);
  }

  /** The stored credential (loaded on first use). */
  async credential(): Promise<StoredOAuthCredential> {
    if (this.cred) return this.cred;
    const blob = await this.deps.secrets.get(this.key);
    if (!blob) {
      throw new ReconnectRequiredError(
        `No stored ${this.opts.providerLabel} sign-in for this connector. Re-link the account from the project's Connections.`,
      );
    }
    let parsed: StoredOAuthCredential;
    try {
      parsed = JSON.parse(blob) as StoredOAuthCredential;
    } catch {
      throw new ReconnectRequiredError(
        `The stored ${this.opts.providerLabel} sign-in for this connector is unreadable. Re-link the account.`,
      );
    }
    if (!parsed.accessToken) {
      throw new ReconnectRequiredError(
        `The stored ${this.opts.providerLabel} sign-in has no access token. Re-link the account.`,
      );
    }
    this.cred = parsed;
    return parsed;
  }

  /** A valid access token, refreshing (and re-persisting) when expired. */
  async token(): Promise<string> {
    const cred = await this.credential();
    if (!isExpired(cred)) return cred.accessToken;
    await this.refresh(cred);
    return this.cred!.accessToken;
  }

  /** Refresh regardless of the stored expiry (after a 401). */
  async forceRefresh(): Promise<string> {
    await this.refresh(await this.credential());
    return this.cred!.accessToken;
  }

  private async refresh(cred: StoredOAuthCredential): Promise<void> {
    if (!cred.refreshToken || !cred.clientId) {
      throw new ReconnectRequiredError(
        `The ${this.opts.providerLabel} sign-in for this connector expired and cannot be renewed. Re-link the account.`,
      );
    }
    const tokenUrl = this.tokenUrl(cred);
    const endpoints: OAuthEndpoints = {
      authEndpoint: tokenUrl,
      tokenEndpoint: tokenUrl,
      scopes: [],
    };
    let t: Awaited<ReturnType<typeof refreshToken>>;
    try {
      t = await refreshToken({
        endpoints,
        clientId: cred.clientId,
        ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
        refreshToken: cred.refreshToken,
        ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/invalid_grant|expired|revoked|invalid_client|unauthorized_client/i.test(detail)) {
        throw new ReconnectRequiredError(
          `The ${this.opts.providerLabel} sign-in for this connector was revoked or has expired (${detail}). Re-link the account from the project's Connections.`,
        );
      }
      throw err;
    }
    const next: StoredOAuthCredential = {
      ...cred,
      accessToken: t.accessToken,
      expiresAt: t.expiresAt,
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    };
    // Persist before continuing: providers that rotate refresh tokens
    // (Microsoft, X) invalidate the old one on use.
    await this.deps.secrets.set(this.key, JSON.stringify(next));
    this.cred = next;
  }

  private tokenUrl(cred: StoredOAuthCredential): string {
    const candidate = cred.tokenUrl ?? this.opts.defaultTokenUrl(cred);
    let origin = '';
    try {
      origin = new URL(candidate).origin;
    } catch {
      /* fall through to the refusal */
    }
    if (!this.opts.tokenOrigins.includes(origin)) {
      throw new ReconnectRequiredError(
        `The stored ${this.opts.providerLabel} sign-in names an unexpected token endpoint. Re-link the account.`,
      );
    }
    return candidate;
  }
}

export interface ApiRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Default 30s. */
  timeoutMs?: number;
}

/**
 * Authorized request through a session: one silent retry with a refreshed
 * token on 401, `HttpStatusError` on any other non-2xx (so 429/503 reach the
 * engine's rate-limit and retry paths), and the raw `Response` on success.
 */
export async function authorizedFetch(
  session: OAuthSession,
  fetchImpl: typeof fetch,
  url: string,
  init: ApiRequestInit = {},
  label = 'api',
): Promise<Response> {
  const attempt = async (token: string) =>
    fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  // Discarded bodies are cancelled without awaiting: nothing depends on the
  // cancel settling, and some stream sources only settle once read elsewhere.
  let res = await attempt(await session.token());
  if (res.status === 401) {
    void res.body?.cancel().catch(() => {});
    res = await attempt(await session.forceRefresh());
    if (res.status === 401) {
      void res.body?.cancel().catch(() => {});
      throw new ReconnectRequiredError(
        `${label} refused this connector's sign-in (HTTP 401). Re-link the account from the project's Connections.`,
      );
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpStatusError(res.status, `${label} ${res.status}: ${body}`.slice(0, 400));
  }
  return res;
}

/** `authorizedFetch` + JSON parse (an empty body parses as `{}`). */
export async function authorizedJson<T = unknown>(
  session: OAuthSession,
  fetchImpl: typeof fetch,
  url: string,
  init: ApiRequestInit = {},
  label = 'api',
): Promise<T> {
  const res = await authorizedFetch(session, fetchImpl, url, init, label);
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned a body that is not JSON`);
  }
}

/**
 * True for an error the engine should treat as backpressure, not failure.
 * Google answers per-user and per-project quota exhaustion with 403 and a
 * reason in the body rather than 429, so a bare status check would turn a
 * throttle into a pass error.
 */
export function isThrottle(err: unknown): boolean {
  if (!(err instanceof HttpStatusError)) return false;
  if (isRateLimitStatus(err.status)) return true;
  return (
    err.status === 403 &&
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/.test(err.message)
  );
}

/** True for an `HttpStatusError` with one of the given statuses. */
export function hasStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof HttpStatusError && statuses.includes(err.status);
}

/** Google OAuth defaults (Calendar, Drive, YouTube, Gmail share one app). */
export const GOOGLE_OAUTH: OAuthSessionOptions = {
  providerLabel: 'Google',
  defaultTokenUrl: () => 'https://oauth2.googleapis.com/token',
  tokenOrigins: ['https://oauth2.googleapis.com'],
};

/** Microsoft identity platform defaults; tenant from the credential. */
export const MICROSOFT_OAUTH: OAuthSessionOptions = {
  providerLabel: 'Microsoft',
  defaultTokenUrl: (cred) =>
    `https://login.microsoftonline.com/${encodeURIComponent(cred.tenant || 'common')}/oauth2/v2.0/token`,
  tokenOrigins: ['https://login.microsoftonline.com'],
};

/** The fetch an adapter should use: the injected one, else global. */
export function transport(deps: AdapterDeps): typeof fetch {
  return deps.fetch ?? fetch;
}
