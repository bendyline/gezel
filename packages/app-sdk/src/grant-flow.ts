import { GezelSdkError, errorFromResponse } from './errors.js';
import type { SdkTransport } from './tls.js';
import type { ConnectInput } from './types.js';

export async function assertImagesSupported(
  transport: SdkTransport & { baseUrl: string },
): Promise<void> {
  let supported = false;
  try {
    const response = await transport.fetch(`${transport.baseUrl}/api/health`);
    const health = response.ok ? ((await response.json()) as { images?: unknown }) : {};
    supported = typeof health.images === 'object' && health.images !== null;
  } catch {
    supported = false;
  }
  if (!supported) {
    throw new GezelSdkError(
      'This version of Gezel does not offer image generation to apps. Update Gezel to use it.',
      { code: 'images_unsupported' },
    );
  }
}

export interface RequestScopesInput {
  appId: string;
  appName: string;
  /** Every scope the app should hold afterwards: the ones it holds plus the new ones. */
  scopes: string[];
  iconUrl?: string;
  /** Show the code in the app; the person types it into Gezel's approval prompt. */
  onVerificationCode(code: string): Promise<void> | void;
  approvalTimeoutSec?: number;
  tokenStorage?: ConnectInput['tokenStorage'];
}

/**
 * Widen a connected app's grant, for example to add `images`, without
 * disconnecting it. The current token keeps working until the person
 * approves; approval replaces it, so the caller must switch to the returned
 * token (a {@link GezelApp} does this itself through `requestScopes`).
 * A denial, an expiry or a timeout leaves the current grant as it was.
 *
 * Errors: `scope_upgrade_unsupported` from a Gezel that cannot add to a
 * grant, `images_unsupported`, and the usual `user_denied`,
 * `grant_expired` and `approval_timeout`.
 */
export async function requestScopes(
  connection: { baseUrl: string; token: string; fetch: typeof fetch },
  input: RequestScopesInput,
): Promise<string> {
  const baseUrl = connection.baseUrl.replace(/\/+$/, '');
  const transport = { baseUrl, fetch: connection.fetch };
  if (input.scopes.includes('images')) await assertImagesSupported(transport);
  const response = await connection.fetch(`${baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({
      appId: input.appId,
      appName: input.appName,
      scopes: input.scopes,
      ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    }),
  });
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (error.code === 'already_connected') {
      throw new GezelSdkError(
        'This version of Gezel cannot add access to a connected app. Update Gezel, or disconnect and connect again.',
        { code: 'scope_upgrade_unsupported', status: 409 },
      );
    }
    throw error;
  }
  const registered = (await response.json()) as {
    grantRequestId: string;
    token?: string;
    verificationRequired?: boolean;
    verificationCode?: string;
  };
  if (registered.verificationRequired) {
    if (!registered.verificationCode) {
      throw new GezelSdkError('The daemon required verification but returned no connection code.', {
        code: 'invalid_grant_response',
      });
    }
    await input.onVerificationCode(registered.verificationCode);
  }
  const token =
    registered.token ??
    (await pollUntilDecided({
      baseUrl,
      grantRequestId: registered.grantRequestId,
      fetch: connection.fetch,
      timeoutMs: (input.approvalTimeoutSec ?? 120) * 1000,
    }));
  await input.tokenStorage?.save(input.appId, token);
  return token;
}

/**
 * Long-poll the grant endpoint until status flips out of `pending`.
 * The server supports `?wait=N` for native long-polling (up to 30s);
 * we chain those calls until either the user decides or the global
 * timeout expires.
 */
export async function pollUntilDecided(opts: {
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
