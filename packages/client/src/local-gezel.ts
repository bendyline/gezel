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
  /**
   * Decide the bearer each request carries, instead of the service's own
   * token. For a caller that trades the owner credential for a narrower one
   * (`gezel-mcp --harness`): it is asked again after the service restarts,
   * and the owner token never rides a request while it is set.
   */
  credential?: LocalGezelCredential;
}

/** One launch of the service, as a {@link LocalGezelCredential} sees it. */
export interface LocalGezelLaunch {
  /** Changes whenever the service restarts; tokens minted for one launch die with it. */
  key: string;
  baseUrl: string;
  /** Send a request with the owner token, over this launch's pinned transport. */
  ownerFetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface LocalGezelCredential {
  /** The bearer for a request to `url` on this launch; null sends none (the health check). */
  token(launch: LocalGezelLaunch, url: URL): Promise<string | null>;
  /**
   * The service refused that bearer (401) on a launch that did not restart.
   * Resolve true to send the request once more with a fresh {@link token}.
   */
  rejected?(launch: LocalGezelLaunch, url: URL): Promise<boolean>;
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
  /** The launch this connection reaches now; see {@link LocalGezelOptions.credential}. */
  launch(): LocalGezelLaunch;
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

  const launchOf = (current: Live): LocalGezelLaunch => ({
    key: `${current.runtime.pid}:${current.runtime.port}:${current.runtime.token}`,
    baseUrl: current.runtime.baseUrl,
    ownerFetch: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${current.runtime.token}`);
      return current.fetch(new URL(path, current.runtime.baseUrl), { ...init, headers });
    },
  });

  const send = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const current = live;
    const target = new URL(url.pathname + url.search, current.runtime.baseUrl);
    const headers = new Headers(init?.headers);
    const bearer = opts.credential
      ? await opts.credential.token(launchOf(current), url)
      : current.runtime.token;
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    else headers.delete('Authorization');
    return current.fetch(target, { ...init, headers });
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
    if (res.status !== 401 || !retry) return res;
    const refreshed =
      (await refresh()) ||
      (opts.credential?.rejected ? await opts.credential.rejected(launchOf(live), url) : false);
    if (!refreshed) return res;
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
  return {
    client,
    fetch: routed,
    baseUrl: first.baseUrl,
    token: first.token,
    launch: () => launchOf(live),
    close,
  };
}
