import { createLogger } from '@bendyline/gezel';
import {
  type SystemServiceRuntime,
  readSystemServiceRuntime,
  systemServiceHome,
} from '@bendyline/gezel-client/node';
import type { ChatManager } from '../chat/manager.js';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from '../remotes/identity.js';
import {
  closePairedRemoteFetches,
  createPinnedFetch,
  getPairedRemoteFetch,
} from '../remotes/pinned-fetch.js';
import type { PairedRemote, RemotesRegistry } from '../remotes/registry.js';

const log = createLogger('machine-engine');
const MACHINE_REMOTE_ID = 'this-machine';
const REFRESH_INTERVAL_MS = 5_000;

export interface MachineEngineBridge {
  isConnected(): boolean;
  isRequired(): boolean;
  proxy(request: Request, sourcePrefix: string, targetPrefix: string): Promise<Response>;
  stop(): Promise<void>;
}

/**
 * Adopt the installed machine engine as a runtime-only remote. The rotating
 * cross-account token is read from the protected service runtime directory
 * and kept in memory; it is never copied into the user's remotes.json.
 */
export async function startMachineEngineBridge(args: {
  home: string;
  /** Test/operator override; production uses the platform system-service home. */
  machineHome?: string;
  remotes: RemotesRegistry;
  chat: ChatManager;
  /** Service-level drain covering chat plus native media providers. */
  retireLocalEnginesForMachineBroker?: () => Promise<void>;
}): Promise<MachineEngineBridge | undefined> {
  const machineHome = args.machineHome ?? systemServiceHome();
  if (!machineHome || machineHome === args.home) return undefined;

  let current: PairedRemote | null = null;
  let machineOwnershipObserved = false;
  let healthy = false;
  let stopped = false;
  let refreshInFlight: Promise<void> | null = null;
  let retirementComplete = false;
  let retirementInFlight: Promise<void> | null = null;

  // Install routing before the first discovery pass. Once `current` is set,
  // every newly-started chat turn chooses the broker while old work drains.
  args.chat.setMachineEngineRemoteResolver(() => current?.remoteId ?? null);

  const retireLocalEngines = async (): Promise<void> => {
    if (retirementComplete) return;
    if (retirementInFlight) return retirementInFlight;
    const run = (
      args.retireLocalEnginesForMachineBroker?.() ?? args.chat.retireLocalEnginesForMachineBroker()
    )
      .then(() => {
        retirementComplete = true;
      })
      .finally(() => {
        if (retirementInFlight === run) retirementInFlight = null;
      });
    retirementInFlight = run;
    return run;
  };

  const refresh = async (): Promise<void> => {
    if (stopped || refreshInFlight) return refreshInFlight ?? Promise.resolve();
    refreshInFlight = (async () => {
      const runtime = await readSystemServiceRuntime(machineHome);
      if (!runtime) {
        // Runtime files disappear briefly while the broker restarts. Once it
        // has owned engines, keep the last verified connection as a required
        // (temporarily failing) route instead of spawning duplicate engines
        // in this user daemon.
        healthy = false;
        return;
      }
      if (runtime.serviceRole !== 'machine-engine') {
        if (current) {
          args.remotes.removeEphemeral(MACHINE_REMOTE_ID);
          await closePairedRemoteFetches(args.remotes, MACHINE_REMOTE_ID);
          current = null;
        }
        machineOwnershipObserved = false;
        healthy = false;
        return;
      }
      const remote = await inspectMachineRuntime(runtime);
      const changed =
        !current ||
        current.baseUrl !== remote.baseUrl ||
        current.token !== remote.token ||
        current.tlsCertPem !== remote.tlsCertPem ||
        current.pinnedIdentityFingerprint !== remote.pinnedIdentityFingerprint;
      args.remotes.setEphemeral(remote);
      current = remote;
      machineOwnershipObserved = true;
      healthy = true;
      if (!retirementComplete) {
        try {
          await retireLocalEngines();
        } catch (error) {
          // Keep the verified broker route authoritative, but retry the local
          // drain on the next discovery pass until the transaction completes.
          log.warn(
            `[machine-engine] local engine retirement failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (changed) {
        await closePairedRemoteFetches(args.remotes, MACHINE_REMOTE_ID);
        log.info(
          `[machine-engine] connected at ${remote.baseUrl} (identity ${remote.pinnedIdentityFingerprint.slice(0, 16)}…)`,
        );
      }
    })()
      .catch((error) => {
        // Once adopted, never fall back to a second local engine owner merely
        // because the broker is restarting. The existing remote stays in
        // place and its next request fails visibly until refresh succeeds.
        healthy = false;
        log.warn(
          `[machine-engine] discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  };

  await refresh();
  const timer = setInterval(() => {
    void refresh().catch((error) => {
      log.warn(
        `[machine-engine] refresh timer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  timer.unref();

  return {
    isConnected: () => healthy,
    // Once the user daemon has observed a machine broker, local native
    // inference must not silently reappear during a broker restart.
    isRequired: () => machineOwnershipObserved,
    async proxy(request, sourcePrefix, targetPrefix) {
      const remote = current;
      if (!remote) {
        return new Response(JSON.stringify({ error: 'machine_engine_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      const source = new URL(request.url);
      if (!source.pathname.startsWith(sourcePrefix)) {
        return new Response(JSON.stringify({ error: 'invalid_machine_proxy_path' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      const suffix = source.pathname.slice(sourcePrefix.length);
      const target = new URL(`${targetPrefix}${suffix}${source.search}`, remote.baseUrl);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      headers.set('authorization', `Bearer ${remote.token}`);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
      let response: Response;
      try {
        response = await getPairedRemoteFetch(remote, args.remotes)(target, {
          method: request.method,
          headers,
          ...(body ? { body, duplex: 'half' } : {}),
          signal: request.signal,
        } as RequestInit & { duplex?: 'half' });
      } catch (error) {
        healthy = false;
        log.warn(
          `[machine-engine] proxy failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new Response(JSON.stringify({ error: 'machine_engine_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      // Re-wrap the upstream fetch response. Fetch responses carry immutable
      // headers; Hono's outer HTTP/2 middleware removes hop-by-hop headers,
      // so returning the upstream object directly makes that cleanup throw.
      // The body remains streamed — model-download SSE is not buffered.
      return new Response(response.body as never, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await refreshInFlight?.catch(() => undefined);
      await retirementInFlight?.catch(() => undefined);
      args.chat.setMachineEngineRemoteResolver(undefined);
      args.remotes.removeEphemeral(MACHINE_REMOTE_ID);
      current = null;
      machineOwnershipObserved = false;
      healthy = false;
      await closePairedRemoteFetches(args.remotes, MACHINE_REMOTE_ID);
    },
  };
}

async function inspectMachineRuntime(runtime: SystemServiceRuntime): Promise<PairedRemote> {
  const fetchImpl = runtime.cert ? createPinnedFetch(runtime.cert) : fetch;
  try {
    const response = await fetchImpl(`${runtime.baseUrl}/v1/identity`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`identity returned HTTP ${response.status}`);
    const identity = IdentityResponseSchema.parse(await response.json());
    if (identity.serviceRole !== 'machine-engine') {
      throw new Error(`runtime advertised unexpected role ${identity.serviceRole ?? '(missing)'}`);
    }
    if (
      fingerprintOfPublicKeyPem(identity.publicKeyPem) !== identity.fingerprint ||
      !identity.tlsCertPem ||
      !identity.tlsCertFingerprint ||
      !identity.sig ||
      certFingerprintFromPem(identity.tlsCertPem) !== identity.tlsCertFingerprint ||
      !verifyIdentitySignature(identity.publicKeyPem, identity.tlsCertFingerprint, identity.sig)
    ) {
      throw new Error('machine identity or TLS signature verification failed');
    }
    if (runtime.cert && certFingerprintFromPem(runtime.cert) !== identity.tlsCertFingerprint) {
      throw new Error('machine runtime certificate does not match its signed identity response');
    }
    return {
      remoteId: MACHINE_REMOTE_ID,
      baseUrl: runtime.baseUrl,
      displayName: 'This machine',
      token: runtime.token,
      pinnedIdentityKey: identity.publicKeyPem,
      pinnedIdentityFingerprint: identity.fingerprint,
      tlsCertPem: identity.tlsCertPem,
      scopes: ['remote-inference', 'machine-models'],
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      managed: 'machine-engine',
    };
  } finally {
    const close = (fetchImpl as Partial<{ close(): Promise<void> }>).close;
    if (typeof close === 'function') {
      await close.call(fetchImpl);
    }
  }
}
