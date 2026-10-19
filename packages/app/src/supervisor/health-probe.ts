import {
  GezelClient,
  createTrustingFetch,
  isProcessAlive,
  readRuntime,
} from '@bendyline/gezel-client/node';

export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

// How long an adopted daemon that is alive but not yet answering /api/health
// gets to finish booting before we treat it as broken.
//
// The adopt probe was a single 5s attempt, which cannot tell a wedged daemon
// from one that is merely still starting — and right after an upgrade it is
// almost always the latter: the daemon re-extracts a ~32k-file service bundle
// and re-runs first-boot work, which takes minutes on a cold cache, not
// seconds. A v1.26219.45 Linux upgrade hit exactly that: launching the app
// immediately after install failed with "alive but unhealthy", and launching
// it again later simply worked, because by then the daemon had finished.
//
// Sized like MACHINE_SERVICE_STARTUP_WAIT_MS and for the same reason. Waiting
// costs a splash screen; being impatient costs the user their daemon.
export const ADOPT_HEALTH_WAIT_MS = 45_000;
const ADOPT_HEALTH_POLL_MS = 1_000;

export interface LocalAdoptRuntime {
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number;
}

type HealthResult = Awaited<ReturnType<GezelClient['health']>>;

/**
 * GezelClient wired with the trusting fetch when the daemon is serving
 * HTTPS — keeps the cert plumbing concentrated in one place so each
 * mode-branch reads identically.
 */
export function buildHealthClient(
  baseUrl: string,
  token: string,
  cert: string | null,
): GezelClient {
  if (cert) {
    return new GezelClient({ baseUrl, token, fetch: createTrustingFetch({ cert }) });
  }
  return new GezelClient({ baseUrl, token });
}

export class AdoptedDaemonHealthError extends Error {
  constructor(
    cause: unknown,
    readonly runtime: LocalAdoptRuntime,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AdoptedDaemonHealthError';
  }
}

export function sameLocalRuntime(a: LocalAdoptRuntime, b: LocalAdoptRuntime): boolean {
  return a.pid === b.pid && a.baseUrl === b.baseUrl && a.token === b.token && a.cert === b.cert;
}

/**
 * Health for a daemon we intend to adopt, with patience.
 *
 * A live process that is not yet answering is the normal state for the first
 * launch after an upgrade — the daemon is re-extracting its service bundle.
 * Poll until it answers or the budget runs out, so "unhealthy" means "had time
 * and still could not serve" rather than "was busy for five seconds".
 *
 * Gives up immediately once the process is gone: there is nothing to wait for,
 * and the caller's dead-pid path already recovers cleanly.
 */
export async function adoptedDaemonHealth(
  initialRuntime: LocalAdoptRuntime,
  opts: { home: string; logger?: { info?: (m: string) => void } },
  budgetMs: number = ADOPT_HEALTH_WAIT_MS,
  pollMs: number = ADOPT_HEALTH_POLL_MS,
  alive: (pid: number) => boolean = isProcessAlive,
  readCurrent: typeof readRuntime = readRuntime,
): Promise<{ health: HealthResult; runtime: LocalAdoptRuntime }> {
  const deadline = Date.now() + budgetMs;
  let announced = false;
  let runtime = initialRuntime;
  for (;;) {
    const client = buildHealthClient(runtime.baseUrl, runtime.token, runtime.cert);
    try {
      return { health: await healthWithTimeout(client), runtime };
    } catch (err) {
      // Runtime discovery is a set of independently replaced files. During a
      // restart the pid may already name the new daemon while token/cert still
      // describe the old one. Refresh after every failed probe so this wait can
      // converge on the generation that is actually serving.
      const refreshed = await readCurrent(opts.home);
      if (refreshed && alive(refreshed.pid) && !sameLocalRuntime(runtime, refreshed)) {
        opts.logger?.info?.(
          `[supervisor] adopted daemon runtime rotated while waiting; retrying pid=${refreshed.pid} with refreshed credentials`,
        );
        runtime = refreshed;
        if (Date.now() >= deadline) {
          try {
            const refreshedClient = buildHealthClient(runtime.baseUrl, runtime.token, runtime.cert);
            return { health: await healthWithTimeout(refreshedClient), runtime };
          } catch (refreshedErr) {
            throw new AdoptedDaemonHealthError(refreshedErr, runtime);
          }
        }
        continue;
      }
      if (!alive(runtime.pid)) throw new AdoptedDaemonHealthError(err, runtime);
      if (Date.now() >= deadline) throw new AdoptedDaemonHealthError(err, runtime);
      if (!announced) {
        announced = true;
        opts.logger?.info?.(
          `[supervisor] adopted daemon pid=${runtime.pid} is alive but not serving yet; waiting up to ${Math.round(
            budgetMs / 1000,
          )}s for it to finish starting`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * Health endpoints must be short-lived even though the shared TLS fetch is
 * intentionally patient for long-running model/tool requests. The explicit
 * rejection race also bounds injected fetches that fail to observe abort.
 */
export async function healthWithTimeout(
  client: Pick<GezelClient, 'health'>,
  timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  controller = new AbortController(),
): Promise<HealthResult> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error('Health check aborted'));
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error(`Health check timed out after ${timeoutMs}ms`));
        }
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    const requestHealth = client.health.bind(client) as (
      signal?: AbortSignal,
    ) => ReturnType<GezelClient['health']>;
    return await Promise.race([requestHealth(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function probeRemote(baseUrl: string, token: string): Promise<void> {
  const client = new GezelClient({ baseUrl, token });
  try {
    await healthWithTimeout(client);
  } catch (err) {
    throw new Error(
      `Configured remote gezel service at ${baseUrl} did not respond to /api/health: ${
        (err as Error).message
      }`,
    );
  }
}
