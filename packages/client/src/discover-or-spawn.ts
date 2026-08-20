import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import { GezelClient } from './client.js';
import {
  type RuntimeInfo,
  isProcessAlive as defaultIsProcessAlive,
  readRuntime as defaultReadRuntime,
} from './discovery.js';
import { createTrustingFetch } from './node-tls.js';
import { terminateWindowsProcessTree } from './processes.js';

export type DiscoverOrSpawnOutcome = 'adopted' | 'spawned';

export class LiveDaemonUnhealthyError extends Error {
  constructor(
    public readonly pid: number,
    public readonly baseUrl: string,
    options?: ErrorOptions,
  ) {
    super(
      `gezeld pid=${pid} is alive but did not pass its health check at ${baseUrl}; refusing to spawn another daemon for the same home`,
      options,
    );
    this.name = 'LiveDaemonUnhealthyError';
  }
}

export class DaemonNotRunningError extends Error {
  constructor() {
    super('no running gezel daemon was found for this user');
    this.name = 'DaemonNotRunningError';
  }
}

export interface DiscoverOrSpawnResult {
  client: GezelClient;
  baseUrl: string;
  token: string;
  pid: number;
  /**
   * The daemon's TLS cert PEM, when it's serving HTTPS. `null` when the
   * daemon is on HTTP/1.1 (legacy / `GEZEL_INSECURE_TRANSPORT=1`). Callers
   * that need their own client (separate from the one returned in `client`)
   * can use this with `createTrustingFetch` to talk to the daemon.
   */
  cert: string | null;
  outcome: DiscoverOrSpawnOutcome;
  /** Child handle — set only when we spawned and `detached` was false. */
  child?: ChildProcess;
}

/**
 * Minimal spawn surface — just enough for the CLI's detached "fire-and-forget"
 * spawn plus the supervisor's attached "I own this child" spawn. Exposed as
 * an option so tests can inject a fake without hijacking `child_process`.
 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: 'ignore' | 'pipe' | 'inherit';
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  },
) => ChildProcess;

export interface DiscoverOrSpawnOptions {
  /** Path to a file that, when run with `node`, starts `gezeld`. */
  daemonEntry: string;
  /**
   * Fire-and-forget (CLI) vs attached (supervisor). When `false`, the returned
   * `child` is the live handle the caller must manage; when `true`, we
   * `unref()` it and don't return a handle.
   */
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Stdio mode for the spawned child. Defaults to `'ignore'` when detached
   * (the CLI fire-and-forget case) or `'pipe'` when attached (the
   * supervisor case). Override with `'inherit'` to wire the child's output
   * to the caller's terminal — useful for `gezel start --foreground`.
   */
  stdio?: 'ignore' | 'pipe' | 'inherit';
  /** Max total time to wait for the daemon to come up. Default 5000 ms. */
  timeoutMs?: number;
  /**
   * Maximum time for one `/api/health` request. Defaults to the smaller of
   * 1000 ms and `timeoutMs`. A health request is part of the overall startup
   * deadline; it can never extend that deadline.
   */
  healthTimeoutMs?: number;
  /** Poll interval for runtime-file + health check. Default 100 ms. */
  pollIntervalMs?: number;
  /**
   * Skip the "adopt a running daemon" check and always spawn a fresh one.
   * Used by `gezel start --port` / `--web`, which need a daemon launched
   * with specific flags rather than whatever happens to be running.
   *
   * Note: do NOT force this by overriding `readRuntimeFn` to return null —
   * the readiness poll below uses the same function, so a null override
   * would blind the poll and time out while the daemon is actually coming
   * up. `forceSpawn` skips only the adopt check and leaves the poll intact.
   */
  forceSpawn?: boolean;
  /** `GEZEL_HOME` — forwarded to `readRuntime` for per-test isolation. */
  home?: string;
  /**
   * Whether discovery may start a daemon when this user's runtime is absent
   * or stale. Defaults to `true` for the historical first-party behavior.
   * Public app integrations set this to `false` unless they deliberately ship
   * a compatible daemon entry of their own.
   */
  spawnIfMissing?: boolean;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  // Test-only injection points. Defaults wire to the real implementations.
  spawnFn?: SpawnLike;
  readRuntimeFn?: (home?: string) => Promise<RuntimeInfo | null>;
  isProcessAliveFn?: (pid: number) => boolean;
  /**
   * Override the client factory for tests — lets us assert health() behavior.
   * The factory now receives the daemon's `cert` (when present) so it can
   * build a trust-anchored fetch. Production default builds the trust path
   * automatically; tests typically ignore it.
   */
  clientFactory?: (opts: { baseUrl: string; token: string; cert: string | null }) => GezelClient;
}

/**
 * Either adopt an already-running gezeld (if the runtime files point at a
 * live process) or spawn a fresh one and wait for it to bind its port and
 * write its runtime files.
 *
 * Factored out of the CLI's `ensureDaemon` so the Electron supervisor can
 * share the same adopt/spawn/health-wait logic without duplicating the
 * polling loop.
 */
export async function discoverOrSpawn(
  opts: DiscoverOrSpawnOptions,
): Promise<DiscoverOrSpawnResult> {
  const {
    daemonEntry,
    detached = true,
    env,
    stdio = detached ? 'ignore' : 'pipe',
    timeoutMs = 5000,
    pollIntervalMs = 100,
    healthTimeoutMs = Math.min(1000, timeoutMs),
    forceSpawn = false,
    home,
    spawnIfMissing = true,
    logger,
    spawnFn = nodeSpawn,
    readRuntimeFn = defaultReadRuntime,
    isProcessAliveFn = defaultIsProcessAlive,
    clientFactory = defaultClientFactory,
  } = opts;

  const deadline = Date.now() + timeoutMs;

  const existing = forceSpawn ? null : await readRuntimeFn(home);
  if (existing && isProcessAliveFn(existing.pid)) {
    const client = clientFactory({
      baseUrl: existing.baseUrl,
      token: existing.token,
      cert: existing.cert,
    });
    // A live pid alone isn't enough to adopt — a daemon mid-shutdown, with a
    // crashed listener, or wedged event loop still has a live pid but won't
    // answer. Adopting it would hand the caller a baseUrl that refuses
    // connections (the ERR_CONNECTION_REFUSED / green-window failure). Probe
    // health first; only adopt if it actually responds, otherwise fall
    // through and spawn a fresh one.
    try {
      await boundedHealth(client, Math.min(healthTimeoutMs, remainingMs(deadline)));
      logger?.info?.(`[gezel] adopting existing daemon pid=${existing.pid}`);
      return {
        client,
        baseUrl: existing.baseUrl,
        token: existing.token,
        cert: existing.cert,
        pid: existing.pid,
        outcome: 'adopted',
      };
    } catch (err) {
      // A live-but-unhealthy pid is not proof that the process no longer owns
      // this home. Spawning beside it would violate the single-writer
      // invariant. The caller may explicitly stop/repair that daemon, but
      // discovery must fail loudly rather than manufacture a second writer.
      throw new LiveDaemonUnhealthyError(existing.pid, existing.baseUrl, { cause: err });
    }
  }

  if (!spawnIfMissing) {
    throw new DaemonNotRunningError();
  }

  logger?.info?.(`[gezel] spawning daemon from ${daemonEntry}`);
  const child = spawnFn(process.execPath, [daemonEntry], {
    detached,
    stdio,
    env: daemonSpawnEnv(env ?? process.env, {
      shutdownOnStdinEof: !detached && stdio === 'pipe',
    }),
    // A detached Windows child gets its own console by default. The CLI uses
    // detachment so a background daemon can outlive it, but that must not
    // surface a blank terminal window. Attached Electron-owned daemons are
    // hidden for the same reason.
    ...windowsHeadlessSpawnOptions(),
  });
  if (detached) child.unref();

  while (Date.now() < deadline) {
    await wait(Math.min(pollIntervalMs, remainingMs(deadline)));
    const runtime = await readRuntimeFn(home);
    if (runtime && isProcessAliveFn(runtime.pid)) {
      const client = clientFactory({
        baseUrl: runtime.baseUrl,
        token: runtime.token,
        cert: runtime.cert,
      });
      try {
        await boundedHealth(client, Math.min(healthTimeoutMs, remainingMs(deadline)));
        return {
          client,
          baseUrl: runtime.baseUrl,
          token: runtime.token,
          cert: runtime.cert,
          pid: runtime.pid,
          outcome: 'spawned',
          child: detached ? undefined : child,
        };
      } catch {
        // Keep polling — the server may not have bound yet.
      }
    }
  }

  await terminateFailedSpawn(child, logger);
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for gezeld to start. Check ~/.gezel/logs/.`,
  );
}

/**
 * Environment for the spawned daemon.
 *
 * We launch `process.execPath`, and under Electron that is the *app* binary,
 * not node. Without `ELECTRON_RUN_AS_NODE` Electron ignores the script
 * argument and boots a second copy of Gezel, which never writes runtime files
 * — so the caller waits out its entire startup budget, kills the child, and
 * falls back to embedded. Worse, that second app reaches this same branch and
 * spawns a third, leaving orphans behind when the parent gives up. Electron
 * reads the variable at launch, so it has to be in the child's environment;
 * there is no command-line equivalent.
 *
 * `ELECTRON_RUN_AS_NODE` is keyed off `process.versions.electron`; the stdin
 * EOF contract is keyed off an attached spawn with a dedicated pipe. Detached
 * daemons and foreground/inherited-stdio daemons must not treat the caller's
 * terminal EOF as an ownership signal.
 *
 * Always use a fresh object when adding either flag: `env` is usually
 * `process.env` itself, and mutating that would leak ownership semantics into
 * later detached/foreground spawns.
 *
 * The macOS LaunchDaemon sets exactly this for the installed service, so the
 * daemon and its own children are already proven to run under it.
 */
function daemonSpawnEnv(
  env: NodeJS.ProcessEnv,
  options: { shutdownOnStdinEof: boolean },
): NodeJS.ProcessEnv {
  if (!process.versions.electron && !options.shutdownOnStdinEof) return env;
  return {
    ...env,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(options.shutdownOnStdinEof ? { GEZEL_SHUTDOWN_ON_STDIN_EOF: '1' } : {}),
  };
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/**
 * Bound a health request even when an injected/custom fetch ignores abort.
 * The abort still matters for real fetch implementations (it closes the
 * socket); the explicit rejection race is what makes the wall-clock contract
 * deterministic for every implementation.
 */
async function boundedHealth(client: GezelClient, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error('Health check aborted'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => {
        controller.abort(new Error(`Health check timed out after ${timeoutMs}ms`));
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    await Promise.race([client.health(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

async function terminateFailedSpawn(
  child: ChildProcess,
  logger?: DiscoverOrSpawnOptions['logger'],
): Promise<void> {
  logger?.warn?.('[gezel] daemon startup timed out; terminating the spawned child');
  await stopOwnedDaemon(child, logger, { graceMs: 250, forceMs: 250 });
}

export interface StopOwnedDaemonOptions {
  /** Time allowed for stdin EOF (or POSIX SIGTERM) cleanup. Defaults to 3 seconds. */
  graceMs?: number;
  /** Time allowed for the hard-stop fallback to become observable. */
  forceMs?: number;
  platform?: NodeJS.Platform;
  /** Test seam for Windows process-tree termination. */
  terminateWindowsTree?: (pid: number) => Promise<void>;
}

/**
 * Stop a daemon spawned in attached `stdio: 'pipe'` mode.
 *
 * Closing stdin is the primary channel on every platform. In particular,
 * Windows maps Node's SIGTERM to abrupt TerminateProcess, so a signal cannot
 * run `gezeld`'s shutdown hooks. The spawn path opts the child into stdin EOF
 * shutdown, and the OS also closes the same pipe if the owning Electron/eval
 * process dies unexpectedly. If graceful shutdown stalls, Windows uses
 * `taskkill /T /F` so the daemon and native-engine descendants are contained;
 * POSIX retains the SIGTERM -> SIGKILL ladder.
 */
export async function stopOwnedDaemon(
  child: ChildProcess | undefined,
  logger?: DiscoverOrSpawnOptions['logger'],
  options: StopOwnedDaemonOptions = {},
): Promise<void> {
  if (!child) return;
  if (childHasExited(child)) {
    logger?.info?.(`[gezel] owned daemon already exited; ${childStopState(child)}`);
    return;
  }
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 3_000;
  const forceMs = options.forceMs ?? 3_000;
  let requestedGraceful = false;
  let gracefulExit: Promise<boolean> | undefined;
  let gracefulChannel = 'none';

  logger?.info?.(
    `[gezel] stopping owned daemon platform=${platform} graceMs=${graceMs} forceMs=${forceMs}; ${childStopState(child)}`,
  );

  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
    try {
      // Register before end(): a test double or very small child can report
      // exit synchronously from the EOF request.
      gracefulExit = waitForExit(child, graceMs);
      child.stdin.end();
      requestedGraceful = true;
      gracefulChannel = 'stdin-EOF';
      logger?.info?.(
        `[gezel] requested graceful daemon shutdown through stdin EOF; ${childStopState(child)}`,
      );
    } catch (error) {
      logger?.warn?.(
        `[gezel] stdin EOF shutdown request failed: ${stopErrorMessage(error)}; ${childStopState(child)}`,
      );
      // Fall through to the platform hard-stop ladder.
    }
  }

  if (!requestedGraceful && platform !== 'win32') {
    try {
      gracefulExit = waitForExit(child, graceMs);
      const accepted = child.kill('SIGTERM');
      requestedGraceful = true;
      gracefulChannel = 'SIGTERM';
      logger?.info?.(
        `[gezel] sent SIGTERM to owned daemon accepted=${accepted}; ${childStopState(child)}`,
      );
    } catch (error) {
      logger?.warn?.(
        `[gezel] SIGTERM shutdown request failed: ${stopErrorMessage(error)}; ${childStopState(child)}`,
      );
      /* process may have exited between the predicate and signal */
    }
  }

  if (requestedGraceful && gracefulExit && (await gracefulExit)) {
    logger?.info?.(
      `[gezel] owned daemon confirmed exit after ${gracefulChannel}; ${childStopState(child)}`,
    );
    return;
  }
  if (childHasExited(child)) {
    logger?.info?.(
      `[gezel] owned daemon exited at the graceful deadline after ${gracefulChannel}; ${childStopState(child)}`,
    );
    return;
  }
  logger?.warn?.(
    `[gezel] owned daemon did not confirm exit within ${graceMs}ms after ${gracefulChannel}; escalating; ${childStopState(child)}`,
  );

  const forcedExit = waitForExit(child, forceMs);
  if (platform === 'win32' && Number.isInteger(child.pid) && (child.pid ?? 0) > 0) {
    logger?.warn?.(
      `[gezel] daemon pid=${child.pid} did not exit gracefully; terminating its Windows process tree`,
    );
    try {
      await (options.terminateWindowsTree ?? terminateWindowsProcessTree)(child.pid!);
    } catch (error) {
      logger?.warn?.(
        `[gezel] Windows process-tree termination failed; falling back to direct kill: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        /* process may already be gone */
      }
    }
  } else {
    try {
      const accepted = child.kill('SIGKILL');
      logger?.warn?.(
        `[gezel] sent SIGKILL to owned daemon accepted=${accepted}; ${childStopState(child)}`,
      );
    } catch (error) {
      logger?.warn?.(
        `[gezel] SIGKILL request failed: ${stopErrorMessage(error)}; ${childStopState(child)}`,
      );
      /* process may have exited immediately before escalation */
    }
  }
  const forceConfirmed = await forcedExit;
  if (forceConfirmed || childHasExited(child)) {
    logger?.info?.(
      `[gezel] owned daemon confirmed exit after forced stop; ${childStopState(child)}`,
    );
  } else {
    logger?.error?.(
      `[gezel] owned daemon did not confirm exit within ${forceMs}ms after forced stop; ${childStopState(child)}`,
    );
  }
}

function childStopState(child: ChildProcess): string {
  return `pid=${child.pid ?? 'unknown'} killed=${child.killed ?? false} exitCode=${child.exitCode ?? 'null'} signalCode=${child.signalCode ?? 'null'}`;
}

function stopErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n\t]+/g, ' ') : String(error);
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * Production-default client builder: when the daemon is serving HTTPS,
 * wire a fetch that trusts the per-launch cert; otherwise plain `fetch`.
 * Centralised here so the supervisor + CLI + tests all get the same
 * behaviour without each having to remember to thread the cert through.
 */
function defaultClientFactory(o: {
  baseUrl: string;
  token: string;
  cert: string | null;
}): GezelClient {
  if (o.cert) {
    return new GezelClient({
      baseUrl: o.baseUrl,
      token: o.token,
      fetch: createTrustingFetch({ cert: o.cert }),
    });
  }
  return new GezelClient({ baseUrl: o.baseUrl, token: o.token });
}

/**
 * Resolve the path to the bundled `gezeld.js` entry using Node's module
 * resolution. The service package explicitly exports this subpath from
 * its `exports` map (see packages/service/package.json) — do not remove
 * that entry or this resolve silently breaks spawn mode everywhere.
 */
export function resolveDaemonEntry(parentUrl: string): string {
  return createRequire(parentUrl).resolve('@bendyline/gezel-service/dist/bin/gezeld.js');
}
