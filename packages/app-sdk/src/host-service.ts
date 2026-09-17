import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GezelClient,
  createTrustingFetch,
  isProcessAlive,
  readRuntime,
  requestDaemonHealth,
} from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import { applyHostEnvironment, hostedGezelHome } from './host-home.js';
import type { DaemonConnection, HostOptions, HostServiceModule } from './host-types.js';

/**
 * One hosted daemon per process. The daemon reads its home and child-runtime
 * paths from `process.env`, so two hosted daemons in one process would be
 * reading each other's settings.
 */
let active = false;

/**
 * Start (or adopt) a Gezel daemon inside this process.
 *
 * Adoption comes first and matters more than it looks: a second window of the
 * same app, or a restart that outran the old process's shutdown, must join the
 * daemon that already owns this home rather than fail on its single-writer
 * lock.
 */
export async function hostInProcess(
  appId: string,
  opts: HostOptions,
  fetchOverride?: typeof fetch,
): Promise<DaemonConnection> {
  if (active) {
    throw new GezelSdkError(
      'this process already hosts a Gezel daemon; close that workshop before opening another',
      { code: 'host_already_active' },
    );
  }

  // Resolve the home WITHOUT touching the environment yet: adoption below may
  // return someone else's daemon, and applying (then restoring) the env around
  // that would leave this process's variables briefly wrong for no reason.
  const home = opts.home ?? hostedGezelHome(appId);
  await mkdir(home, { recursive: true });

  const adopted = await adoptSibling(home, fetchOverride);
  if (adopted) return adopted;

  const env = applyHostEnvironment(appId, { ...opts, home });
  active = true;
  try {
    const service = await loadService(opts);
    let running: Awaited<ReturnType<HostServiceModule['startService']>>;
    try {
      running = await service.startService({
        home,
        role: 'user',
        // Ephemeral: the canonical 6228 belongs to the user's own Gezel, and
        // an app that claimed it would answer for the whole machine.
        port: 0,
        preferCanonicalPort: false,
        ...(opts.onUnexpectedHttpError
          ? { onUnexpectedHttpError: opts.onUnexpectedHttpError }
          : {}),
      });
    } catch (err) {
      // Lost a race with another instance of this app between the adopt probe
      // and the lock. Its daemon is the right one to use.
      if (err instanceof Error && err.name === 'SingleInstanceError') {
        const sibling = await adoptSibling(home, fetchOverride);
        if (sibling) {
          active = false;
          env.restore();
          return sibling;
        }
      }
      throw err;
    }

    const cert = running.cert?.certPem ?? null;
    const baseUrl = `${cert ? 'https' : 'http'}://127.0.0.1:${running.port}`;
    const fetchImpl = fetchOverride ?? (cert ? createTrustingFetch({ cert }) : globalThis.fetch);
    let stopping: Promise<void> | undefined;
    return {
      mode: 'hosted',
      baseUrl,
      token: running.clientToken,
      fetch: fetchImpl,
      client: new GezelClient({ baseUrl, token: running.clientToken, fetch: fetchImpl }),
      home,
      pid: process.pid,
      cert,
      close: () => {
        stopping ??= (async () => {
          try {
            await running.stop();
            await clearOwnRuntime(home);
          } finally {
            active = false;
            env.restore();
          }
        })();
        return stopping;
      },
    };
  } catch (err) {
    active = false;
    env.restore();
    throw err;
  }
}

/**
 * Join a daemon already serving this home, if one is alive and answering.
 * Its `runtime/auth-token` is the same scoped client credential `startService`
 * would have returned here.
 */
async function adoptSibling(
  home: string,
  fetchOverride?: typeof fetch,
): Promise<DaemonConnection | null> {
  const runtime = await readRuntime(home).catch(() => null);
  if (!runtime || !isProcessAlive(runtime.pid)) return null;
  const fetchImpl =
    fetchOverride ??
    (runtime.cert ? createTrustingFetch({ cert: runtime.cert }) : globalThis.fetch);
  try {
    const health = await requestDaemonHealth(runtime.baseUrl, { fetch: fetchImpl });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  return {
    mode: 'hosted-adopted',
    baseUrl: runtime.baseUrl,
    token: runtime.token,
    fetch: fetchImpl,
    client: new GezelClient({
      baseUrl: runtime.baseUrl,
      token: runtime.token,
      fetch: fetchImpl,
    }),
    home,
    pid: runtime.pid,
    cert: runtime.cert,
    // Someone else's daemon: leave it running.
    close: async () => {},
  };
}

async function loadService(opts: HostOptions): Promise<HostServiceModule> {
  if (opts.serviceModule) return opts.serviceModule;
  try {
    return (await import(opts.serviceEntry ?? '@bendyline/gezel-service')) as HostServiceModule;
  } catch (cause) {
    throw new GezelSdkError(
      'hosting Gezel needs @bendyline/gezel-service installed alongside this SDK (it is an optional peer dependency), or host.serviceModule passed explicitly',
      { code: 'service_not_installed', cause },
    );
  }
}

/**
 * Remove the runtime files this process wrote — but only if they are still
 * ours. A daemon that started during our shutdown owns them now, and deleting
 * its discovery files would strand every client of it.
 */
async function clearOwnRuntime(home: string): Promise<void> {
  const runtimeDir = join(home, 'runtime');
  try {
    const pid = (await readFile(join(runtimeDir, 'pid'), 'utf8')).trim();
    if (pid !== String(process.pid)) return;
    await rm(runtimeDir, { recursive: true, force: true });
  } catch {
    /* nothing of ours to clean up */
  }
}

/** Test seam: forget that this process is hosting. */
export function resetHostStateForTest(): void {
  active = false;
}
