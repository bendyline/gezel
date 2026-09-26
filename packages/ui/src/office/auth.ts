/**
 * The pane's connection to gezel: a `product` grant for app id `office`,
 * requested from the pane itself. The daemon admits registration from this
 * page because it serves it on its own Office origin; the user approves by
 * typing the connection code into Gezel. The token lives in this origin's
 * localStorage, which only pages gezel ships can read.
 */

export const OFFICE_APP_ID = 'office';
export const OFFICE_APP_NAME = 'Microsoft Office';
export const TOKEN_KEY = 'gezel:office:token';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface HttpDeps {
  fetch: typeof fetch;
  baseUrl: string;
}

export function loadToken(storage: KeyValueStorage): string | null {
  try {
    return storage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(storage: KeyValueStorage, token: string): void {
  try {
    storage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage disabled: the token lives only as long as this pane */
  }
}

export function clearToken(storage: KeyValueStorage): void {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

export type ProbeResult = 'ok' | 'revoked' | 'down';

/** Does this token still open the product API? */
export async function probeToken(deps: HttpDeps, token: string): Promise<ProbeResult> {
  try {
    const res = await deps.fetch(`${deps.baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'revoked';
    return 'down';
  } catch {
    return 'down';
  }
}

export type RegisterResult =
  | { kind: 'pending'; grantRequestId: string; code?: string }
  | { kind: 'approved'; token: string }
  | { kind: 'already-connected' }
  | { kind: 'refused'; message: string };

export async function registerPane(deps: HttpDeps): Promise<RegisterResult> {
  const res = await deps.fetch(`${deps.baseUrl}/v1/apps/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: OFFICE_APP_ID, appName: OFFICE_APP_NAME, scopes: ['product'] }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    grantRequestId?: string;
    status?: string;
    token?: string;
    verificationCode?: string;
  };
  if (res.status === 409 && body.error === 'already_connected')
    return { kind: 'already-connected' };
  if (!res.ok) {
    return {
      kind: 'refused',
      message:
        body.error === 'browser_registration_not_allowed'
          ? 'Gezel did not recognize this page. Open the Gezel desktop app and set up Office again under Settings, Connected Apps.'
          : (body.message ?? body.error ?? `Gezel answered ${res.status}.`),
    };
  }
  if (body.status === 'approved' && body.token) return { kind: 'approved', token: body.token };
  if (!body.grantRequestId)
    return { kind: 'refused', message: 'Gezel returned an incomplete answer.' };
  return {
    kind: 'pending',
    grantRequestId: body.grantRequestId,
    ...(body.verificationCode ? { code: body.verificationCode } : {}),
  };
}

export type GrantOutcome =
  | { kind: 'approved'; token: string }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'timeout' };

/** Long-poll until the user decides in Gezel, or `timeoutMs` passes. */
export async function waitForGrant(
  deps: HttpDeps,
  grantRequestId: string,
  opts: { timeoutMs?: number; now?: () => number; signal?: AbortSignal } = {},
): Promise<GrantOutcome> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 5 * 60_000);
  while (now() < deadline) {
    if (opts.signal?.aborted) return { kind: 'timeout' };
    const waitSec = Math.min(30, Math.max(1, Math.floor((deadline - now()) / 1000)));
    const res = await deps.fetch(
      `${deps.baseUrl}/v1/apps/grant/${encodeURIComponent(grantRequestId)}?wait=${waitSec}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return res.status === 404 ? { kind: 'expired' } : { kind: 'timeout' };
    const body = (await res.json()) as { status: string; token?: string };
    if (body.status === 'approved' && body.token) return { kind: 'approved', token: body.token };
    if (body.status === 'denied') return { kind: 'denied' };
    if (body.status === 'expired') return { kind: 'expired' };
  }
  return { kind: 'timeout' };
}
