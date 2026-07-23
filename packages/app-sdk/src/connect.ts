import { GezelApp } from './client.js';
import { readRuntimeForConnect } from './detect.js';
import { GezelSdkError, errorFromResponse } from './errors.js';
import type { ConnectInput } from './types.js';

/**
 * Bootstrap a {@link GezelApp} for a third-party app.
 *
 * Flow:
 *   1. Resolve baseUrl + fetch (from opts or via runtime discovery).
 *   2. If `existingToken` is supplied OR loaded via `tokenStorage`,
 *      skip registration.
 *   3. Otherwise call `POST /v1/apps/register`, poll the grant
 *      endpoint until decided or `approvalTimeoutSec` elapses, save
 *      the token via `tokenStorage`.
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
  const baseUrlAndFetch = await resolveBaseUrlAndFetch(input);

  // Try a token the caller already has (env, keychain, prior session).
  const existing =
    input.existingToken ??
    (input.tokenStorage?.load ? await input.tokenStorage.load(input.appId) : null);
  if (existing) {
    return new GezelApp({
      baseUrl: baseUrlAndFetch.baseUrl,
      token: existing,
      fetch: baseUrlAndFetch.fetch,
    });
  }

  // Fresh registration.
  const registerRes = await baseUrlAndFetch.fetch(`${baseUrlAndFetch.baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: input.appId,
      appName: input.appName,
      scopes: input.scopes,
      ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    }),
  });
  if (!registerRes.ok) {
    throw await errorFromResponse(registerRes);
  }
  const registered = (await registerRes.json()) as {
    grantRequestId: string;
    status: 'pending' | 'approved' | 'denied';
    token?: string;
  };

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

  return new GezelApp({
    baseUrl: baseUrlAndFetch.baseUrl,
    token,
    fetch: baseUrlAndFetch.fetch,
  });
}

async function resolveBaseUrlAndFetch(
  input: ConnectInput,
): Promise<{ baseUrl: string; fetch: typeof fetch }> {
  if (input.baseUrl) {
    return {
      baseUrl: input.baseUrl,
      fetch: input.fetch ?? globalThis.fetch,
    };
  }
  const discovered = await readRuntimeForConnect();
  if (!discovered) {
    throw new GezelSdkError(
      'gezel daemon not found — no runtime files at ~/.gezel/runtime. Start the gezel app or run `gezeld` first.',
      { code: 'daemon_not_running' },
    );
  }
  return {
    baseUrl: discovered.baseUrl,
    fetch: input.fetch ?? discovered.fetch,
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
      status: 'pending' | 'approved' | 'denied';
      token?: string;
    };
    if (body.status === 'approved' && body.token) return body.token;
    if (body.status === 'denied') {
      throw new GezelSdkError('The user declined the connection.', {
        code: 'user_denied',
        status: 403,
      });
    }
    // status === 'pending' → loop and re-poll.
  }
  throw new GezelSdkError(
    `The user did not approve the connection within ${opts.timeoutMs / 1000} seconds.`,
    { code: 'approval_timeout', status: 408 },
  );
}
