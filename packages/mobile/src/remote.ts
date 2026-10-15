import type { RemoteFetch, RemoteHttp } from '@bendyline/gezel/remote';
import { type PortableRemoteHost, REMOTE_CERTIFICATE_REFUSED } from '@bendyline/gezel/runtime';
import type { PluginListenerHandle } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

/**
 * Native HTTPS to other devices' gezel servers, and discovery of them.
 *
 * The app's pages may only fetch from themselves (`connect-src 'self'`), and a
 * server's certificate is self-signed for 127.0.0.1, so requests go through
 * the OS: a request either trusts exactly one certificate (`pinnedCertPem`)
 * and no hostname, or — to read a server's `/v1/identity` before anything is
 * pinned — any certificate. A response body arrives as `remoteChunk` events
 * and ends with one `remoteEnd`.
 */
export interface GezelRemotePlugin {
  request(options: {
    id: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    pinnedCertPem?: string;
    connectTimeoutMs: number;
  }): Promise<{ status: number; headers: Record<string, string> }>;
  cancel(options: { id: string }): Promise<void>;
  browse(options: { waitMs: number }): Promise<{
    servers: Array<{ name: string; host: string; port: number; fingerprint?: string }>;
  }>;
  deviceName(): Promise<{ name: string }>;
  addListener(
    event: 'remoteChunk',
    listener: (event: { id: string; data: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'remoteEnd',
    listener: (event: { id: string; error?: string; code?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/** Codes the native side rejects a request with. */
const NATIVE_CERTIFICATE_REFUSED = 'REMOTE_CERTIFICATE_REFUSED';
/** A server answers its first byte quickly or isn't there; streaming after that is unbounded. */
const CONNECT_TIMEOUT_MS = 5_000;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function nativeError(error: unknown): Error {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === NATIVE_CERTIFICATE_REFUSED)
    return Object.assign(new Error(message), { code: REMOTE_CERTIFICATE_REFUSED });
  return Object.assign(new TypeError('fetch failed'), { code: 'REMOTE_UNREACHABLE', cause: error });
}

/**
 * The host side of `PortableRemoteHost` over the native plugin. One listener
 * per event serves every request, keyed by id, so a chunk that arrives
 * before its request's promise settles still lands in its body.
 */
export function createNativeRemoteHost(plugin: GezelRemotePlugin): PortableRemoteHost {
  const bodies = new Map<
    string,
    { chunk(bytes: Uint8Array): void; end(error?: { message: string; code?: string }): void }
  >();
  const listening = Promise.all([
    plugin.addListener('remoteChunk', ({ id, data }) => bodies.get(id)?.chunk(base64Bytes(data))),
    plugin.addListener('remoteEnd', ({ id, error, code }) =>
      bodies.get(id)?.end(error ? { message: error, ...(code ? { code } : {}) } : undefined),
    ),
  ]);
  let deviceName = 'Phone';
  void plugin
    .deviceName()
    .then(({ name }) => {
      if (name.trim()) deviceName = name.trim().slice(0, 120);
    })
    .catch(() => {});

  const channel = (pinnedCertPem?: string): RemoteFetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      await listening;
      const signal = init?.signal ?? null;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const id = crypto.randomUUID();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          ended = true;
          bodies.delete(id);
          void plugin.cancel({ id }).catch(() => {});
        },
      });
      bodies.set(id, {
        chunk: (bytes) => {
          if (!ended) controller.enqueue(bytes);
        },
        end: (error) => {
          if (ended) return;
          ended = true;
          bodies.delete(id);
          if (error) controller.error(nativeError(Object.assign(new Error(error.message), error)));
          else controller.close();
        },
      });
      const onAbort = () => {
        bodies.get(id)?.end({ message: 'aborted' });
        void plugin.cancel({ id }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const head = await plugin.request({
          id,
          url: urlOf(input),
          method: (init?.method ?? 'GET').toUpperCase(),
          headers: headersOf(init),
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
          ...(pinnedCertPem ? { pinnedCertPem } : {}),
          connectTimeoutMs: CONNECT_TIMEOUT_MS,
        });
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (NULL_BODY_STATUSES.has(head.status)) {
          void body.cancel().catch(() => {});
          return new Response(null, { status: head.status, headers: head.headers });
        }
        return new Response(body, { status: head.status, headers: head.headers });
      } catch (error) {
        bodies.delete(id);
        ended = true;
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw signal.reason ?? error;
        throw nativeError(error);
      }
    }) as RemoteFetch;

  const http: RemoteHttp = {
    bootstrap: () => channel(),
    pinned: (certPem) => channel(certPem),
  };
  return {
    http,
    browse: async (waitMs) => (await plugin.browse({ waitMs })).servers,
    deviceName: () => deviceName,
  };
}

export const nativeRemote = registerPlugin<GezelRemotePlugin>('GezelRemote');
