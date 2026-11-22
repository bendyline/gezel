/**
 * `fetch` dispatchers for talking to a paired remote daemon over the LAN.
 *
 * A paired server presents its loopback TLS cert (SAN `127.0.0.1`) on a
 * routable address, so SAN/hostname matching can't apply. The **exact-cert
 * pin** is the trust boundary instead — only the one cert captured at pairing
 * validates; any substitute (a MITM's own self-signed cert) fails the CA
 * check. Continuity across the server's per-boot cert rotation is proven
 * separately by the device-identity signature over the cert fingerprint
 * (see [identity.ts](./identity.ts) `verifyIdentitySignature`).
 *
 * Uses undici directly (not Node's global fetch) so the Agent and fetch come
 * from the same package version — mismatched undici ABIs throw at request time
 * (see client/node-tls.ts for the gory details).
 */

import { Agent, Pool, fetch as undiciFetch } from 'undici';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from './identity.js';
import type { PairedRemote, RemotesRegistry } from './types.js';

type UndiciUrl = Parameters<typeof undiciFetch>[0];
type UndiciInit = Parameters<typeof undiciFetch>[1];

export interface CloseFetchOptions {
  /**
   * How long requests still in flight may finish before they are aborted.
   * Omitted, close waits for every one of them, however long it streams.
   */
  graceMs?: number;
}

export type ClosableFetch = typeof fetch & { close(options?: CloseFetchOptions): Promise<void> };

/** Connect timeout for a paired peer (see {@link createPinnedFetch}). */
export const PINNED_CONNECT_TIMEOUT_MS = 5_000;

/**
 * What {@link closePairedRemoteFetches} gives in-flight requests. A streamed
 * reply (a status feed the UI holds open, a model download) ends only when its
 * own client hangs up, so an unbounded close waited on it: quitting with
 * Settings → About open stalled shutdown until the supervisor killed the daemon.
 */
export const PAIRED_FETCH_CLOSE_GRACE_MS = 2_000;

/** Failures before any TLS handshake: no certificate was presented, so none can be stale. */
const NO_HANDSHAKE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function failedBeforeHandshake(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NO_HANDSHAKE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function closeFetch(
  fetchImpl: typeof fetch | null | undefined,
  options?: CloseFetchOptions,
): Promise<void> {
  const close = (fetchImpl as Partial<ClosableFetch> | null | undefined)?.close;
  if (typeof close === 'function') await close.call(fetchImpl, options);
}

/**
 * An undici Agent that can close gracefully and then, once a grace runs out,
 * abort what is still in flight. `Agent.close()` forgets its per-origin pools
 * the moment it starts, so an `Agent.destroy()` after it finds nothing to tear
 * down and the streams keep running; this keeps its own hold on each pool.
 */
function createClosableAgent(options: Agent.Options): {
  dispatcher: Agent;
  close(options?: CloseFetchOptions): Promise<void>;
} {
  const pools = new Set<Pool>();
  const dispatcher = new Agent({
    ...options,
    factory: (origin, poolOptions) => {
      for (const pool of pools) if (pool.closed || pool.destroyed) pools.delete(pool);
      const pool = new Pool(origin, poolOptions as Pool.Options);
      pools.add(pool);
      return pool;
    },
  });
  const close = async (closeOptions?: CloseFetchOptions): Promise<void> => {
    const closing = dispatcher.close();
    const graceMs = closeOptions?.graceMs;
    if (graceMs === undefined) return closing;
    let timer: NodeJS.Timeout | undefined;
    const graceExpired = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, graceMs));
      timer.unref?.();
    });
    const expired = await Promise.race([closing.then(() => false as const), graceExpired]).finally(
      () => clearTimeout(timer),
    );
    if (!expired) return;
    closing.catch(() => undefined);
    const remaining = Array.from(pools);
    pools.clear();
    await Promise.allSettled(remaining.map((pool) => pool.destroy()));
  };
  return { dispatcher, close };
}

/**
 * Pin a single self-signed cert as the sole CA and skip hostname/SAN
 * verification. Long-call-friendly (no header/body timeouts) for streamed
 * inference + large artifact downloads.
 */
export function createPinnedFetch(certPem: string): ClosableFetch {
  const { dispatcher, close } = createClosableAgent({
    connect: {
      ca: certPem,
      rejectUnauthorized: true,
      // SAN matching is meaningless for a pinned loopback cert reached by LAN
      // IP; the cert identity itself is the pin, reinforced by the identity
      // signature verified at connect time.
      checkServerIdentity: () => undefined,
      // A peer on the local network answers a connect within milliseconds.
      // Waiting undici's default 10 s for one that left the network only
      // delays the fallback; streamed replies keep their unlimited timeouts.
      timeout: PINNED_CONNECT_TIMEOUT_MS,
    },
    allowH2: true,
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const pinned = ((url: UndiciUrl, init?: UndiciInit) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as ClosableFetch;
  pinned.close = close;
  return pinned;
}

/**
 * TOFU bootstrap fetch used ONLY for the very first `/v1/identity` call during
 * pairing, before any cert is pinned. Accepts the server's self-signed cert
 * unconditionally; the response's identity signature + out-of-band fingerprint
 * comparison are what actually establish trust (SSH `known_hosts` semantics).
 * Never reuse this for inference — pair, pin, then use {@link createPinnedFetch}.
 */
export function createInsecureBootstrapFetch(): ClosableFetch {
  const { dispatcher, close } = createClosableAgent({
    connect: { rejectUnauthorized: false },
    allowH2: true,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const bootstrap = ((url: UndiciUrl, init?: UndiciInit) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as ClosableFetch;
  bootstrap.close = close;
  return bootstrap;
}

/**
 * Fetch through a paired identity. If the daemon rotated its ephemeral TLS
 * certificate, refresh it over an insecure bootstrap channel but accept it
 * only when the already-pinned device identity signs the new fingerprint.
 */
export function createPairedRemoteFetch(
  remote: PairedRemote,
  registry: RemotesRegistry,
  deps: {
    createPinned?: (certPem: string) => typeof fetch;
    createBootstrap?: () => typeof fetch;
  } = {},
): ClosableFetch {
  const baseUrl = new URL(remote.baseUrl);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('paired remote transport requires an exact HTTPS origin');
  }
  const makePinned = deps.createPinned ?? createPinnedFetch;
  const makeBootstrap = deps.createBootstrap ?? createInsecureBootstrapFetch;
  let active = remote.tlsCertPem ? makePinned(remote.tlsCertPem) : null;
  let refresh: Promise<void> | null = null;
  let closed = false;

  const paired = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (closed) throw new Error('paired remote fetch is closed');
    if (!active) {
      refresh ??= refreshPairedCertificate(remote, registry, makeBootstrap).then((cert) => {
        active = makePinned(cert);
      });
      await refresh.finally(() => {
        refresh = null;
      });
    }
    try {
      return await active!(url, init);
    } catch (originalError) {
      // A refresh re-dials the same address; when that address answered
      // nothing at all it doubles the wait and fails the same way.
      if (init?.signal?.aborted || failedBeforeHandshake(originalError)) throw originalError;
      refresh ??= refreshPairedCertificate(remote, registry, makeBootstrap).then((cert) => {
        const previous = active;
        active = makePinned(cert);
        void closeFetch(previous);
      });
      try {
        await refresh;
      } catch {
        throw originalError;
      } finally {
        refresh = null;
      }
      return await active!(url, init);
    }
  }) as ClosableFetch;
  paired.close = async (options) => {
    if (closed) return;
    closed = true;
    await refresh?.catch(() => undefined);
    const current = active;
    active = null;
    await closeFetch(current, options);
  };
  return paired;
}

const sharedFetches = new WeakMap<
  RemotesRegistry,
  Map<string, { connectionKey: string; fetch: ClosableFetch }>
>();

/** Reuse one managed Undici agent per paired server instead of leaking one per operation. */
export function getPairedRemoteFetch(
  remote: PairedRemote,
  registry: RemotesRegistry,
): ClosableFetch {
  let entries = sharedFetches.get(registry);
  if (!entries) {
    entries = new Map();
    sharedFetches.set(registry, entries);
  }
  const connectionKey = `${remote.baseUrl}\0${remote.pinnedIdentityFingerprint}`;
  const existing = entries.get(remote.remoteId);
  if (existing?.connectionKey === connectionKey) return existing.fetch;
  if (existing) void existing.fetch.close();
  const managed = createPairedRemoteFetch(remote, registry);
  entries.set(remote.remoteId, { connectionKey, fetch: managed });
  return managed;
}

/**
 * Drop the shared connection to one paired server, or to all of them. Every
 * caller is letting that connection go (unpairing, a moved or restarted
 * server, shutdown), so requests still in flight get
 * {@link PAIRED_FETCH_CLOSE_GRACE_MS} and are then aborted.
 */
export async function closePairedRemoteFetches(
  registry: RemotesRegistry,
  remoteId?: string,
  options: CloseFetchOptions = { graceMs: PAIRED_FETCH_CLOSE_GRACE_MS },
): Promise<void> {
  const entries = sharedFetches.get(registry);
  if (!entries) return;
  if (remoteId !== undefined) {
    const entry = entries.get(remoteId);
    entries.delete(remoteId);
    await entry?.fetch.close(options);
    return;
  }
  sharedFetches.delete(registry);
  await Promise.allSettled(Array.from(entries.values(), (entry) => entry.fetch.close(options)));
}

async function refreshPairedCertificate(
  remote: PairedRemote,
  registry: RemotesRegistry,
  createBootstrap: () => typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('remote certificate refresh timed out')),
    10_000,
  );
  timeout.unref?.();
  const bootstrap = createBootstrap();
  try {
    const response = await bootstrap(`${remote.baseUrl}/v1/identity`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`remote identity refresh returned HTTP ${response.status}`);
    const identity = IdentityResponseSchema.parse(await response.json());
    if (
      fingerprintOfPublicKeyPem(identity.publicKeyPem) !== remote.pinnedIdentityFingerprint ||
      identity.fingerprint !== remote.pinnedIdentityFingerprint ||
      !identity.tlsCertPem ||
      !identity.tlsCertFingerprint ||
      !identity.sig ||
      certFingerprintFromPem(identity.tlsCertPem) !== identity.tlsCertFingerprint ||
      !verifyIdentitySignature(remote.pinnedIdentityKey, identity.tlsCertFingerprint, identity.sig)
    ) {
      throw new Error('remote certificate refresh failed pinned-identity verification');
    }
    await registry.update(remote.remoteId, { tlsCertPem: identity.tlsCertPem });
    remote.tlsCertPem = identity.tlsCertPem;
    return identity.tlsCertPem;
  } finally {
    clearTimeout(timeout);
    await closeFetch(bootstrap);
  }
}
