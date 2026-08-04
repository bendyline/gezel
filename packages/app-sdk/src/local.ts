import { readFile } from 'node:fs/promises';
import {
  DaemonNotRunningError,
  createTrustingFetch,
  discoverOrSpawn,
  readSystemServiceEndpoint,
} from '@bendyline/gezel-client/node';
import { GezelApp } from './client.js';
import { authorize } from './connect.js';
import { readRuntimeForConnect } from './detect.js';
import { GezelSdkError } from './errors.js';
import type {
  LocalAuthorizedConnection,
  LocalConnectInput,
  LocalOwnerConnectInput,
} from './types.js';

/**
 * Resolve the logged-in user's daemon and complete app consent in one call.
 *
 * Default third-party behavior is discovery-only: runtime files under the
 * user's Gezel home provide the dynamic port and pinned certificate. Native
 * first-party/reference clients may additionally provide a bundled
 * `daemonEntry` and opt into `spawnIfMissing`. Every SDK-owned spawn is
 * explicitly a user-role daemon on an ephemeral port, so it can never race
 * the machine engine broker for port 6228.
 */
export async function authorizeLocal(input: LocalConnectInput): Promise<LocalAuthorizedConnection> {
  const { daemon, tlsCertPath, ...connectInput } = input;

  if (connectInput.baseUrl) {
    const configured = await configuredTransport(
      connectInput.baseUrl,
      connectInput.fetch,
      tlsCertPath,
    );
    const authorized = await authorize({
      ...connectInput,
      fetch: configured.fetch,
    });
    return {
      ...authorized,
      daemon: { mode: 'configured', cert: configured.cert },
    };
  }

  const legacyFull = await discoverLegacyFullService(daemon?.home, connectInput.fetch);
  if (legacyFull) {
    const authorized = await authorize({
      ...connectInput,
      baseUrl: legacyFull.baseUrl,
      fetch: legacyFull.fetch,
    });
    return {
      ...authorized,
      daemon: { mode: 'legacy-full', cert: legacyFull.cert },
    };
  }

  if (!daemon?.daemonEntry) {
    if (daemon?.spawnIfMissing) {
      throw new GezelSdkError(
        'spawnIfMissing requires daemonEntry; ordinary third-party apps should ask the user to start Gezel',
        { code: 'daemon_entry_required' },
      );
    }
    const discovered = await readRuntimeForConnect(daemon?.home);
    if (!discovered) throw daemonNotRunning();
    await probeHealth(discovered.baseUrl, discovered.fetch);
    const authorized = await authorize({
      ...connectInput,
      baseUrl: discovered.baseUrl,
      fetch: connectInput.fetch ?? discovered.fetch,
    });
    return {
      ...authorized,
      daemon: { mode: 'adopted', cert: discovered.cert },
    };
  }

  let resolved: Awaited<ReturnType<typeof discoverOrSpawn>>;
  try {
    resolved = await discoverOrSpawn({
      daemonEntry: daemon.daemonEntry,
      detached: true,
      env: userDaemonEnv(daemon.home),
      home: daemon.home,
      spawnIfMissing: daemon.spawnIfMissing ?? false,
      timeoutMs: daemon.timeoutMs ?? 20_000,
      logger: daemon.logger,
    });
  } catch (error) {
    if (error instanceof DaemonNotRunningError) throw daemonNotRunning();
    throw error;
  }

  const fetchImpl = resolved.cert
    ? createTrustingFetch({ cert: resolved.cert })
    : (globalThis.fetch as typeof fetch);
  const authorized = await authorize({
    ...connectInput,
    baseUrl: resolved.baseUrl,
    fetch: connectInput.fetch ?? fetchImpl,
  });
  return {
    ...authorized,
    daemon: {
      mode: resolved.outcome,
      pid: resolved.pid,
      cert: resolved.cert,
    },
  };
}

/**
 * Rolling-upgrade compatibility: a pre-split machine service still owns the
 * product data until migration completes. Probe it before the per-user ladder
 * so every SDK client sees the same projects as Electron during that window.
 */
async function discoverLegacyFullService(
  explicitHome: string | undefined,
  fetchOverride: typeof fetch | undefined,
): Promise<{ baseUrl: string; cert: string | null; fetch: typeof fetch } | null> {
  if (explicitHome || process.env.GEZEL_HOME || process.env.GEZEL_DEV === '1') return null;
  let endpoint: Awaited<ReturnType<typeof readSystemServiceEndpoint>> = null;
  try {
    endpoint = await readSystemServiceEndpoint();
  } catch {
    endpoint = null;
  }
  if (!endpoint) return null;
  const fetchImpl =
    fetchOverride ??
    (endpoint.cert
      ? createTrustingFetch({ cert: endpoint.cert })
      : (globalThis.fetch as typeof fetch));
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}/api/health`);
    if (!response.ok) return null;
    const health = (await response.json()) as { serviceRole?: string };
    if (health.serviceRole !== undefined && health.serviceRole !== 'legacy-full') return null;
    return { baseUrl: endpoint.baseUrl, cert: endpoint.cert, fetch: fetchImpl };
  } catch {
    return null;
  }
}

/**
 * Connect a first-party client running as the same OS user that owns the
 * product daemon. This deliberately skips Connected Apps consent: the
 * rotating credential comes from the user's protected runtime directory and
 * is the same scoped `ui` credential used by the desktop shell. External apps
 * must use {@link authorizeLocal} instead.
 */
export async function authorizeLocalOwner(
  input: LocalOwnerConnectInput,
): Promise<LocalAuthorizedConnection> {
  let resolved: Awaited<ReturnType<typeof discoverOrSpawn>>;
  try {
    resolved = await discoverOrSpawn({
      daemonEntry: input.daemon.daemonEntry,
      detached: true,
      env: userDaemonEnv(input.daemon.home),
      home: input.daemon.home,
      spawnIfMissing: input.daemon.spawnIfMissing ?? false,
      timeoutMs: input.daemon.timeoutMs ?? 20_000,
      logger: input.daemon.logger,
    });
  } catch (error) {
    if (error instanceof DaemonNotRunningError) throw daemonNotRunning();
    throw error;
  }
  const fetchImpl =
    input.fetch ??
    (resolved.cert
      ? createTrustingFetch({ cert: resolved.cert })
      : (globalThis.fetch as typeof fetch));
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    fetch: fetchImpl,
    daemon: {
      mode: resolved.outcome,
      pid: resolved.pid,
      cert: resolved.cert,
    },
  };
}

async function configuredTransport(
  baseUrl: string,
  fetchOverride: typeof fetch | undefined,
  tlsCertPath: string | undefined,
): Promise<{ fetch: typeof fetch; cert: string | null }> {
  if (fetchOverride) return { fetch: fetchOverride, cert: null };
  if (!baseUrl.startsWith('https://') || !tlsCertPath) {
    return { fetch: globalThis.fetch as typeof fetch, cert: null };
  }
  try {
    const cert = await readFile(tlsCertPath, 'utf8');
    return { fetch: createTrustingFetch({ cert }), cert };
  } catch (cause) {
    throw new GezelSdkError('could not read the configured Gezel TLS certificate', {
      code: 'tls_cert_unreadable',
      cause,
    });
  }
}

/** OpenAI-shaped convenience wrapper over {@link authorizeLocal}. */
export async function connectLocal(
  input: LocalConnectInput,
): Promise<{ app: GezelApp; authorization: LocalAuthorizedConnection }> {
  const authorization = await authorizeLocal(input);
  return {
    app: new GezelApp(authorization),
    authorization,
  };
}

function userDaemonEnv(home: string | undefined): NodeJS.ProcessEnv {
  // System-scope and named-port values can leak in from a service host or a
  // developer shell. They are never valid for an SDK-started product daemon.
  const {
    GEZEL_PORT: _inheritedPort,
    GEZEL_SERVICE_ROLE: _inheritedRole,
    GEZEL_SYSTEM_SCOPE: _inheritedSystemScope,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    ...(home ? { GEZEL_HOME: home } : {}),
    GEZEL_PORT: '0',
    GEZEL_SERVICE_ROLE: 'user',
  };
}

async function probeHealth(baseUrl: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (cause) {
    throw new GezelSdkError('gezel daemon is not responding', {
      code: 'daemon_not_running',
      cause,
    });
  }
}

function daemonNotRunning(): GezelSdkError {
  return new GezelSdkError('gezel daemon not found — start the Gezel desktop app and try again', {
    code: 'daemon_not_running',
  });
}
