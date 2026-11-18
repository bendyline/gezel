/**
 * The runner's HTTP boundary, installed before the component loads.
 *
 * - Every request goes to an origin the connector type declared, or fails
 *   as `origin`. Checked on the SDK's axios adapter, on `node:http(s)`
 *   (which axios and its redirect follower call per hop, so a redirect to an
 *   undeclared host is refused too), and on `fetch`.
 * - The last failing response is remembered, so an error a component
 *   rewrote in its own words can still be named (throttled, auth, …).
 * - In replay mode, requests are answered from recorded exchanges in order
 *   and no socket is opened.
 *
 * Defense in depth: the OS gives this process the network as a whole.
 */

import http from 'node:http';
import https from 'node:https';
import { type HttpFailure, RunnerError, retryAfterMs } from './failure.js';
import type { RecordedExchange } from './protocol.js';

type AxiosConfig = Record<string, unknown> & {
  method?: string;
  validateStatus?: (s: number) => boolean;
};
type AxiosLike = {
  defaults: { adapter: unknown };
  getAdapter(adapter: unknown): (config: AxiosConfig) => Promise<unknown>;
  getUri(config: AxiosConfig): string;
  AxiosError: new (
    message: string,
    code: string,
    config: unknown,
    request: unknown,
    response: unknown,
  ) => Error;
  AxiosHeaders: new (headers?: Record<string, string>) => unknown;
};

export interface HttpGuard {
  readonly lastFailure: HttpFailure | undefined;
  /** Recordings the component never asked for (replay mode). */
  unusedRecordings(): number;
  /** Indices of the recordings it used, in `replay` order. */
  usedRecordings(): number[];
}

function originPattern(entry: string): (url: URL) => boolean {
  const parsed = new URL(entry.includes('://') ? entry : `https://${entry}`);
  if (parsed.hostname.startsWith('*.')) {
    const suffix = parsed.hostname.slice(1);
    return (url) =>
      url.protocol === parsed.protocol &&
      url.hostname.endsWith(suffix) &&
      url.hostname.length > suffix.length &&
      (parsed.port === '' || url.port === parsed.port);
  }
  return (url) => url.origin === parsed.origin;
}

function requestKey(method: string | undefined, raw: string): string {
  const url = new URL(raw);
  const params = [...url.searchParams].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = new URLSearchParams(params).toString();
  return `${(method ?? 'GET').toUpperCase()} ${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

function urlOfRequestArgs(args: unknown[], defaultProtocol: string): URL | undefined {
  const [first, second] = args;
  try {
    if (typeof first === 'string' || first instanceof URL) return new URL(String(first));
    const opts = (first ?? second) as
      | {
          protocol?: string;
          hostname?: string;
          host?: string;
          port?: number | string;
          path?: string;
        }
      | undefined;
    if (!opts) return undefined;
    const host = opts.hostname ?? opts.host ?? 'localhost';
    const port = opts.port ? `:${opts.port}` : '';
    return new URL(`${opts.protocol ?? defaultProtocol}//${host}${port}${opts.path ?? '/'}`);
  } catch {
    return undefined;
  }
}

export function installHttpGuard(opts: {
  axios: AxiosLike;
  origins: readonly string[];
  replay?: readonly RecordedExchange[];
}): HttpGuard {
  const allowed = opts.origins.map(originPattern);
  const permitted = (url: URL) => allowed.some((match) => match(url));
  const replay = opts.replay ? opts.replay.map((ex) => ({ ex, used: false })) : undefined;
  let lastFailure: HttpFailure | undefined;

  const assertPermitted = (url: URL) => {
    if (replay) {
      throw new RunnerError('replay-miss', `no network in replay mode: ${url.origin}`);
    }
    if (!permitted(url)) {
      throw new RunnerError(
        'origin',
        `the component tried to reach ${url.origin}, which this connector does not declare`,
      );
    }
  };

  const takeRecording = (method: string | undefined, url: string): RecordedExchange => {
    const want = requestKey(method, url);
    const hit = replay?.find(
      (r) => !r.used && requestKey(r.ex.request.method, r.ex.request.url) === want,
    );
    if (!hit) throw new RunnerError('replay-miss', `no recorded exchange for ${want}`);
    hit.used = true;
    return hit.ex;
  };

  const noteFailure = (
    status: number,
    headers: Record<string, unknown> | undefined,
    url: string,
  ) => {
    if (status < 400) return;
    const wait = retryAfterMs(headers?.['retry-after']);
    lastFailure = { status, url, ...(wait !== undefined ? { retryAfterMs: wait } : {}) };
  };

  // 1. The SDK's axios: every client `createClient` builds copies this default.
  const axios = opts.axios;
  const network = axios.getAdapter(axios.defaults.adapter);
  axios.defaults.adapter = async (config: AxiosConfig) => {
    const url = axios.getUri(config);
    if (replay) {
      const ex = takeRecording(config.method, url);
      const status = ex.response.status ?? 200;
      const headers = new axios.AxiosHeaders({
        'content-type': 'application/json',
        ...(ex.response.headers ?? {}),
      });
      const body = ex.response.body;
      const response = {
        data: typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body),
        status,
        statusText: String(status),
        headers,
        config,
        request: {},
      };
      noteFailure(status, ex.response.headers, url);
      const valid = config.validateStatus ? config.validateStatus(status) : status < 400;
      if (!valid) {
        throw new axios.AxiosError(
          `Request failed with status code ${status}`,
          status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
          config,
          {},
          response,
        );
      }
      return response;
    }
    assertPermitted(new URL(url));
    try {
      const response = (await network(config)) as {
        status: number;
        headers?: Record<string, unknown>;
      };
      noteFailure(response.status, response.headers, url);
      return response;
    } catch (err) {
      const res = (err as { response?: { status?: number; headers?: Record<string, unknown> } })
        .response;
      if (typeof res?.status === 'number') noteFailure(res.status, res.headers, url);
      throw err;
    }
  };

  // 2. `node:http(s)`: what axios's adapter and redirect follower call per hop.
  for (const [mod, protocol] of [
    [http, 'http:'],
    [https, 'https:'],
  ] as const) {
    const m = mod as unknown as Record<'request' | 'get', (...args: unknown[]) => unknown>;
    for (const name of ['request', 'get'] as const) {
      const original = m[name];
      const guarded = (...args: unknown[]) => {
        const url = urlOfRequestArgs(args, protocol);
        if (!url) throw new RunnerError('origin', 'the component made a request with no address');
        assertPermitted(url);
        return original.apply(mod, args);
      };
      try {
        m[name] = guarded;
      } catch {
        /* locked by the sandbox, which refuses sockets itself */
      }
    }
  }

  // 3. `fetch`: followed by hand so each hop is checked.
  const realFetch = globalThis.fetch;
  const guardedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (replay) {
      const ex = takeRecording(method, url.href);
      const status = ex.response.status ?? 200;
      noteFailure(status, ex.response.headers, url.href);
      const body = ex.response.body;
      return new Response(
        typeof body === 'string' ? body : body === undefined ? null : JSON.stringify(body),
        { status, headers: { 'content-type': 'application/json', ...(ex.response.headers ?? {}) } },
      );
    }
    for (let hop = 0; hop <= 5; hop++) {
      assertPermitted(url);
      const response = await realFetch(hop === 0 ? input : url, { ...init, redirect: 'manual' });
      const location = response.headers.get('location');
      if (
        response.status >= 300 &&
        response.status < 400 &&
        location &&
        init?.redirect !== 'manual'
      ) {
        url = new URL(location, url);
        continue;
      }
      noteFailure(response.status, Object.fromEntries(response.headers), url.href);
      return response;
    }
    throw new RunnerError('network', 'too many redirects');
  };
  // Under a network-denied sandbox, `fetch` is already locked to a stub that
  // refuses; leave that in place rather than fail the run.
  const fetchSlot = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  if (!fetchSlot || fetchSlot.writable || fetchSlot.set || fetchSlot.configurable) {
    try {
      globalThis.fetch = guardedFetch as typeof fetch;
    } catch {
      /* locked by the sandbox */
    }
  }

  return {
    get lastFailure() {
      return lastFailure;
    },
    unusedRecordings: () => replay?.filter((r) => !r.used).length ?? 0,
    usedRecordings: () => (replay ? replay.flatMap((r, i) => (r.used ? [i] : [])) : []),
  };
}
