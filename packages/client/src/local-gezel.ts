/**
 * Reach this user's running Gezel without knowing its port, token, or
 * certificate. All three are new on every service launch — an ephemeral port,
 * a rotated token, a fresh self-signed loopback certificate — so anything that
 * copies them goes stale at the next restart. This reads them from the
 * service's runtime files, pins the certificate, and keeps following them: a
 * request that finds the service gone or its token rejected re-reads the files
 * and is sent once more to the service running now.
 */
import { GezelClient } from './client.js';
import { DaemonNotRunningError, LiveDaemonUnhealthyError } from './discover-or-spawn.js';
import { type RuntimeInfo, isProcessAlive, readRuntime } from './discovery.js';
import { type ManagedFetch, createPatientFetch, createTrustingFetch } from './node-tls.js';

export interface LocalGezelOptions {
  /** A Gezel home other than `$GEZEL_HOME` or `~/.gezel`. */
  home?: string;
  /** How long the opening health check may take. Default 5000 ms. */
  healthTimeoutMs?: number;
}

export interface LocalGezel {
  client: GezelClient;
  /**
   * Requests to {@link baseUrl} go to the running service with its current
   * token and certificate. Requests to any other origin pass through
   * untouched and never carry the token.
   */
  fetch: ManagedFetch;
  /** Where the service answered when this connection opened. */
  baseUrl: string;
  /** The token the service issued at that launch; requests always send the current one. */
  token: string;
  /** Release the connection's sockets so the process can exit promptly. */
  close(): Promise<void>;
}

type FetchInput = Parameters<typeof fetch>[0];

interface Live {
  runtime: RuntimeInfo;
  fetch: ManagedFetch;
}

function open(runtime: RuntimeInfo): Live {
  return {
    runtime,
    fetch: runtime.cert ? createTrustingFetch({ cert: runtime.cert }) : createPatientFetch(),
  };
}

function sameLaunch(a: RuntimeInfo, b: RuntimeInfo): boolean {
  return a.pid === b.pid && a.port === b.port && a.token === b.token && a.cert === b.cert;
}

/** A body that can be sent again after the first attempt. Streams cannot. */
function replayable(body: RequestInit['body']): boolean {
  return !(body instanceof ReadableStream);
}

function originOf(input: FetchInput): string | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).origin;
  } catch {
    return null;
  }
}

/**
 * Connect to the Gezel service running for this user. Throws
 * {@link DaemonNotRunningError} when there is none, and
 * {@link LiveDaemonUnhealthyError} when its process is alive but not answering.
 */
export async function connectToLocalGezel(opts: LocalGezelOptions = {}): Promise<LocalGezel> {
  const first = await readRuntime(opts.home);
  if (!first || !isProcessAlive(first.pid)) throw new DaemonNotRunningError();

  const openedOrigin = new URL(first.baseUrl).origin;
  let live = open(first);
  let refreshing: Promise<boolean> | null = null;

  // Single flight: concurrent failures share one re-read.
  const refresh = (): Promise<boolean> => {
    refreshing ??= (async () => {
      const next = await readRuntime(opts.home);
      if (!next || !isProcessAlive(next.pid) || sameLaunch(next, live.runtime)) return false;
      const previous = live;
      live = open(next);
      void previous.fetch.close().catch(() => {});
      return true;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const send = (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const target = new URL(url.pathname + url.search, live.runtime.baseUrl);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${live.runtime.token}`);
    return live.fetch(target, { ...init, headers });
  };

  const route = (async (input: FetchInput, init?: RequestInit) => {
    // The pinned transport trusts only Gezel's certificate, and the token is
    // Gezel's alone: anything else goes out as an ordinary request.
    if (originOf(input) !== openedOrigin) return fetch(input, init);
    if (input instanceof Request) return live.fetch(input, init);
    const url = new URL(String(input));
    const retry = replayable(init?.body);
    let res: Response;
    try {
      res = await send(url, init);
    } catch (err) {
      if (!retry || !(err instanceof TypeError) || !(await refresh())) throw err;
      return send(url, init);
    }
    if (res.status !== 401 || !retry || !(await refresh())) return res;
    await res.body?.cancel().catch(() => {});
    return send(url, init);
  }) as typeof fetch;

  const close = () => live.fetch.close();
  const routed: ManagedFetch = Object.assign(route, {
    close,
    destroy: () => live.fetch.destroy(),
  });

  const client = new GezelClient({ baseUrl: first.baseUrl, token: first.token, fetch: routed });
  try {
    await client.health(AbortSignal.timeout(opts.healthTimeoutMs ?? 5_000));
  } catch (err) {
    await live.fetch.destroy().catch(() => {});
    throw new LiveDaemonUnhealthyError(first.pid, first.baseUrl, { cause: err });
  }
  return { client, fetch: routed, baseUrl: first.baseUrl, token: first.token, close };
}
