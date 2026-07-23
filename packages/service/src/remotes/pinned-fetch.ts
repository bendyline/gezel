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

import { Agent, fetch as undiciFetch } from 'undici';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from './identity.js';
import type { PairedRemote, RemotesRegistry } from './registry.js';

type UndiciUrl = Parameters<typeof undiciFetch>[0];
type UndiciInit = Parameters<typeof undiciFetch>[1];

export type ClosableFetch = typeof fetch & { close(): Promise<void> };

async function closeFetch(fetchImpl: typeof fetch | null | undefined): Promise<void> {
  const close = (fetchImpl as Partial<ClosableFetch> | null | undefined)?.close;
  if (typeof close === 'function') await close.call(fetchImpl);
}

/**
 * Pin a single self-signed cert as the sole CA and skip hostname/SAN
 * verification. Long-call-friendly (no header/body timeouts) for streamed
 * inference + large artifact downloads.
 */
export function createPinnedFetch(certPem: string): ClosableFetch {
  const dispatcher = new Agent({
    connect: {
      ca: certPem,
      rejectUnauthorized: true,
      // SAN matching is meaningless for a pinned loopback cert reached by LAN
      // IP; the cert identity itself is the pin, reinforced by the identity
      // signature verified at connect time.
      checkServerIdentity: () => undefined,
    },
    allowH2: true,
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const pinned = ((url: UndiciUrl, init?: UndiciInit) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as ClosableFetch;
  pinned.close = async () => {
    await dispatcher.close();
  };
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
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: false },
    allowH2: true,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const bootstrap = ((url: UndiciUrl, init?: UndiciInit) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as ClosableFetch;
  bootstrap.close = async () => {
    await dispatcher.close();
  };
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
      if (init?.signal?.aborted) throw originalError;
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
  paired.close = async () => {
    if (closed) return;
    closed = true;
    await refresh?.catch(() => undefined);
    const current = active;
    active = null;
    await closeFetch(current);
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

export async function closePairedRemoteFetches(
  registry: RemotesRegistry,
  remoteId?: string,
): Promise<void> {
  const entries = sharedFetches.get(registry);
  if (!entries) return;
  if (remoteId !== undefined) {
    const entry = entries.get(remoteId);
    entries.delete(remoteId);
    await entry?.fetch.close();
    return;
  }
  sharedFetches.delete(registry);
  await Promise.allSettled(Array.from(entries.values(), (entry) => entry.fetch.close()));
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
