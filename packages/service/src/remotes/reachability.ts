/**
 * Whether each paired server can be reached right now, and following one to a
 * new address when it moved.
 *
 * Paired servers come and go: a laptop leaves the house, a desktop sleeps,
 * DHCP hands the server a new address. Nothing used to notice, so every call
 * paid a connect timeout plus a certificate-refresh attempt and failed with
 * "fetch failed". The tracker keeps one status per server, fed by the real
 * requests the remote provider makes and by short probes:
 *
 * - `online` — the last contact succeeded.
 * - `offline` — the last contact could not reach the server at all.
 * - `unknown` — not contacted since this process started.
 *
 * Only a failure to *reach* the server counts as offline. A server that
 * answers with an error is up, and that error reaches the caller unchanged.
 *
 * Probes run only when someone is about to use a server ({@link check}) and
 * are throttled, so an idle install never polls the network. When a probe
 * cannot connect, discovery is asked whether the same identity is announcing
 * itself somewhere else; a new address is adopted only after it proves the
 * pinned identity (see {@link relocateRemote}).
 */

import { createLogger } from '@bendyline/gezel';
import { fingerprintOfPublicKeyPem } from '@bendyline/gezel-inference/internal/remotes/identity';
import {
  closePairedRemoteFetches,
  createPinnedFetch,
  getPairedRemoteFetch,
} from '@bendyline/gezel-inference/internal/remotes/pinned-fetch';
import type { LanBrowser } from './lan-discovery.js';
import { inspectRemoteIdentity, normalizeRemoteBaseUrl, remoteBaseUrlMatches } from './pairing.js';
import type { PairedRemote, RemotesRegistry } from './registry.js';
import { isRemoteUnreachableError } from './unreachable.js';

export { RemoteUnreachableError, isRemoteUnreachableError } from './unreachable.js';

const log = createLogger('remote-reachability');

export type RemoteStatus = 'online' | 'offline' | 'unknown';

export interface RemoteReachabilitySnapshot {
  status: RemoteStatus;
  lastOkAt?: number;
  lastFailAt?: number;
}

export interface RemoteReachability {
  /** The last known status, without touching the network. */
  status(remoteId: string): RemoteStatus;
  snapshot(remoteId: string): RemoteReachabilitySnapshot;
  /** A request reached the server. */
  reportReachable(remoteId: string): void;
  /** A request could not reach the server. */
  reportUnreachable(remoteId: string): void;
  /**
   * The status to act on before using a server: answers from memory while it
   * is fresh, otherwise probes it (and looks for it at a new address) first.
   */
  check(remoteId: string, opts?: { maxAgeMs?: number }): Promise<RemoteStatus>;
  /**
   * Discovery saw this identity announcing itself at `baseUrl`. Adopts the
   * address when the server moved and proves the pinned identity there.
   */
  noteSighting(fingerprint: string, baseUrl: string): void;
}

/** How long a successful contact keeps a server `online` without a probe. */
export const REMOTE_FRESH_MS = 60_000;
/** How long an `offline` verdict stands before the next probe. */
export const REMOTE_OFFLINE_RECHECK_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;

interface Entry {
  status: RemoteStatus;
  lastOkAt?: number;
  lastFailAt?: number;
  lastCheckAt?: number;
}

/**
 * Adopt a new address for a paired server: only when discovery reports its
 * fingerprint somewhere else AND the server there proves it holds the pinned
 * identity key (its `/v1/identity` signs its TLS certificate with that key)
 * AND that certificate's key (a channel pinned to it completes a request). A
 * device announcing someone else's fingerprint can't produce the signature,
 * and one replaying the real server's signed identity can't complete the
 * handshake, so the worst either can do is waste one probe.
 */
export async function relocateRemote(
  remote: PairedRemote,
  deps: {
    registry: RemotesRegistry;
    browser: LanBrowser | null;
    candidate?: string;
    inspect?: typeof inspectRemoteIdentity;
    /** Reach `baseUrl` over a channel pinned to `tlsCertPem`; throws when it can't. */
    confirm?: (baseUrl: string, tlsCertPem: string) => Promise<void>;
  },
): Promise<string | null> {
  let candidate = deps.candidate;
  if (!candidate) {
    if (!deps.browser) return null;
    const found = (await deps.browser.browse({ waitMs: 1_200 })).find(
      (server) => server.fingerprint === remote.pinnedIdentityFingerprint,
    );
    candidate = found?.baseUrl;
  }
  if (!candidate || remoteBaseUrlMatches(remote.baseUrl, candidate)) return null;
  const baseUrl = normalizeRemoteBaseUrl(candidate);
  const identity = await (deps.inspect ?? inspectRemoteIdentity)(baseUrl);
  if (
    identity.fingerprint !== remote.pinnedIdentityFingerprint ||
    fingerprintOfPublicKeyPem(identity.publicKeyPem) !== remote.pinnedIdentityFingerprint ||
    !identity.tlsCertPem
  ) {
    return null;
  }
  try {
    await (deps.confirm ?? confirmPinnedIdentity)(baseUrl, identity.tlsCertPem);
  } catch {
    return null;
  }
  await deps.registry.update(remote.remoteId, { baseUrl, tlsCertPem: identity.tlsCertPem });
  await closePairedRemoteFetches(deps.registry, remote.remoteId);
  log.info(
    `[remote-reachability] ${remote.displayName} moved from ${remote.baseUrl} to ${baseUrl}; following it`,
  );
  return baseUrl;
}

/** A signed identity can be replayed; only a server holding its certificate's key gets this far. */
async function confirmPinnedIdentity(baseUrl: string, tlsCertPem: string): Promise<void> {
  const fetchImpl = createPinnedFetch(tlsCertPem);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/identity`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
  } finally {
    await fetchImpl.close().catch(() => {});
  }
}

/** One unauthenticated round trip over the pinned channel. */
async function defaultProbe(
  remote: PairedRemote,
  registry: RemotesRegistry,
  timeoutMs: number,
): Promise<void> {
  const fetchImpl = getPairedRemoteFetch(remote, registry);
  const response = await fetchImpl(`${remote.baseUrl}/v1/identity`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel().catch(() => {});
}

export function createRemoteReachability(opts: {
  registry: RemotesRegistry;
  browser?: LanBrowser | null;
  probe?: (remote: PairedRemote) => Promise<void>;
  relocate?: (remote: PairedRemote, candidate?: string) => Promise<string | null>;
  now?: () => number;
}): RemoteReachability {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<RemoteStatus>>();
  const relocating = new Set<string>();
  const probe =
    opts.probe ?? ((remote: PairedRemote) => defaultProbe(remote, opts.registry, PROBE_TIMEOUT_MS));
  const relocate =
    opts.relocate ??
    ((remote: PairedRemote, candidate?: string) =>
      relocateRemote(remote, {
        registry: opts.registry,
        browser: opts.browser ?? null,
        ...(candidate ? { candidate } : {}),
      }));

  const entry = (remoteId: string): Entry => {
    let e = entries.get(remoteId);
    if (!e) {
      e = { status: 'unknown' };
      entries.set(remoteId, e);
    }
    return e;
  };

  const reportReachable = (remoteId: string) => {
    const e = entry(remoteId);
    const t = now();
    if (e.status === 'offline') {
      log.info(`[remote-reachability] ${remoteId.slice(0, 16)}… is reachable again`);
    }
    e.status = 'online';
    e.lastOkAt = t;
    e.lastCheckAt = t;
    opts.registry.touch(remoteId);
  };

  const reportUnreachable = (remoteId: string) => {
    const e = entry(remoteId);
    const t = now();
    if (e.status !== 'offline') {
      log.info(`[remote-reachability] ${remoteId.slice(0, 16)}… is not reachable`);
    }
    e.status = 'offline';
    e.lastFailAt = t;
    e.lastCheckAt = t;
  };

  const runProbe = async (remote: PairedRemote): Promise<RemoteStatus> => {
    try {
      await probe(remote);
      reportReachable(remote.remoteId);
      return 'online';
    } catch (err) {
      if (!isRemoteUnreachableError(err) && !(err instanceof DOMException)) {
        // It answered, just not happily (an error status, a refused
        // certificate). That is reachable; the real request will report the
        // real problem.
        reportReachable(remote.remoteId);
        return 'online';
      }
    }
    try {
      if (await relocate(remote)) {
        const moved = opts.registry.get(remote.remoteId);
        if (moved) {
          await probe(moved);
          reportReachable(remote.remoteId);
          return 'online';
        }
      }
    } catch (err) {
      log.debug(`[remote-reachability] relocation of ${remote.displayName} failed: ${String(err)}`);
    }
    reportUnreachable(remote.remoteId);
    return 'offline';
  };

  return {
    status: (remoteId) => entries.get(remoteId)?.status ?? 'unknown',
    snapshot: (remoteId) => {
      const e = entries.get(remoteId);
      return e
        ? {
            status: e.status,
            ...(e.lastOkAt ? { lastOkAt: e.lastOkAt } : {}),
            ...(e.lastFailAt ? { lastFailAt: e.lastFailAt } : {}),
          }
        : { status: 'unknown' };
    },
    reportReachable,
    reportUnreachable,
    async check(remoteId, checkOpts = {}) {
      const remote = opts.registry.get(remoteId);
      if (!remote) return 'offline';
      // This computer's own machine engine is not a LAN peer that wanders off.
      if (remote.managed) return 'online';
      const e = entry(remoteId);
      const t = now();
      const maxAgeMs = checkOpts.maxAgeMs ?? REMOTE_FRESH_MS;
      if (e.status === 'online' && e.lastOkAt !== undefined && t - e.lastOkAt < maxAgeMs) {
        return 'online';
      }
      if (
        e.status === 'offline' &&
        e.lastCheckAt !== undefined &&
        t - e.lastCheckAt < REMOTE_OFFLINE_RECHECK_MS
      ) {
        return 'offline';
      }
      const pending = inflight.get(remoteId);
      if (pending) return pending;
      const run = runProbe(remote).finally(() => inflight.delete(remoteId));
      inflight.set(remoteId, run);
      return run;
    },
    noteSighting(fingerprint, baseUrl) {
      const remote = opts.registry.list().find((r) => r.pinnedIdentityFingerprint === fingerprint);
      if (!remote || remote.managed || relocating.has(remote.remoteId)) return;
      if (remoteBaseUrlMatches(remote.baseUrl, baseUrl)) return;
      relocating.add(remote.remoteId);
      void relocate(remote, baseUrl)
        .then((moved) => {
          if (moved) reportReachable(remote.remoteId);
        })
        .catch((err) =>
          log.debug(`[remote-reachability] could not follow ${remote.displayName}: ${String(err)}`),
        )
        .finally(() => relocating.delete(remote.remoteId));
    },
  };
}
