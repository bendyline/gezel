import { GezelApp } from './client.js';
import { readRuntimeForConnect } from './detect.js';
import { GezelSdkError, errorFromResponse } from './errors.js';
import type { SdkTransport } from './tls.js';
import type { AuthorizedConnection, ConnectInput } from './types.js';

/**
 * Bootstrap a {@link GezelApp} for a third-party app.
 *
 * Flow:
 *   1. Resolve baseUrl + fetch (from opts or via runtime discovery).
 *   2. If `existingToken` is supplied OR loaded via `tokenStorage`, verify it
 *      still carries every requested scope and reuse it when valid.
 *   3. Otherwise call `POST /v1/apps/register`, poll the grant
 *      endpoint until decided or `approvalTimeoutSec` elapses. Stateful
 *      scopes also deliver a requester-visible verification code through
 *      `onVerificationCode`. Save the token via `tokenStorage`.
 *   4. Return a `GezelApp` ready to call `chat`, `models`, etc.
 *
 * Errors:
 *   - `daemon_not_running` (network failure or no runtime files).
 *   - `user_denied` (consent dialog rejected).
 *   - `approval_timeout` (`wait` exhausted before user decided).
 *   - HTTP errors from `/v1/apps/register` (`already_connected`, etc.)
 *     are surfaced as `GezelSdkError` with the route's code.
 */
export async function connect(input: ConnectInput): Promise<GezelApp> {
  return new GezelApp(await authorize(input));
}

/**
 * Run Gezel's generic client-side authorization protocol and return the
 * resolved transport plus scoped bearer token.
 *
 * This is the reusable layer for clients that need more than the
 * OpenAI-compatible {@link GezelApp}. It deliberately does not import Gezel's
 * internal product API types; callers can hand the result to whichever typed
 * client matches the scopes they requested.
 */
export async function authorize(input: ConnectInput): Promise<AuthorizedConnection> {
  const transport = await resolveBaseUrlAndFetch(input);
  try {
    return await authorizeWithTransport(input, transport);
  } catch (error) {
    await transport.close?.();
    throw error;
  }
}

async function authorizeWithTransport(
  input: ConnectInput,
  baseUrlAndFetch: SdkTransport & { baseUrl: string },
): Promise<AuthorizedConnection> {
  const expectsVerification =
    input.requireVerificationCode === true ||
    input.scopes.some((scope) => scope !== 'openai' && scope !== 'remote-inference');

  // Try a token the caller already has (env, keychain, prior session).
  let existing =
    input.existingToken ??
    (input.tokenStorage?.load ? await input.tokenStorage.load(input.appId) : null);
  if (existing) {
    const reusable = await tokenHasRequestedScopes({
      baseUrl: baseUrlAndFetch.baseUrl,
      token: existing,
      scopes: input.scopes,
      fetch: baseUrlAndFetch.fetch,
    });
    if (reusable) {
      return {
        baseUrl: baseUrlAndFetch.baseUrl,
        token: existing,
        fetch: baseUrlAndFetch.fetch,
        close: baseUrlAndFetch.close,
      };
    }

    assertVerificationHandler(input, expectsVerification);

    // A revoked token or one from an older, narrower grant must not trap an
    // app in a permanent failure loop. Revoke it when it is still live,
    // discard the local copy, and run the normal visible consent flow again.
    // 401 means it was already revoked; 404 means no daemon-side record.
    const revoke = await baseUrlAndFetch.fetch(
      `${baseUrlAndFetch.baseUrl}/v1/apps/${encodeURIComponent(input.appId)}/token`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${existing}` },
      },
    );
    if (!revoke.ok && revoke.status !== 401 && revoke.status !== 404) {
      throw await errorFromResponse(revoke);
    }
    await revoke.body?.cancel();
    await input.tokenStorage?.delete?.(input.appId);
    existing = null;
  }

  assertVerificationHandler(input, expectsVerification);

  // Fresh registration.
  const registerRes = await baseUrlAndFetch.fetch(`${baseUrlAndFetch.baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: input.appId,
      appName: input.appName,
      scopes: input.scopes,
      ...(input.requireVerificationCode ? { requireVerificationCode: true } : {}),
      ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    }),
  });
  if (!registerRes.ok) {
    throw await errorFromResponse(registerRes);
  }
  const registered = (await registerRes.json()) as {
    grantRequestId: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    token?: string;
    verificationRequired?: boolean;
    verificationCode?: string;
  };

  if (
    expectsVerification &&
    registered.status === 'pending' &&
    registered.verificationRequired !== true
  ) {
    throw new GezelSdkError(
      'The daemon did not honor the required connection-code handshake. Update Gezel before connecting this client.',
      { code: 'verification_not_supported' },
    );
  }

  if (registered.verificationRequired) {
    if (!registered.verificationCode) {
      throw new GezelSdkError('The daemon required verification but returned no connection code.', {
        code: 'invalid_grant_response',
      });
    }
    await input.onVerificationCode?.(registered.verificationCode);
  }

  let token = registered.token;
  if (!token) {
    token = await pollUntilDecided({
      baseUrl: baseUrlAndFetch.baseUrl,
      grantRequestId: registered.grantRequestId,
      fetch: baseUrlAndFetch.fetch,
      timeoutMs: (input.approvalTimeoutSec ?? 120) * 1000,
    });
  }

  if (input.tokenStorage?.save) {
    await input.tokenStorage.save(input.appId, token);
  }

  return {
    baseUrl: baseUrlAndFetch.baseUrl,
    token,
    fetch: baseUrlAndFetch.fetch,
    close: baseUrlAndFetch.close,
  };
}

/**
 * Probe one representative route for every requested public scope. This keeps
 * persisted app tokens honest across scope expansion and daemon-side revoke.
 * Unknown future scopes are left to their owning client surface rather than
 * guessed here.
 */
async function tokenHasRequestedScopes(opts: {
  baseUrl: string;
  token: string;
  scopes: string[];
  fetch: typeof fetch;
}): Promise<boolean> {
  const paths = new Set<string>();
  if (opts.scopes.includes('product') || opts.scopes.includes('cli')) {
    paths.add('/api/config');
  }
  if (opts.scopes.includes('openai')) paths.add('/v1/models');
  if (opts.scopes.includes('remote-inference')) paths.add('/v1/remote/models');
  if (paths.size === 0) return true;

  for (const path of paths) {
    const response = await opts.fetch(`${opts.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (response.status === 401) {
      await response.body?.cancel();
      return false;
    }
    if (response.status === 403) {
      const error = await errorFromResponse(response);
      if (error.code === 'forbidden' || error.code?.startsWith('missing_scope:')) return false;
      throw error;
    }
    if (!response.ok) throw await errorFromResponse(response);
    await response.body?.cancel();
  }
  return true;
}

function assertVerificationHandler(input: ConnectInput, expectsVerification: boolean): void {
  if (!expectsVerification || input.onVerificationCode) return;
  throw new GezelSdkError(
    'This scope requires onVerificationCode so the requesting app can show the user the connection code.',
    { code: 'verification_code_handler_required' },
  );
}

async function resolveBaseUrlAndFetch(
  input: ConnectInput,
): Promise<SdkTransport & { baseUrl: string }> {
  if (input.baseUrl) {
    return {
      baseUrl: input.baseUrl,
      fetch: input.fetch ?? globalThis.fetch,
    };
  }
  const discovered = await readRuntimeForConnect(undefined, input.fetch);
  if (!discovered) {
    throw new GezelSdkError(
      "gezel daemon not found — no runtime files under the gezel home's runtime/ directory (default ~/.gezel, GEZEL_HOME overrides). Start the gezel app or run `gezeld` first.",
      { code: 'daemon_not_running' },
    );
  }
  return {
    baseUrl: discovered.baseUrl,
    fetch: discovered.fetch,
    close: discovered.close,
  };
}

/**
 * Long-poll the grant endpoint until status flips out of `pending`.
 * The server supports `?wait=N` for native long-polling (up to 30s);
 * we chain those calls until either the user decides or the global
 * timeout expires.
 */
async function pollUntilDecided(opts: {
  baseUrl: string;
  grantRequestId: string;
  fetch: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const waitSec = Math.min(30, Math.max(1, Math.floor(remainingMs / 1000)));
    const res = await opts.fetch(
      `${opts.baseUrl}/v1/apps/grant/${opts.grantRequestId}?wait=${waitSec}`,
    );
    if (!res.ok) {
      throw await errorFromResponse(res);
    }
    const body = (await res.json()) as {
      status: 'pending' | 'approved' | 'denied' | 'expired';
      token?: string;
    };
    if (body.status === 'approved' && body.token) return body.token;
    if (body.status === 'denied') {
      throw new GezelSdkError('The user declined the connection.', {
        code: 'user_denied',
        status: 403,
      });
    }
    if (body.status === 'expired') {
      throw new GezelSdkError('The connection request expired before it was approved.', {
        code: 'grant_expired',
        status: 410,
      });
    }
    // status === 'pending' → loop and re-poll.
  }
  throw new GezelSdkError(
    `The user did not approve the connection within ${opts.timeoutMs / 1000} seconds.`,
    { code: 'approval_timeout', status: 408 },
  );
}
