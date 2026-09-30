/**
 * The pane's connection to gezel: a `product` grant for app id `office`.
 * A pane Gezel set up connects on its own: its manifest URL carries an
 * enrollment key the pane trades for the grant. Without a working key (a
 * manifest registered by hand, or a setup since removed) the pane requests
 * the grant itself and the user approves it by typing the connection code
 * into Gezel. The token lives in this origin's localStorage, which only
 * pages gezel ships can read.
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

/** `browser_registration_not_allowed`: a machine code, not a sentence for a person. */
const ERROR_CODE = /^[a-z0-9_.:-]+$/;

/**
 * What the pane says when Gezel refuses a request: the daemon's own
 * `message`, else its `error` when that is a sentence, else a plain line.
 * Never "Gezel answered 500."
 */
export function paneErrorMessage(
  status: number,
  body: { error?: unknown; message?: unknown },
): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.error === 'string' && body.error.trim() && !ERROR_CODE.test(body.error)) {
    return body.error;
  }
  return status >= 500
    ? 'Gezel ran into a problem. Close this pane and open it again; if that does not help, restart Gezel.'
    : 'Gezel could not connect this document. Close this pane and open it again.';
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

export type EnrollResult = { kind: 'ok'; token: string } | { kind: 'refused' } | { kind: 'down' };

/** Trade the manifest's enrollment key for the grant. Refused means: ask for a code instead. */
export async function enrollPane(deps: HttpDeps, key: string): Promise<EnrollResult> {
  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}/v1/apps/office/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  } catch {
    return { kind: 'down' };
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  return res.ok && body.token ? { kind: 'ok', token: body.token } : { kind: 'refused' };
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
          : paneErrorMessage(res.status, body),
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

/** Past the server's hold, a poll that has not answered is a socket that died (usually in sleep). */
const POLL_GRACE_MS = 15_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 8_000;

/**
 * Long-poll until the user decides in Gezel, or `timeoutMs` passes.
 *
 * A computer that sleeps while the code is on screen wakes with the poll's
 * socket dead, and that fetch either rejects or never settles. Both are
 * retried with backoff until the deadline, as is a daemon that is briefly
 * unreachable, so approving the code after the lid opens still connects.
 */
export async function waitForGrant(
  deps: HttpDeps,
  grantRequestId: string,
  opts: {
    timeoutMs?: number;
    now?: () => number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<GrantOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? 5 * 60_000);
  let backoff = RETRY_MIN_MS;
  while (now() < deadline) {
    if (opts.signal?.aborted) return { kind: 'timeout' };
    const waitSec = Math.min(30, Math.max(1, Math.floor((deadline - now()) / 1000)));
    const answer = await pollGrant(deps, grantRequestId, waitSec, opts.signal);
    if (answer === 'pending') {
      backoff = RETRY_MIN_MS;
      continue;
    }
    if (answer !== 'retry') return answer;
    await sleep(Math.min(backoff, Math.max(0, deadline - now())));
    backoff = Math.min(backoff * 2, RETRY_MAX_MS);
  }
  return { kind: 'timeout' };
}

async function pollGrant(
  deps: HttpDeps,
  grantRequestId: string,
  waitSec: number,
  signal: AbortSignal | undefined,
): Promise<GrantOutcome | 'pending' | 'retry'> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, waitSec * 1000 + POLL_GRACE_MS);
  try {
    const res = await deps.fetch(
      `${deps.baseUrl}/v1/apps/grant/${encodeURIComponent(grantRequestId)}?wait=${waitSec}`,
      { signal: controller.signal },
    );
    if (res.status === 404) return { kind: 'expired' };
    if (!res.ok) return 'retry';
    const body = (await res.json()) as { status: string; token?: string };
    if (body.status === 'approved' && body.token) return { kind: 'approved', token: body.token };
    if (body.status === 'denied') return { kind: 'denied' };
    if (body.status === 'expired') return { kind: 'expired' };
    return 'pending';
  } catch {
    return 'retry';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
