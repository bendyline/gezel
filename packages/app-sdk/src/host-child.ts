import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  DaemonNotRunningError,
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
} from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import { childHostEnvironment, resolveNodePath } from './host-home.js';
import type { DaemonConnection, HostOptions } from './host-types.js';

/**
 * Start (or adopt) a Gezel daemon as a child process.
 *
 * This is the mode an Electron app wants. `hostInProcess` imports the service
 * into the caller, which means every native dependency the daemon loads —
 * `sqlite-vec`, `@napi-rs/keyring`, `@resvg/resvg-js` — has to be built for
 * that process's ABI. Under Electron that is not Node's, so an embedder would
 * have to rebuild the whole tree. Spawning under a real Node sidesteps it
 * entirely, and is what Gezel's own desktop shell does.
 *
 * Adoption is handled by `discoverOrSpawn`, which probes health before
 * adopting: a live pid with a wedged listener is not a daemon worth joining.
 */
export async function hostAsChild(
  appId: string,
  opts: HostOptions,
  fetchOverride?: typeof fetch,
): Promise<DaemonConnection> {
  const { home, env } = childHostEnvironment(appId, opts);
  await mkdir(home, { recursive: true });

  const daemonEntry = resolveDaemonEntry(opts);
  assertNodeRuns(env.GEZEL_NODE_PATH ?? resolveNodePath(opts));

  let resolved: Awaited<ReturnType<typeof discoverOrSpawn>>;
  try {
    resolved = await discoverOrSpawn({
      daemonEntry,
      // The daemon outlives the call that started it but not the app: a
      // detached child keeps serving if this process is merely busy, and the
      // returned `close` is what actually stops it.
      detached: true,
      env,
      home,
      spawnIfMissing: true,
      timeoutMs: opts.startTimeoutMs ?? 60_000,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  } catch (error) {
    if (error instanceof DaemonNotRunningError) {
      throw new GezelSdkError(
        `could not start a Gezel daemon from ${daemonEntry} — check that the service tree and the node binary shipped with this app are both present and executable`,
        { code: 'daemon_not_running', cause: error },
      );
    }
    throw error;
  }

  const fetchImpl =
    fetchOverride ??
    (resolved.cert ? createTrustingFetch({ cert: resolved.cert }) : globalThis.fetch);

  // `discoverOrSpawn` reports whether it started this daemon or joined one
  // that was already serving the home. Only a daemon we started is ours to
  // stop — a sibling window's daemon must keep running when we close.
  const ownsProcess = resolved.outcome !== 'adopted';
  let stopping: Promise<void> | undefined;

  return {
    mode: ownsProcess ? 'hosted-child' : 'hosted-adopted',
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    fetch: fetchImpl,
    client: new GezelClient({
      baseUrl: resolved.baseUrl,
      token: resolved.token,
      fetch: fetchImpl,
    }),
    home,
    pid: resolved.pid,
    cert: resolved.cert,
    close: () => {
      stopping ??= (async () => {
        if (!ownsProcess) return;
        try {
          process.kill(resolved.pid, 'SIGTERM');
        } catch {
          // Already gone. Nothing to stop, and nothing to report: a daemon
          // that exited before we asked is the outcome we wanted.
        }
      })();
      return stopping;
    },
  };
}

/**
 * Locate `gezeld`.
 *
 * Resolved by string rather than imported, because the daemon is a separate
 * program this SDK starts rather than a module it uses. The subpath is
 * deliberately exported by the service package for exactly this.
 */
function resolveDaemonEntry(opts: HostOptions): string {
  if (opts.daemonEntry) return opts.daemonEntry;
  try {
    return createRequire(import.meta.url).resolve('@bendyline/gezel-service/dist/bin/gezeld.js');
  } catch (cause) {
    throw new GezelSdkError(
      'hosting Gezel as a child needs @bendyline/gezel-service installed alongside this SDK (it is an optional peer dependency), or host.daemonEntry pointing at a gezeld entry this app ships',
      { code: 'service_not_installed', cause },
    );
  }
}

/**
 * Fail at a named place when the shipped Node cannot run.
 *
 * A packaging mistake — an unsigned binary, a missing execute bit, the wrong
 * architecture — otherwise surfaces as a spawn that never writes its runtime
 * files and a timeout minutes later that says nothing about the cause.
 */
function assertNodeRuns(nodePath: string): void {
  const probe = spawnSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.error || probe.status !== 0) {
    throw new GezelSdkError(
      `the node binary at ${nodePath} could not be run (${probe.error?.message ?? `exit ${String(probe.status)}`}) — under Electron this must be a real node this app ships, signed for this platform`,
      { code: 'node_binary_required', ...(probe.error ? { cause: probe.error } : {}) },
    );
  }
}
