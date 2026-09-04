import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HealthResponse } from '@bendyline/gezel';
import {
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
  electronNativeBinCandidates,
  isProcessAlive,
  readRuntime,
  resolveDaemonEntry,
  stopProcessByPid as stopDaemonProcessByPid,
  stopOwnedDaemon,
  systemSharedAssetsDir,
} from '@bendyline/gezel-client/node';
import {
  LLAMA_ENGINE_VERSION,
  detectLlamaBackend,
  isBinaryQuarantined,
  readLlamaQuarantine,
  resolveAvailableLlamaBinary,
} from '@bendyline/gezel/native';
import { gezelPaths } from '@bendyline/gezel/paths';
import { describeOwnedChildState, formatDiagnosticError } from './diagnostics.js';
import { defaultBundlePaths, extractBundleIfNeeded, readBundleMeta } from './extract-bundle.js';
import { defaultDuckdbBundleDir, installDuckdbIfNeeded } from './extract-duckdb.js';
import { defaultNodeBundleDir, installNodeIfNeeded } from './extract-node.js';
import { defaultPnpmBundleDir, installPnpmIfNeeded } from './extract-pnpm.js';
import { readHomeUsageSignals, readHostingPin, writeHostingPin } from './home-signals.js';
import { LogRotator } from './log-rotator.js';
import { machineServiceInstallFailed } from './machine-service-state.js';
import { type Mode, resolveMode, resolvePerUserMode } from './mode.js';
import { nativeBinDir, resolveNativeBinaryPath } from './native-bin.js';
import {
  inBundleServiceTree,
  resolveRuntimeInPlace,
  shouldRunRuntimesInPlace,
} from './run-in-place.js';
import { resolveSharedServiceTree } from './shared-service-tree.js';
import { evaluateStoreCompat } from './store-compat.js';
import {
  type SystemServiceRuntime,
  readSystemServiceRuntime,
  systemServiceHome,
} from './system-service.js';

export interface ConnectOptions {
  home: string;
  packaged: boolean;
  /** Dev-only opt-in. `process.env.GEZEL_SPAWN === '1'`. */
  devSpawn: boolean;
  /** `process.env.GEZEL_EMBEDDED === '1'` OR (dev AND !devSpawn). */
  forceEmbedded: boolean;
  /** UI directory to pass to embedded `startService`. */
  uiDir?: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /**
   * How long an adopted-but-not-yet-serving daemon gets to finish booting.
   * Defaults to {@link ADOPT_HEALTH_WAIT_MS}; tests shorten it so they can
   * exercise the give-up path without waiting out the real budget.
   */
  adoptHealthWaitMs?: number;
  /**
   * True in an App Store / Microsoft Store build. Diverts mode resolution onto
   * the store ladder, which may adopt a direct-download install's daemon but
   * never manages one. Resolved in main.ts from the build marker — see
   * src/store-build.ts.
   */
  storeProfile?: boolean;
}

interface LocalAdoptRuntime {
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number;
}

export type ConnectionMode = Mode['kind'];

export type ServiceConnectionState = 'ready' | 'restarting' | 'failed';

export interface ServiceConnectionFailure {
  code: 'restart-unrecoverable';
  sourceMode: ConnectionMode;
  message: string;
}

export type ServiceFallbackCode =
  | 'machine-service-not-installed'
  | 'machine-service-home-fresh'
  | 'machine-engine-unavailable'
  | 'legacy-machine-data'
  | 'system-service-unhealthy'
  | 'system-service-version-mismatch'
  | 'adopted-daemon-stale'
  | 'adopted-daemon-unhealthy'
  | 'store-service-unhealthy'
  | 'store-service-incompatible'
  | 'packaged-spawn-failed'
  | 'dev-spawn-failed'
  | 'version-mismatch-respawn-failed'
  | 'restart-budget-exhausted'
  | 'restart-failed';

/**
 * A degraded service situation worth telling the user about, surfaced as a
 * persistent banner. Most codes mean "we fell back to embedded"; the
 * exceptions include machine-engine availability, where the user product
 * daemon is healthy but model downloads/resource queues are not shared, and
 * rolling-upgrade notices for a legacy full-product system daemon. Branch on
 * `code`, not the connection mode, when the copy matters.
 *
 * `code` and `message` both cross to the renderer via the preload bridge.
 */
export interface ServiceFallbackReason {
  code: ServiceFallbackCode;
  sourceMode: ConnectionMode;
  message: string;
}

/**
 * Tuning knobs for health watching + restart. Extracted so tests can inject
 * aggressive intervals; production defaults are conservative enough to
 * avoid chatty polling while still catching most crashes within ~45s.
 */
const HEALTH_POLL_INTERVAL_MS = 15_000;
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const RESTART_BUDGET_COUNT = 3;
const RESTART_BUDGET_WINDOW_MS = 60_000;
const GRACEFUL_STOP_MS = 3_000;
export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
// First start on a clean packaged machine can spend several seconds in OS
// verification and runtime initialization before publishing discovery files.
// Keep routine health probes short, but give this one-time fallback path room.
const PACKAGED_STARTUP_TIMEOUT_MS = 30_000;
// How long to wait for a machine engine the OS service manager reports as
// running/starting to publish role + runtime discovery. Sized from the
// observed fresh-install race: the installer launches the app ~4s after
// enabling GezelService, and the service publishes runtime files 20-30s
// after that (OS verification + first daemon boot). 45s covers that with
// margin for slower disks. The wait lets the user daemon route its very first
// native request to the broker instead of briefly starting a duplicate engine.
const MACHINE_SERVICE_STARTUP_WAIT_MS = 45_000;
const MACHINE_SERVICE_STARTUP_POLL_MS = 1_000;
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
const ADOPT_HEALTH_WAIT_MS = 45_000;
const ADOPT_HEALTH_POLL_MS = 1_000;

interface SupervisedServiceInit {
  systemServiceHome?: string;
  fallbackReason?: ServiceFallbackReason | null;
}

/**
 * The handle returned from `connectOrStart`. Implements a small event
 * surface so Electron main can react to restarts (reload the UI — token
 * changes) and fallback (surface a banner).
 */
export class SupervisedService extends EventEmitter {
  private _mode: ConnectionMode;
  private _baseUrl: string;
  private _token: string;
  /**
   * The daemon's loopback TLS cert PEM, when it's serving HTTPS. `null`
   * for HTTP/1.1 daemons (legacy or `GEZEL_INSECURE_TRANSPORT=1`). The
   * Electron renderer uses this — well, its sha-256 fingerprint — to
   * pin trust via `session.setCertificateVerifyProc`. Rotates on every
   * supervisor restart along with the auth token.
   */
  private _cert: string | null;
  private _fallbackReason: ServiceFallbackReason | null;
  private _state: ServiceConnectionState = 'ready';
  private _failure: ServiceConnectionFailure | null = null;
  private child?: ChildProcess;
  private embeddedStop?: () => Promise<void>;
  /** Restores the original stdout/stderr writers after an embedded tee. */
  private embeddedLogTeeRestore?: () => void;
  private healthTimer?: NodeJS.Timeout;
  private healthGeneration = 0;
  private healthProbe?: { generation: number; controller: AbortController };
  private consecutiveHealthFailures = 0;
  private lastHealthSuccessAt: string;
  private lastHealthVersion?: string;
  private lastHealthFailure?: { at: string; elapsedMs: number; error: string };
  private restartAttempts: number[] = [];
  private transitionInFlight?: Promise<void>;
  private shuttingDown = false;
  private logRotator: LogRotator;

  constructor(
    mode: ConnectionMode,
    baseUrl: string,
    token: string,
    cert: string | null,
    private opts: ConnectOptions,
    private init: SupervisedServiceInit = {},
  ) {
    super();
    this._mode = mode;
    this._baseUrl = baseUrl;
    this._token = token;
    this._cert = cert;
    this._fallbackReason = init.fallbackReason ?? null;
    this.logRotator = new LogRotator({ dir: gezelPaths(opts.home).logs });
    // connectOrStart verifies every candidate before constructing the handle,
    // so construction time is an honest initial health-success timestamp.
    this.lastHealthSuccessAt = new Date().toISOString();
  }

  get mode(): ConnectionMode {
    return this._mode;
  }
  get baseUrl(): string {
    return this._baseUrl;
  }
  get token(): string {
    return this._token;
  }
  get cert(): string | null {
    return this._cert;
  }
  get fallbackReason(): ServiceFallbackReason | null {
    return this._fallbackReason;
  }
  get state(): ServiceConnectionState {
    return this._state;
  }
  get failure(): ServiceConnectionFailure | null {
    return this._failure;
  }

  /**
   * Called by the supervisor factory after instantiation to attach the
   * owned resources (spawned child or embedded handle). Separated from the
   * constructor so the factory can swap resources during a restart without
   * creating a new object.
   */
  attachSpawned(child: ChildProcess): void {
    this.detachResources();
    this.child = child;
    this.wirePipes(child);
    this.startHealthWatch();
  }

  private wirePipes(child: ChildProcess): void {
    child.stdout?.on('data', (buf: Buffer) => {
      const line = buf.toString().trimEnd();
      this.opts.logger?.info?.(`[gezeld] ${line}`);
      void this.logRotator.write(line);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const line = buf.toString().trimEnd();
      this.opts.logger?.warn?.(`[gezeld] ${line}`);
      void this.logRotator.write(line);
    });
  }

  /**
   * Supervisor failures happen in Electron, not in gezeld, so console output
   * alone disappears for ordinary desktop launches. Mirror the diagnostic
   * chain into the same durable service log as the child's stdout/stderr.
   */
  private recordSupervisorDiagnostic(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `[supervisor] ${message}`;
    this.opts.logger?.[level]?.(line);
    void this.logRotator.write(line).catch((error: unknown) => {
      this.opts.logger?.warn?.(
        `[supervisor] failed to persist diagnostic: ${formatDiagnosticError(error)}`,
      );
    });
  }

  private durableChildLogger(): NonNullable<ConnectOptions['logger']> {
    const timestamped = (message: string) => `at=${new Date().toISOString()} ${message}`;
    return {
      info: (message) => this.recordSupervisorDiagnostic('info', timestamped(message)),
      warn: (message) => this.recordSupervisorDiagnostic('warn', timestamped(message)),
      error: (message) => this.recordSupervisorDiagnostic('error', timestamped(message)),
    };
  }

  attachEmbedded(stop: () => Promise<void>): void {
    this.detachResources();
    this.embeddedStop = stop;
    // Embedded = same process. If it dies, Electron dies. No health poll.
    //
    // Unlike a spawned child (whose stdio `wirePipes` feeds into the
    // LogRotator), an in-process service logs straight to this process's
    // stdout/stderr — which Electron shows on the console but nothing
    // persists. That left `service-*.log` empty for every embedded run
    // (the `pnpm app` default), so a mid-session failure like an MCP
    // bridge that came up with zero tools left no on-disk trace to grep.
    // Tee both streams into the same rotator so embedded logs are durable
    // too. Restored on the next detach.
    this.embeddedLogTeeRestore = this.installEmbeddedLogTee();
  }

  /**
   * Mirror everything written to this process's stdout/stderr into the
   * LogRotator, returning a restore function. Best-effort: a rotator write
   * never blocks or breaks the underlying stream, and non-text chunks pass
   * through untouched. The rotator writes to a file stream (not stdout), so
   * there is no write→tee→write recursion.
   */
  private installEmbeddedLogTee(): () => void {
    const rotator = this.logRotator;
    const patch = (stream: NodeJS.WriteStream): (() => void) => {
      const original = stream.write.bind(stream);
      const wrapped = ((chunk: unknown, ...rest: unknown[]): boolean => {
        try {
          if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
            const line = chunk.toString().trimEnd();
            if (line.length > 0) void rotator.write(line);
          }
        } catch {
          /* logging must never break the stream */
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      stream.write = wrapped;
      return () => {
        stream.write = original;
      };
    };
    const restoreOut = patch(process.stdout);
    const restoreErr = patch(process.stderr);
    return () => {
      restoreOut();
      restoreErr();
    };
  }

  onRestart(fn: () => void): () => void {
    this.on('restart', fn);
    return () => this.off('restart', fn);
  }

  onFallback(fn: (reason: ServiceFallbackReason) => void): () => void {
    this.on('fallback', fn);
    return () => this.off('fallback', fn);
  }

  /**
   * The owned daemon and every supported replacement both failed. Main uses
   * this to discard its API client/certificate pin and replace the renderer
   * with a persistent reconnect page whose preload receives no bearer token.
   */
  onFatal(fn: (failure: ServiceConnectionFailure) => void): () => void {
    this.on('fatal', fn);
    return () => this.off('fatal', fn);
  }

  /**
   * Service has requested a restart (e.g. folders externalization
   * just swapped paths). Subscribers can surface it to the UI;
   * the actual restart waits until the user (or the same listener)
   * calls {@link restart}.
   */
  onRestartRequested(fn: (reason: string) => void): () => void {
    this.on('restart-requested', fn);
    return () => this.off('restart-requested', fn);
  }

  /**
   * Externally-triggered restart. Used by the renderer's "Restart now"
   * button after a folder-externalization move. Routes to the matching
   * embedded/spawn restart path. Safe to call when no restart is
   * actually needed — just bounces the daemon.
   */
  async restart(reason: string): Promise<void> {
    this.opts.logger?.info?.(`[supervisor] restart requested: ${reason}`);
    await this.runTransition(() => this.restartForCurrentMode(reason));
  }

  private async restartForCurrentMode(reason: string): Promise<void> {
    const mode = this._mode;
    switch (mode) {
      case 'embedded':
        await this.restartOwnedWithFallback(mode, reason, () => this.restartEmbedded());
        return;
      case 'local-spawn-packaged':
      case 'local-spawn-dev':
        await this.restartOwnedWithFallback(mode, reason, () => this.restartSpawn());
        return;
      case 'remote':
        await this.reconnectRemote();
        return;
      case 'store-connect':
        await this.reconnectStoreService();
        return;
      case 'system-service':
        await this.reconnectSystemService();
        return;
      case 'local-adopt':
        await this.reconnectAdopted();
        return;
      default:
        assertNeverMode(mode);
    }
  }

  private async reconnectRemote(): Promise<void> {
    await probeRemote(this._baseUrl, this._token);
    this.emit('restart');
  }

  /**
   * Re-probe the adopted direct-download daemon and re-judge it.
   *
   * Re-judged rather than re-probed only, because the reason we are here is
   * usually that the OTHER install updated itself underneath us — the store
   * and direct channels ship on different schedules, so a mid-session version
   * change is expected, and it is the one moment compatibility can flip.
   *
   * Never stops or respawns anything: we did not start this daemon. A verdict
   * that has gone incompatible raises, and the caller's fallback path starts
   * our own service instead.
   */
  private async reconnectStoreService(): Promise<void> {
    const health = await healthWithTimeout(
      buildHealthClient(this._baseUrl, this._token, this._cert),
    );
    const verdict = evaluateStoreCompat(health);
    if (!verdict.compatible) {
      throw new Error(`the installed Gezel service is no longer compatible: ${verdict.reason}`);
    }
    this._fallbackReason = null;
    this.emit('restart');
  }

  private async reconnectSystemService(): Promise<void> {
    const home = this.init.systemServiceHome;
    if (!home) throw new Error('System-service restart is missing its service home');
    const runtime = await readSystemServiceRuntime(home);
    if (!runtime) throw new Error(`System-service runtime is unavailable at ${home}`);
    const health = await healthWithTimeout(
      buildHealthClient(runtime.baseUrl, runtime.token, runtime.cert),
    );
    this._baseUrl = runtime.baseUrl;
    this._token = runtime.token;
    this._cert = runtime.cert;
    // Re-evaluate the skew rather than carrying the boot-time verdict
    // forward. Rerunning the installer is exactly how a user resolves this
    // banner, and the reconnect that follows should clear it — otherwise
    // the warning outlives the problem until the app is fully restarted.
    this._fallbackReason = await systemServiceVersionSkew(health.version, home, this.opts);
    this.emit('restart');
  }

  private async reconnectAdopted(): Promise<void> {
    const runtime = await readRuntime(this.opts.home);
    if (!runtime || !isProcessAlive(runtime.pid)) {
      throw new Error('Adopted daemon is no longer running');
    }
    await healthWithTimeout(buildHealthClient(runtime.baseUrl, runtime.token, runtime.cert));
    this._baseUrl = runtime.baseUrl;
    this._token = runtime.token;
    this._cert = runtime.cert;
    this.emit('restart');
  }

  private async restartEmbedded(): Promise<void> {
    this.beginDestructiveRestart();
    this.stopHealthWatch();
    if (this.embeddedStop) {
      try {
        await this.embeddedStop();
      } catch (error) {
        await this.handleStopFailure('embedded service', error);
        throw error;
      }
    }
    this.detachResources();
    const embedded = await startEmbeddedRaw(this.opts, this.requestRestartFromService);
    await this.installEmbeddedCandidate(embedded);
  }

  /**
   * Owned services cannot overlap because both would write the same home. Once
   * shutdown has begun we therefore cannot roll back to the original process;
   * recover by starting the supported in-process service instead. Failures
   * before shutdown (for example bundle preparation) leave the old connection
   * ready and are simply reported to the caller.
   */
  private async restartOwnedWithFallback(
    sourceMode: ConnectionMode,
    reason: string,
    restart: () => Promise<void>,
  ): Promise<void> {
    try {
      await restart();
      return;
    } catch (primaryError) {
      if (this._state === 'ready' || this._state === 'failed') throw primaryError;
      const fallbackReason: ServiceFallbackReason = {
        code: 'restart-failed',
        sourceMode,
        message: `The background service could not restart (${reason}): ${errorMessage(primaryError)}`,
      };
      try {
        await this.fallbackToEmbedded(fallbackReason);
      } catch (fallbackError) {
        const recoveryState: ServiceConnectionState = this.state;
        if (recoveryState !== 'ready' && recoveryState !== 'failed') {
          this.markRestartUnrecoverable(sourceMode, primaryError, fallbackError);
        }
        throw new AggregateError(
          [primaryError, fallbackError],
          `gezeld restart and embedded recovery both failed: ${errorMessage(fallbackError)}`,
        );
      }
    }
  }

  private beginDestructiveRestart(): void {
    this._state = 'restarting';
    this._failure = null;
  }

  private markReady(): void {
    this._state = 'ready';
    this._failure = null;
    this.lastHealthSuccessAt = new Date().toISOString();
    this.lastHealthFailure = undefined;
  }

  private markRestartUnrecoverable(
    sourceMode: ConnectionMode,
    primaryError: unknown,
    fallbackError?: unknown,
    options: { preserveResources?: boolean } = {},
  ): void {
    this.stopHealthWatch();
    if (!options.preserveResources) this.detachResources();
    // A failed renderer reload must not receive credentials for the daemon we
    // already stopped. Keep the old URL only as reconnect-page diagnostics.
    this._token = '';
    this._cert = null;
    const recoveryDetail = fallbackError
      ? `; embedded recovery also failed: ${errorMessage(fallbackError)}`
      : '';
    const healthDetail = this.lastHealthFailure
      ? `; preceding health failure at ${this.lastHealthFailure.at} after ${this.lastHealthFailure.elapsedMs}ms: ${this.lastHealthFailure.error}`
      : '';
    const failure: ServiceConnectionFailure = {
      code: 'restart-unrecoverable',
      sourceMode,
      message: `The background service stopped but its replacement failed: ${errorMessage(primaryError)}${recoveryDetail}${healthDetail}`,
    };
    this._state = 'failed';
    this._failure = failure;
    this.recordSupervisorDiagnostic(
      'error',
      `fatal restart failure at=${new Date().toISOString()} mode=${sourceMode}: ${failure.message}`,
    );
    this.emit('fatal', failure);
  }

  /**
   * A stop rejection is ambiguous: the service may have rejected before doing
   * anything, or may have stopped and then failed cleanup. Re-probe the exact
   * old credentials. A healthy response restores the prior connection; an
   * unhealthy response is explicit fatal state because starting a second
   * writer would risk corruption.
   */
  private async handleStopFailure(label: string, stopError: unknown): Promise<void> {
    const stopDiagnostic = formatDiagnosticError(stopError);
    try {
      const health = await healthWithTimeout(
        buildHealthClient(this._baseUrl, this._token, this._cert),
      );
      this.lastHealthVersion = health.version;
      this.markReady();
      if (this.child) this.startHealthWatch();
      this.recordSupervisorDiagnostic(
        'warn',
        `${label} rejected shutdown but remains healthy at=${new Date().toISOString()}; retaining the existing connection; stopError=${stopDiagnostic}`,
      );
    } catch (healthError) {
      const healthDiagnostic = formatDiagnosticError(healthError);
      const childDiagnostic = await describeOwnedChildState(this.child);
      this.recordSupervisorDiagnostic(
        'error',
        `${label} shutdown unconfirmed at=${new Date().toISOString()}; stopError=${stopDiagnostic}; reprobeError=${healthDiagnostic}; child={${childDiagnostic}}`,
      );
      this.markRestartUnrecoverable(
        this._mode,
        new Error(
          `${label} shutdown could not be confirmed and its old endpoint is unhealthy; stopError=${stopDiagnostic}; reprobeError=${healthDiagnostic}; child={${childDiagnostic}}`,
          {
            cause: new AggregateError([stopError, healthError], `${label} stop and reprobe failed`),
          },
        ),
        undefined,
        { preserveResources: true },
      );
    }
  }

  private async verifyReplacement(
    candidate: Pick<LocalAdoptRuntime, 'baseUrl' | 'token' | 'cert'>,
  ): Promise<void> {
    const health = await healthWithTimeout(
      buildHealthClient(candidate.baseUrl, candidate.token, candidate.cert),
    );
    this.lastHealthVersion = health.version;
  }

  private async installEmbeddedCandidate(
    embedded: {
      baseUrl: string;
      token: string;
      cert: string | null;
      stop: () => Promise<void>;
    },
    emitRestart = true,
  ): Promise<void> {
    try {
      await this.verifyReplacement(embedded);
    } catch (error) {
      try {
        await embedded.stop();
      } catch (stopError) {
        this.embeddedStop = embedded.stop;
        this.markRestartUnrecoverable(this._mode, error, stopError, {
          preserveResources: true,
        });
      }
      throw error;
    }
    this._baseUrl = embedded.baseUrl;
    this._token = embedded.token;
    this._cert = embedded.cert;
    this.attachEmbedded(embedded.stop);
    this.markReady();
    if (emitRestart) this.emit('restart');
  }

  /** Bound callback we hand to the embedded service so it can ask for
   *  a restart. Re-emits as the public `restart-requested` event. */
  private requestRestartFromService = (reason: string): void => {
    this.opts.logger?.info?.(`[supervisor] service requested restart: ${reason}`);
    this.emit('restart-requested', reason);
  };

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthWatch();
    // A user restart and crash recovery share the transition mutex. If quit
    // arrives mid-transition, let it settle, then stop whichever resource it
    // installed. This avoids racing a newly spawned child past shutdown.
    if (this.transitionInFlight) await this.transitionInFlight.catch(() => {});
    this.stopHealthWatch();
    if (this.child) await gracefullyStop(this.child, this.durableChildLogger());
    if (this.embeddedStop) await this.embeddedStop();
    await this.logRotator.close();
    this.child = undefined;
    this.embeddedStop = undefined;
  }

  private detachResources(): void {
    this.stopHealthWatch();
    this.child = undefined;
    this.embeddedStop = undefined;
    if (this.embeddedLogTeeRestore) {
      this.embeddedLogTeeRestore();
      this.embeddedLogTeeRestore = undefined;
    }
  }

  private startHealthWatch(): void {
    this.consecutiveHealthFailures = 0;
    const generation = ++this.healthGeneration;
    this.healthTimer = setInterval(() => {
      void this.tick(generation);
    }, HEALTH_POLL_INTERVAL_MS);
  }

  /**
   * Forgive health-check state accrued across a host suspension.
   *
   * The watch polls every 15s and restarts the daemon after 3 consecutive
   * failures. A machine coming out of sleep fires every overdue probe at once
   * into a daemon that is itself still being rescheduled, and three of those
   * land inside 45s — a restart triggered by the wake-up, not by anything
   * wrong. The daemon survives suspension perfectly well; give it a clean
   * slate and one skipped interval to answer in.
   */
  noteHostResumed(): void {
    if (this.consecutiveHealthFailures > 0) {
      this.opts.logger?.info?.(
        `[supervisor] host resumed — discarding ${this.consecutiveHealthFailures} health failure(s) that straddled the suspension`,
      );
    }
    this.consecutiveHealthFailures = 0;
    this.lastHealthFailure = undefined;
    if (!this.healthTimer) return;
    // Re-arm the interval so the first post-resume probe is a fresh one rather
    // than the overdue tick the OS is about to deliver.
    clearInterval(this.healthTimer);
    const generation = this.healthGeneration;
    this.healthTimer = setInterval(() => {
      void this.tick(generation);
    }, HEALTH_POLL_INTERVAL_MS);
  }

  private stopHealthWatch(): void {
    this.healthGeneration += 1;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.healthProbe?.controller.abort(new Error('Health watch stopped'));
    this.healthProbe = undefined;
  }

  private async tick(generation = this.healthGeneration): Promise<void> {
    if (this.shuttingDown || generation !== this.healthGeneration) return;
    // `setInterval` does not await its callback. Keep one request in flight
    // for this connection generation so a wedged socket cannot accumulate an
    // unbounded stack of probes and concurrent restart attempts.
    if (this.healthProbe?.generation === generation) return;
    const probe = { generation, controller: new AbortController() };
    this.healthProbe = probe;
    const client = this._cert
      ? new GezelClient({
          baseUrl: this._baseUrl,
          token: this._token,
          fetch: createTrustingFetch({ cert: this._cert }),
        })
      : new GezelClient({ baseUrl: this._baseUrl, token: this._token });
    const probeStartedAt = Date.now();
    try {
      const health = await healthWithTimeout(client, HEALTH_REQUEST_TIMEOUT_MS, probe.controller);
      if (generation !== this.healthGeneration) return;
      const previousVersion = this.lastHealthVersion;
      this.consecutiveHealthFailures = 0;
      this.lastHealthSuccessAt = new Date().toISOString();
      this.lastHealthVersion = health.version;
      this.lastHealthFailure = undefined;

      // The direct-download install can update itself while we are connected —
      // the two channels ship on different schedules, so this is expected
      // rather than exceptional. A version move is the one moment the
      // compatibility answer can change, so re-judge it there and nowhere
      // else: judging on every tick would spend a verdict on an unchanged
      // daemon 240 times an hour.
      if (
        this._mode === 'store-connect' &&
        previousVersion !== undefined &&
        previousVersion !== health.version
      ) {
        const verdict = evaluateStoreCompat(health);
        if (!verdict.compatible) {
          this.opts.logger?.warn?.(
            `[supervisor] adopted service updated to ${health.version} and is no longer compatible`,
          );
          await this.fallbackToEmbedded({
            code: 'store-service-incompatible',
            sourceMode: this._mode,
            message: `the installed Gezel service was updated and ${verdict.reason}`,
          });
          return;
        }
      }
      // `machine-service-not-installed` is included deliberately. The installer
      // now records the START outcome rather than the `sc create` result, so a
      // service that was registered but could not come up during install
      // leaves a 0 behind. That is the honest reading at install time, but the
      // registration survives with start=auto and usually succeeds on the next
      // boot — at which point the breadcrumb is stale and the notice is a false
      // alarm. A live, connected machine engine outranks a disk breadcrumb.
      if (
        (this._fallbackReason?.code === 'machine-engine-unavailable' ||
          this._fallbackReason?.code === 'machine-service-not-installed') &&
        health.machineEngineConnected
      ) {
        this.opts.logger?.info?.(
          '[supervisor] shared model engine recovered; clearing its install-health notice',
        );
        this._fallbackReason = null;
        // Reload once so preload-derived shell state drops the stale notice.
        // This does not restart either daemon or rotate the user token.
        this.emit('restart');
      }
    } catch (error) {
      if (generation !== this.healthGeneration) return;
      this.consecutiveHealthFailures += 1;
      const at = new Date().toISOString();
      const elapsedMs = Math.max(0, Date.now() - probeStartedAt);
      const diagnostic = formatDiagnosticError(error);
      this.lastHealthFailure = { at, elapsedMs, error: diagnostic };
      this.recordSupervisorDiagnostic(
        'warn',
        `health-check failure ${this.consecutiveHealthFailures}/${HEALTH_FAILURES_BEFORE_RESTART} at=${at} elapsedMs=${elapsedMs} endpoint=${this._baseUrl} lastSuccessAt=${this.lastHealthSuccessAt} lastVersion=${this.lastHealthVersion ?? 'unknown'} error=${diagnostic}`,
      );
      if (this.consecutiveHealthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
        this.consecutiveHealthFailures = 0;
        // A store build adopted this daemon; it did not start it. Restarting is
        // not ours to do — under the macOS sandbox we cannot signal it at all,
        // and on Windows it would be one product restarting another's service.
        // Stand up our own instead, which is the same answer the boot path
        // would have reached had the daemon been down then.
        if (this._mode === 'store-connect') {
          await this.fallbackToEmbedded({
            code: 'store-service-unhealthy',
            sourceMode: this._mode,
            message: 'the installed Gezel service stopped responding, so this app started its own',
          });
          return;
        }
        const childDiagnostic = await describeOwnedChildState(this.child);
        this.recordSupervisorDiagnostic(
          'error',
          `health restart threshold reached at=${new Date().toISOString()} mode=${this._mode} host=${process.platform}/${process.arch} child={${childDiagnostic}}`,
        );
        await this.handleCrash('health check failed 3 times');
      }
    } finally {
      if (this.healthProbe === probe) this.healthProbe = undefined;
    }
  }

  private async handleCrash(reason: string): Promise<void> {
    await this.runTransition(() => this.handleCrashExclusive(reason));
  }

  private async handleCrashExclusive(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    const now = Date.now();
    this.restartAttempts = this.restartAttempts.filter((t) => now - t < RESTART_BUDGET_WINDOW_MS);
    if (this.restartAttempts.length >= RESTART_BUDGET_COUNT) {
      await this.fallbackToEmbedded({
        code: 'restart-budget-exhausted',
        sourceMode: this._mode,
        message: `gezeld crashed ${RESTART_BUDGET_COUNT}+ times in the last ${Math.round(RESTART_BUDGET_WINDOW_MS / 1000)}s (last reason: ${reason})`,
      });
      return;
    }
    this.restartAttempts.push(now);
    this.opts.logger?.warn?.(
      `[supervisor] restarting gezeld (attempt ${this.restartAttempts.length}/${RESTART_BUDGET_COUNT}; reason: ${reason})`,
    );
    try {
      await this.restartSpawn();
    } catch (err) {
      this.opts.logger?.error?.(`[supervisor] restart failed: ${(err as Error).message}`);
      // Pre-stop preparation failure leaves the old watcher/connection intact;
      // an unconfirmed stop has already entered fatal state. Only a failure
      // after confirmed shutdown is allowed to start another writer.
      if (this._state !== 'restarting') return;
      await this.fallbackToEmbedded({
        code: 'restart-failed',
        sourceMode: this._mode,
        message: `gezeld restart failed: ${(err as Error).message}`,
      });
    }
  }

  private runTransition(operation: () => Promise<void>): Promise<void> {
    if (this.transitionInFlight) return this.transitionInFlight;
    const transition = Promise.resolve().then(operation);
    this.transitionInFlight = transition;
    const clear = () => {
      if (this.transitionInFlight === transition) this.transitionInFlight = undefined;
    };
    void transition.then(clear, clear);
    return transition;
  }

  private async restartSpawn(): Promise<void> {
    const mode = this._mode;
    // Extraction is safe to prepare transactionally while the old process is
    // still serving. If it fails, restartOwnedWithFallback sees state=ready and
    // leaves the healthy old daemon untouched instead of causing an outage.
    const preparedInstallDir =
      mode === 'local-spawn-packaged' ? await preparePackagedInstall(this.opts) : undefined;

    this.beginDestructiveRestart();
    this.stopHealthWatch();
    if (this.child) {
      try {
        await gracefullyStop(this.child, this.durableChildLogger());
      } catch (error) {
        await this.handleStopFailure('spawned service', error);
        throw error;
      }
    }
    this.detachResources();
    const result =
      mode === 'local-spawn-packaged'
        ? await spawnChildFromInstall(this.opts, preparedInstallDir ? { preparedInstallDir } : {})
        : mode === 'local-spawn-dev'
          ? await spawnChild(this.opts)
          : (() => {
              throw new Error(`Cannot spawn-restart unowned mode ${mode}`);
            })();
    try {
      await this.verifyReplacement(result);
    } catch (error) {
      try {
        await gracefullyStop(result.child, this.durableChildLogger());
      } catch (stopError) {
        this.child = result.child;
        this.markRestartUnrecoverable(mode, error, stopError, { preserveResources: true });
      }
      throw error;
    }
    this._baseUrl = result.baseUrl;
    this._token = result.token;
    this._cert = result.cert;
    this.attachSpawned(result.child);
    this.markReady();
    this.emit('restart');
  }

  private async fallbackToEmbedded(reason: ServiceFallbackReason): Promise<void> {
    this.opts.logger?.error?.(`[supervisor] falling back to embedded: ${reason.message}`);
    const sourceMode = reason.sourceMode;
    this.beginDestructiveRestart();
    this.stopHealthWatch();
    try {
      if (this.child) {
        try {
          await gracefullyStop(this.child, this.durableChildLogger());
        } catch (error) {
          await this.handleStopFailure('spawned service', error);
          throw error;
        }
        this.detachResources();
      }
      const embedded = await startEmbeddedRaw(this.opts, this.requestRestartFromService);
      this._fallbackReason = reason;
      await this.installEmbeddedCandidate(embedded, false);
      this._mode = 'embedded';
      this.emit('fallback', reason);
      this.emit('restart');
    } catch (error) {
      if (this._state !== 'ready' && this._state !== 'failed') {
        this.markRestartUnrecoverable(sourceMode, reason.message, error);
      }
      throw error;
    }
  }
}

export type Connection = SupervisedService;

/**
 * Resolve a mode, then establish the connection. For branches we don't own
 * (`remote`, `local-adopt`), verify the daemon is reachable before
 * returning — a misconfigured remote URL should be a loud error, not a
 * silent drift into embedded mode.
 */
export async function connectOrStart(opts: ConnectOptions): Promise<SupervisedService> {
  // Most Electron E2Es use a fresh home and the system Node/pnpm already
  // running the checkout. Reinstalling and repeatedly hashing the ~110 MB
  // bundled runtimes for every spec only tests cold provisioning over and
  // over. Development tests may bypass that prelude; packaged launches never
  // honor the escape hatch, and supervisor-spawn.spec explicitly opts back in
  // to retain one end-to-end provisioning check.
  const skipBundledRuntimeInstall =
    !opts.packaged && process.env.GEZEL_SKIP_BUNDLED_RUNTIME_INSTALL === '1';
  // A Mac App Store build runs its bundled runtimes where they shipped rather
  // than copying them into the home directory first — see run-in-place.ts for
  // why the copy is both forbidden there and pointless. Windows MSIX keeps the
  // extract path: full trust, a real user profile, and sharing with an
  // npm-installed daemon that is worth keeping.
  const runInPlace = shouldRunRuntimesInPlace({ storeProfile: opts.storeProfile === true });

  if (skipBundledRuntimeInstall) {
    opts.logger?.info?.('[supervisor] skipping bundled runtime install in development');
  } else if (runInPlace) {
    // Same fail-closed discipline as the extract path below: drop anything
    // inherited before resolving, and refuse an unverified result.
    delete process.env.GEZEL_NODE_PATH;
    delete process.env.GEZEL_PNPM_PATH;

    const node = await resolveRuntimeInPlace({
      bundleDir: defaultNodeBundleDir(import.meta.url),
      entry: 'node',
      logger: opts.logger,
    });
    if (node.path && node.verified) {
      process.env.GEZEL_NODE_PATH = node.path;
    } else {
      opts.logger?.warn?.(
        `[supervisor] bundled node unavailable in place (${node.reason ?? 'unverified'}); Node-backed tools remain disabled`,
      );
    }

    const pnpm = await resolveRuntimeInPlace({
      bundleDir: defaultPnpmBundleDir(import.meta.url),
      entry: join('bin', 'pnpm.mjs'),
      // The entry is a shim that loads the real CLI; verifying only the shim
      // would leave the code that does the work unchecked.
      manifestFiles: ['bin/pnpm.mjs', 'dist/pnpm.mjs'],
      logger: opts.logger,
    });
    if (pnpm.path && pnpm.verified) {
      process.env.GEZEL_PNPM_PATH = pnpm.path;
    } else {
      opts.logger?.warn?.(
        `[supervisor] bundled pnpm unavailable in place (${pnpm.reason ?? 'unverified'}); package workflows remain disabled`,
      );
    }
  } else {
    // Install Node first: the bundled pnpm package is a JavaScript CLI and
    // every packaged platform launches it with this runtime. The sandbox
    // runner also prefers `GEZEL_NODE_PATH` over `node` on PATH so
    // `run_nodejs_script` works on machines without a global Node
    // install. Packaged mode fails closed when the release manifest is absent
    // or invalid; only development may use an unauthenticated/PATH runtime.
    if (opts.packaged) delete process.env.GEZEL_NODE_PATH;
    try {
      const nodeBundleDir = defaultNodeBundleDir(import.meta.url);
      const node = await installNodeIfNeeded({
        home: opts.home,
        bundleDir: nodeBundleDir,
        logger: opts.logger,
      });
      if (node.binaryPath && (node.verified || !opts.packaged)) {
        process.env.GEZEL_NODE_PATH = node.binaryPath;
      } else if (opts.packaged) {
        opts.logger?.warn?.(
          '[supervisor] verified bundled node is unavailable; packaged autostart and Node-backed tools remain disabled',
        );
      }
    } catch (err) {
      opts.logger?.warn?.(
        `[supervisor] node install step failed: ${(err as Error).message}; continuing without a trusted bundled node`,
      );
    }

    // Lay down the ordinary pnpm package at
    // `~/.gezel/bin/pnpm-runtime/` and point the service at its JS
    // entrypoint. Invocation resolution combines this with
    // `GEZEL_NODE_PATH`; dev mode still falls back to pnpm on PATH.
    if (opts.packaged) delete process.env.GEZEL_PNPM_PATH;
    try {
      const bundleDir = defaultPnpmBundleDir(import.meta.url);
      const pnpm = await installPnpmIfNeeded({ home: opts.home, bundleDir, logger: opts.logger });
      if (pnpm.entryPath && (pnpm.verified || !opts.packaged)) {
        process.env.GEZEL_PNPM_PATH = pnpm.entryPath;
      } else if (opts.packaged) {
        opts.logger?.warn?.(
          '[supervisor] verified bundled pnpm is unavailable; packaged package workflows and autostart remain disabled',
        );
      }
    } catch (err) {
      opts.logger?.warn?.(
        `[supervisor] pnpm install step failed: ${(err as Error).message}; continuing without bundled pnpm`,
      );
    }
  }

  // Expose the per-platform bundled sd-server (and, later, other native
  // engines) to the service via well-known env vars. The service's
  // `createImageProvider` factory picks these up and wraps them in the
  // supervisor → lazy-start pipeline. Absent binary = factory falls
  // back to its loopback-URL branch + clear error on first use.
  //
  // Also publishes GEZEL_NATIVE_BIN_DIR so the service's own native
  // discovery (used by system-service launches that bypass the
  // supervisor entirely) can re-resolve if anything was missed here.
  // Idempotent — operator-set values win.
  if (!process.env.GEZEL_NATIVE_BIN_DIR) {
    const bundledNativeRoot = nativeBinDir(import.meta.url);
    // Packaged payloads pass the release build's hash/signature gates before
    // shipping. A development checkout is mutable, so feed its payload and
    // any installed Electron payload through the service package's exact
    // source-pinned verifier before exposing either one to child processes.
    if (opts.packaged) {
      process.env.GEZEL_NATIVE_BIN_DIR = bundledNativeRoot;
    } else {
      const developmentCandidates = existsSync(bundledNativeRoot) ? [bundledNativeRoot] : [];
      const installedCandidates = electronNativeBinCandidates().filter(
        (candidate, index, all) =>
          candidate !== bundledNativeRoot &&
          existsSync(candidate) &&
          all.indexOf(candidate) === index,
      );
      if (developmentCandidates.length > 0 || installedCandidates.length > 0) {
        try {
          const { reuseVerifiedElectronNativeBinaries } = await import('@bendyline/gezel-service');
          let reuse =
            developmentCandidates.length > 0
              ? await reuseVerifiedElectronNativeBinaries({
                  candidates: developmentCandidates,
                  allowStandaloneMacPayload: true,
                })
              : undefined;
          if (!reuse?.reused && installedCandidates.length > 0) {
            const installedReuse = await reuseVerifiedElectronNativeBinaries({
              candidates: installedCandidates,
            });
            reuse = reuse
              ? {
                  ...installedReuse,
                  reason: `${reuse.reason}; ${installedReuse.reason}`,
                }
              : installedReuse;
          }
          if (!reuse) {
            opts.logger?.warn?.('[supervisor] native payload reuse produced no result');
          } else if (reuse.reused) {
            opts.logger?.info?.(`[supervisor] ${reuse.reason}: ${reuse.nativeBinDir}`);
          } else {
            opts.logger?.warn?.(`[supervisor] native payload reuse rejected: ${reuse.reason}`);
          }
        } catch (error) {
          opts.logger?.warn?.(
            `[supervisor] native payload verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
  // Mirror the CLI's defensive overlay (packages/cli/src/connection.ts): a
  // user daemon may validate/read immutable machine-published model bundles
  // before the engine broker is adopted. Once adopted, execution and model
  // lifecycle route through the broker rather than this overlay.
  // Spawned children inherit via `{ ...process.env }`; embedded reads it
  // directly. Operator-set values win.
  if (!process.env.GEZEL_SHARED_ASSETS_DIR) {
    const sharedAssets = systemSharedAssetsDir();
    if (sharedAssets) {
      process.env.GEZEL_SHARED_ASSETS_DIR = sharedAssets;
      opts.logger?.info?.(`[supervisor] machine asset overlay: ${sharedAssets}`);
    }
  }
  if (!process.env.GEZEL_SD_SERVER_BIN) {
    const bin = resolveNativeBinaryPath('sd-server', import.meta.url);
    if (bin) {
      process.env.GEZEL_SD_SERVER_BIN = bin;
      opts.logger?.info?.(`[supervisor] bundled sd-server: ${bin}`);
    }
  }
  if (!process.env.GEZEL_LLAMA_SERVER_BIN) {
    // Phase 2: pick the right per-host variant (CUDA / Vulkan /
    // Metal / CPU) before resolving the binary. The probe is
    // memoized at <home>/engines/llama-cpp/backend.json so we only
    // pay the filesystem walk once per engine-version bump.
    //
    // User can override the auto-detect via
    // `config.llamaCppBackendOverride` — useful for downgrading from
    // CUDA→Vulkan→CPU when a user's CUDA install is broken. Read
    // config.json directly: the service hasn't started yet, so we
    // can't use the API. Tolerant of missing/malformed config.
    const override = await readBackendOverride(opts.home);
    const probe = detectLlamaBackend({
      engineVersion: LLAMA_ENGINE_VERSION,
      home: opts.home,
      ...(override ? { override } : {}),
    });
    // Always publish the hardware-detected backend, even when no
    // bundled binary matches it. The Settings UI uses this to populate
    // the dropdown — without it, picking `cpu` on a CUDA machine would
    // hide CUDA from the menu and the user couldn't switch back without
    // hand-editing config.json. Decoupled from the override so the dev's
    // pin doesn't lie about what the box can do.
    process.env.GEZEL_LLAMA_DETECTED_BACKEND = probe.detectedBackend;
    // Vendor hint is independent of the backend pick — a Radeon user
    // on the Vulkan backend gets `vendorHint='amd'` so the Home tab
    // can label the engine "AMD GPU" instead of the generic "GPU."
    // Undefined when no GPU vendor could be identified (headless
    // container, macOS).
    if (probe.vendorHint) {
      process.env.GEZEL_LLAMA_DETECTED_VENDOR = probe.vendorHint;
    }
    // Same quarantine the daemon's own discovery consults. It has to be
    // applied HERE too: once this branch stamps GEZEL_LLAMA_SERVER_BIN,
    // `discoverNativeBinaries` treats the binary as pre-set and skips its
    // resolution entirely — so spawn and embedded launches would keep
    // relaunching a build already known to crash on this machine.
    const quarantine = readLlamaQuarantine(opts.home);
    const resolved = resolveAvailableLlamaBinary(
      probe.backend,
      (backend) => resolveNativeBinaryPath('llama-server', import.meta.url, backend),
      override === undefined || override === 'auto',
      quarantine.length > 0
        ? (backend, path) => !isBinaryQuarantined(quarantine, backend, path)
        : undefined,
    );
    if (resolved) {
      process.env.GEZEL_LLAMA_SERVER_BIN = resolved.path;
      process.env.GEZEL_LLAMA_SERVER_BACKEND = resolved.backend;
      for (const skipped of resolved.skippedUnusable ?? []) {
        const entry = quarantine.find((e) => e.backend === skipped);
        opts.logger?.warn?.(
          `[supervisor] llama-server ${skipped} build is quarantined on this machine ` +
            `(${entry?.signal ?? 'crashed'}): ${entry?.reason ?? 'crashed before becoming ready'}`,
        );
      }
      if (resolved.skippedUnusable?.length) {
        process.env.GEZEL_LLAMA_QUARANTINED = resolved.skippedUnusable.join(',');
      }
      if (resolved.fallbackFrom && !resolved.skippedUnusable?.length) {
        opts.logger?.info?.(
          `[supervisor] no bundled llama-server for ${resolved.fallbackFrom}; using ${resolved.backend} fallback: ${resolved.path}`,
        );
      }
      opts.logger?.info?.(
        `[supervisor] bundled llama-server (${resolved.backend}${probe.cached ? ', cached' : ''}${override && override !== 'auto' ? `, override=${override}, detected=${probe.detectedBackend}` : ''}): ${resolved.path}`,
      );
    } else {
      opts.logger?.info?.(
        `[supervisor] no llama-server binary bundled for ${probe.backend} (${probe.reason}) — provider will require external GEZEL_LLAMA_SERVER_URL`,
      );
    }
  }
  if (!process.env.GEZEL_WHISPER_SERVER_BIN) {
    const bin = resolveNativeBinaryPath('whisper-server', import.meta.url);
    if (bin) {
      process.env.GEZEL_WHISPER_SERVER_BIN = bin;
      opts.logger?.info?.(`[supervisor] bundled whisper-server: ${bin}`);
    }
  }
  if (!process.env.GEZEL_UV_BIN) {
    // uv is the shared Python bootstrap used by MLX (and any future
    // Python-based feature). The service's UvRuntime prefers this
    // bundled binary so packaged builds never probe macOS's developer-
    // tools `python3` shim. System runtimes are source/dev fallbacks.
    const bin = resolveNativeBinaryPath('uv', import.meta.url);
    if (bin) {
      process.env.GEZEL_UV_BIN = bin;
      opts.logger?.info?.(`[supervisor] bundled uv: ${bin}`);
    }
  }
  if (!process.env.GEZEL_DUCKDB_BIN) {
    // DuckDB is the query engine for observation corpora — the tabular
    // connector shape. The service spawns it as a short-lived child per
    // query; without this the corpus is still on disk and still readable,
    // the query tools just report the engine as unavailable.
    //
    // Unlike the engines above it does NOT come from native-bin/: DuckDB is
    // vendored unmodified from the DuckDB Foundation's own signed, notarized
    // release, so it ships as a bundled runtime beside node and pnpm rather
    // than as an artifact of our native build. Installing it into the
    // version-keyed directory the service's engine resolver also uses means a
    // machine with both the desktop app and an npm `gezeld` shares one copy.
    try {
      if (runInPlace) {
        // No copy into the home, for the same reason node and pnpm skip it —
        // and DuckDB has a second reason: it ships vendor-signed and is
        // re-signed with our identity by the MAS lane, so the bytes here are
        // already the ones the sandbox will accept. A copy would only be a
        // second place for that to go wrong.
        const duckdb = await resolveRuntimeInPlace({
          bundleDir: defaultDuckdbBundleDir(import.meta.url),
          entry: 'duckdb',
          logger: opts.logger,
        });
        if (duckdb.path && duckdb.verified) {
          process.env.GEZEL_DUCKDB_BIN = duckdb.path;
        } else {
          opts.logger?.warn?.(
            `[supervisor] bundled duckdb unavailable in place (${duckdb.reason ?? 'unverified'}); data features report the engine as unavailable`,
          );
        }
      } else {
        const installed = await installDuckdbIfNeeded({
          home: opts.home,
          bundleDir: defaultDuckdbBundleDir(import.meta.url),
          ...(opts.logger ? { logger: opts.logger } : {}),
        });
        if (installed.binaryPath) {
          process.env.GEZEL_DUCKDB_BIN = installed.binaryPath;
          opts.logger?.info?.(
            `[supervisor] bundled duckdb v${installed.version} (${installed.action}): ${installed.binaryPath}`,
          );
        }
      }
    } catch (err) {
      // Never fatal: the daemon boots and the data features report the engine
      // as unavailable, which is a far better outcome than refusing to start
      // over a subsystem most projects never touch.
      opts.logger?.warn?.(`[supervisor] duckdb install failed: ${String(err)}`);
    }
  }

  const mode = await resolveMode({
    home: opts.home,
    packaged: opts.packaged,
    devSpawn: opts.devSpawn,
    forceEmbedded: opts.forceEmbedded,
    logger: opts.logger,
    ...(opts.storeProfile ? { storeProfile: true } : {}),
  });

  return connectResolved(opts, mode, { inheritedReason: null, allowMachineRecheck: true });
}

/**
 * State threaded through the mode dispatch so a deliberate machine-service
 * decline (fresh machine home) carries its notice into whichever per-user
 * branch ends up serving, and so the pre-spawn machine re-check cannot
 * bounce straight back to a service we just declined.
 */
interface ConnectFlow {
  inheritedReason: ServiceFallbackReason | null;
  allowMachineRecheck: boolean;
}

async function connectResolved(
  opts: ConnectOptions,
  mode: Mode,
  flow: ConnectFlow,
): Promise<SupervisedService> {
  if (mode.kind === 'remote') {
    await probeRemote(mode.baseUrl, mode.token);
    return new SupervisedService('remote', mode.baseUrl, mode.token, mode.cert, opts);
  }

  if (mode.kind === 'store-connect') {
    return connectStoreService(opts, mode);
  }

  if (mode.kind === 'system-service') {
    // The Windows / macOS / Linux installer registered gezeld as a system
    // service and the OS service manager says it is running or starting.
    // Wait (bounded) for healthy runtime discovery instead of failing on
    // the first read — the installer launches the app well before the
    // service publishes its role/files. Waiting avoids an account-local model
    // launch just before the shared engine becomes available.
    const outcome = await connectSystemService(opts, mode);
    if (outcome.kind === 'connected') return outcome.service;
    if (outcome.kind === 'engine-ready' || outcome.kind === 'per-user-selected') {
      // The renderer never talks to the cross-account broker. Start/adopt the
      // user's product daemon; it discovers the verified broker through the
      // runtime-only inference bridge.
      const perUser = await resolvePerUserMode({
        home: opts.home,
        packaged: opts.packaged,
        devSpawn: opts.devSpawn,
        forceEmbedded: opts.forceEmbedded,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      return connectResolved(opts, perUser, {
        inheritedReason: null,
        allowMachineRecheck: false,
      });
    }
    if (outcome.kind === 'prefer-per-user') {
      const perUser = await resolvePerUserMode({
        home: opts.home,
        packaged: opts.packaged,
        devSpawn: opts.devSpawn,
        forceEmbedded: opts.forceEmbedded,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      return connectResolved(opts, perUser, {
        inheritedReason: outcome.reason,
        allowMachineRecheck: false,
      });
    }
    opts.logger?.warn?.(
      `[supervisor] machine service at ${mode.serviceHome} did not become healthy (${outcome.message}); falling back to embedded`,
    );
    if (outcome.serviceRole === 'machine-engine') {
      const perUser = await resolvePerUserMode({
        home: opts.home,
        packaged: opts.packaged,
        devSpawn: opts.devSpawn,
        forceEmbedded: opts.forceEmbedded,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      return connectResolved(opts, perUser, {
        inheritedReason: {
          code: 'machine-engine-unavailable',
          sourceMode: 'system-service',
          message: `The shared model engine was unavailable: ${outcome.message}. Gezel is using this account's service and will retry the engine automatically.`,
        },
        allowMachineRecheck: false,
      });
    }
    return buildEmbedded(opts, {
      code: 'system-service-unhealthy',
      sourceMode: 'system-service',
      message: `System service was unavailable: ${outcome.message}`,
    });
  }

  if (mode.kind === 'local-adopt') {
    let candidate: LocalAdoptRuntime = mode;
    let adopted:
      | {
          health: Awaited<ReturnType<GezelClient['health']>>;
          runtime: LocalAdoptRuntime;
        }
      | undefined;
    let healthError: unknown;

    // adoptedDaemonHealth refreshes runtime metadata after every failed probe.
    // Re-read once more at its failure boundary before authorizing a stop: the
    // daemon may have rotated its token/certificate between the helper's final
    // read and this branch.
    for (;;) {
      try {
        adopted = await adoptedDaemonHealth(
          candidate,
          opts,
          opts.adoptHealthWaitMs ?? ADOPT_HEALTH_WAIT_MS,
        );
        break;
      } catch (err) {
        const failedRuntime = err instanceof AdoptedDaemonHealthError ? err.runtime : candidate;
        const latest = await readRuntime(opts.home);
        if (latest && isProcessAlive(latest.pid) && !sameLocalRuntime(latest, failedRuntime)) {
          opts.logger?.info?.(
            `[supervisor] adopted daemon runtime changed at the health deadline; checking pid=${latest.pid} with the newly published credentials`,
          );
          candidate = latest;
          continue;
        }
        candidate = failedRuntime;
        healthError = err;
        break;
      }
    }

    if (!adopted) {
      if (isProcessAlive(candidate.pid)) {
        // Getting here now means the daemon had ADOPT_HEALTH_WAIT_MS to answer
        // and never did, so it is wedged rather than busy — the patient poll in
        // adoptedDaemonHealth already absorbed the slow-boot case that made
        // this branch fire spuriously after an upgrade.
        //
        // Never run two writers against one home, but a wedged daemon is not
        // serving anyone, so refusing outright left the app with nothing at
        // all. The two branches above (packaged version mismatch, dev
        // staleness) already stop the process they cannot use; do the same
        // here, and only refuse if it survives the bounded stop ladder.
        opts.logger?.warn?.(
          `[supervisor] adopted daemon pid=${candidate.pid} is alive but failing health checks; stopping it before starting a replacement`,
        );
        const stopped = await stopProcessByPid(candidate.pid, opts.logger);
        if (!stopped) {
          opts.logger?.error?.(
            `[supervisor] adopted daemon pid=${candidate.pid} survived the stop ladder; refusing a second writer`,
          );
          throw new Error(
            `Adopted gezeld pid=${candidate.pid} is unhealthy and did not exit when asked; refusing to start a second writer for the same home`,
            { cause: healthError },
          );
        }
        opts.logger?.warn?.(
          '[supervisor] stopped the unhealthy adopted daemon; falling back to embedded',
        );
        return buildEmbedded(opts, {
          code: 'adopted-daemon-unhealthy',
          sourceMode: 'local-adopt',
          message: `The adopted daemon was unhealthy and was stopped: ${errorMessage(healthError)}`,
        });
      }
      opts.logger?.warn?.(
        `[supervisor] adopted daemon health check failed after pid=${candidate.pid} exited: ${errorMessage(healthError)}; falling back to embedded`,
      );
      return buildEmbedded(opts, {
        code: 'adopted-daemon-unhealthy',
        sourceMode: 'local-adopt',
        message: `The adopted daemon was unavailable: ${errorMessage(healthError)}`,
      });
    }

    const { health, runtime } = adopted;
    // Version negotiation: in packaged mode, only adopt a running daemon
    // whose version matches what we ship. A version mismatch almost
    // always means an autostart daemon is pinned at an older release —
    // adopting it would have the new Electron UI talking to old service
    // code, which is worse than just restarting it.
    if (opts.packaged) {
      const shipped = await shippedServiceVersion();
      if (shipped && health.version !== shipped) {
        opts.logger?.warn?.(
          `[supervisor] running daemon is v${health.version}, shipped is v${shipped}; stopping it and respawning`,
        );
        // Stop the outdated daemon before respawning so the user doesn't
        // end up with two gezeld instances racing for the same `~/.gezel/`
        // state. This is the ONE situation where we stop a pid we didn't
        // spawn — justified because the version check just told us it's
        // stale. On Windows the stop covers its full descendant tree.
        // Phase 2 will coordinate with autostart cleanly;
        // for now the autostart may restart the old one on the next
        // login cycle, which is acceptable for a skeleton.
        const stopped = await stopProcessByPid(runtime.pid, opts.logger);
        if (!stopped) {
          throw new Error(
            `Stale gezeld pid=${runtime.pid} did not exit after the bounded stop ladder; refusing to spawn another writer`,
          );
        }
        return await respawnPackagedAfterMismatch(opts);
      }
    } else {
      // Dev-mode staleness check: compare the workspace
      // `service/dist/index.js` mtime to the daemon's pid-file mtime
      // (a proxy for "when this daemon was started"). If the workspace
      // build is newer, the user just rebuilt — the running daemon is
      // executing stale TS, so adopting it would have the new UI talking
      // to old service code. Stop it and fall through to embedded.
      // Without this, `pnpm app` (which always runs `pnpm build` first)
      // can silently use a daemon that doesn't reflect the just-built
      // code, exactly the failure that surfaced when iterating on the
      // salvage layer.
      const stale = await isAdoptDaemonStaleForDev(opts.home, opts.logger);
      if (stale) {
        opts.logger?.warn?.(
          `[supervisor] dev daemon at pid=${runtime.pid} is older than the latest workspace build; stopping it and falling back to embedded`,
        );
        const stopped = await stopProcessByPid(runtime.pid, opts.logger);
        if (!stopped) {
          throw new Error(
            `Stale development gezeld pid=${runtime.pid} did not exit after the bounded stop ladder; refusing embedded startup`,
          );
        }
        return buildEmbedded(opts, {
          code: 'adopted-daemon-stale',
          sourceMode: 'local-adopt',
          message: 'The adopted development daemon was stale and was stopped',
        });
      }
    }
    return new SupervisedService(
      'local-adopt',
      runtime.baseUrl,
      runtime.token,
      runtime.cert,
      opts,
      {
        fallbackReason: flow.inheritedReason ?? (await machineServiceMissing(opts, 'local-adopt')),
      },
    );
  }

  if (mode.kind === 'local-spawn-packaged') {
    // Last look before creating the user product daemon: bundle extraction and
    // the steps above take real time, and the machine service may have finished
    // publishing its runtime in the meantime (mode resolution's SCM query
    // can also have answered `unknown` on a machine where sc/systemctl is
    // unavailable). A split engine is probed but still returns here so the
    // user daemon starts; a legacy full-product daemon may still be adopted.
    if (flow.allowMachineRecheck) {
      const adopted = await lateMachineServiceCheck(opts);
      if (adopted) return adopted;
    }
    try {
      const result = await spawnChildFromInstall(opts);
      const svc = new SupervisedService(
        'local-spawn-packaged',
        result.baseUrl,
        result.token,
        result.cert,
        opts,
        {
          fallbackReason:
            flow.inheritedReason ?? (await machineServiceMissing(opts, 'local-spawn-packaged')),
        },
      );
      svc.attachSpawned(result.child);
      return svc;
    } catch (err) {
      if (isLiveDaemonUnhealthyError(err)) throw err;
      opts.logger?.warn?.(
        `[supervisor] packaged spawn failed: ${(err as Error).message}; falling back to embedded`,
      );
      return buildEmbedded(opts, {
        code: 'packaged-spawn-failed',
        sourceMode: 'local-spawn-packaged',
        message: `The packaged background service could not start: ${(err as Error).message}`,
      });
    }
  }

  if (mode.kind === 'local-spawn-dev') {
    try {
      const result = await spawnChild(opts);
      const svc = new SupervisedService(
        'local-spawn-dev',
        result.baseUrl,
        result.token,
        result.cert,
        opts,
      );
      svc.attachSpawned(result.child);
      return svc;
    } catch (err) {
      if (isLiveDaemonUnhealthyError(err)) throw err;
      opts.logger?.warn?.(
        `[supervisor] dev spawn failed: ${(err as Error).message}; falling back to embedded`,
      );
      return buildEmbedded(opts, {
        code: 'dev-spawn-failed',
        sourceMode: 'local-spawn-dev',
        message: `The development background service could not start: ${(err as Error).message}`,
      });
    }
  }

  return buildEmbedded(opts, flow.inheritedReason);
}

type SystemServiceOutcome =
  | { kind: 'connected'; service: SupervisedService }
  | { kind: 'engine-ready' }
  | { kind: 'per-user-selected' }
  | { kind: 'prefer-per-user'; reason: ServiceFallbackReason }
  | {
      kind: 'unhealthy';
      message: string;
      serviceRole?: 'user' | 'machine-engine' | 'legacy-full';
    };

/**
 * Connect to the machine service, waiting (when the SCM said it is running
 * or starting) for it to publish healthy runtime discovery. Re-reads the
 * runtime files on every attempt — the auth token rotates per service
 * start, so a snapshot taken mid-boot can be one generation stale.
 */
async function connectSystemService(
  opts: ConnectOptions,
  mode: Extract<Mode, { kind: 'system-service' }>,
): Promise<SystemServiceOutcome> {
  const deadline = Date.now() + (mode.waitForStartup ? MACHINE_SERVICE_STARTUP_WAIT_MS : 0);
  let lastError = 'runtime discovery files are not published yet';
  let observedRole: SystemServiceRuntime['serviceRole'];
  let waitingAnnounced = false;
  for (;;) {
    const runtime = await readSystemServiceRuntime(mode.serviceHome);
    if (runtime) {
      observedRole = runtime.serviceRole;
      if (runtime.serviceRole === 'machine-engine') {
        try {
          await probeMachineEngine(runtime);
          opts.logger?.info?.(
            `[supervisor] machine engine is ready at ${runtime.baseUrl}; using a per-user product daemon`,
          );
          return { kind: 'engine-ready' };
        } catch (err) {
          lastError = (err as Error).message;
        }
      } else {
        if (mode.hostingPin === 'per-user') {
          opts.logger?.info?.(
            '[supervisor] hosting pin=per-user — using the user daemon instead of the legacy machine product daemon',
          );
          return { kind: 'per-user-selected' };
        }
        const client = buildHealthClient(runtime.baseUrl, runtime.token, runtime.cert);
        try {
          const health = await healthWithTimeout(client);
          const preference = await decideHomePreference(opts, client, mode.hostingPin);
          if (preference) return { kind: 'prefer-per-user', reason: preference };
          opts.logger?.info?.(`[supervisor] connected to system service at ${runtime.baseUrl}`);
          const versionSkew = await systemServiceVersionSkew(
            health.version,
            mode.serviceHome,
            opts,
          );
          const legacyMachineData: ServiceFallbackReason | null =
            runtime.serviceRole === 'legacy-full'
              ? {
                  code: 'legacy-machine-data',
                  sourceMode: 'system-service',
                  message:
                    'Gezel preserved an established machine-wide product home in compatibility mode. Its projects remain available, but arbitrary user-owned folders still use the older restricted service boundary until they are migrated.',
                }
              : null;
          return {
            kind: 'connected',
            service: new SupervisedService(
              'system-service',
              runtime.baseUrl,
              runtime.token,
              runtime.cert,
              opts,
              {
                systemServiceHome: mode.serviceHome,
                fallbackReason: versionSkew ?? legacyMachineData,
              },
            ),
          };
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
    }
    if (Date.now() >= deadline) {
      if (mode.hostingPin === 'per-user' && observedRole !== 'machine-engine') {
        return { kind: 'per-user-selected' };
      }
      return {
        kind: 'unhealthy',
        message: lastError,
        ...(observedRole ? { serviceRole: observedRole } : {}),
      };
    }
    if (!waitingAnnounced) {
      waitingAnnounced = true;
      opts.logger?.info?.(
        `[supervisor] machine service is starting; waiting up to ${Math.round(
          MACHINE_SERVICE_STARTUP_WAIT_MS / 1000,
        )}s for it to publish a healthy runtime...`,
      );
    }
    await sleepMs(MACHINE_SERVICE_STARTUP_POLL_MS);
  }
}

/** Verify the exact inference-only endpoint the user daemon will consume. */
async function probeMachineEngine(runtime: SystemServiceRuntime): Promise<void> {
  const fetchImpl = runtime.cert ? createTrustingFetch({ cert: runtime.cert }) : fetch;
  const response = await fetchImpl(`${runtime.baseUrl}/v1/remote/models`, {
    headers: { Authorization: `Bearer ${runtime.token}` },
    signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
  });
  try {
    if (!response.ok) {
      throw new Error(`machine inference probe returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) {
      throw new Error('machine inference probe returned an invalid model response');
    }
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/**
 * Should this launch decline a healthy machine service in favor of the
 * per-user home? Only when the evidence is unambiguous: the user's home
 * has real work in it (gezels/projects/sessions beyond the auto-created
 * baseline) while the machine home has never been used. Adopting the
 * machine service in that state presents an empty app with the user's
 * actual data stranded in `~/.gezel` — the worst possible first
 * impression after an update.
 *
 * The decision is persisted as `hosting: 'per-user'` so later launches
 * skip the machine service (and its startup wait) outright; Settings →
 * Daemon is the way back. An explicit `'machine-service'` pin disables
 * the check entirely. Any probe failure — including a daemon predating
 * `GET /api/system/home` — keeps today's behavior of connecting.
 */
async function decideHomePreference(
  opts: ConnectOptions,
  client: GezelClient,
  hostingPin: 'auto' | 'machine-service',
): Promise<ServiceFallbackReason | null> {
  if (hostingPin === 'machine-service') return null;
  const local = await readHomeUsageSignals(opts.home);
  if (!local.everUsed) return null;
  let machineUsed: boolean;
  let machineHome = 'the machine service home';
  try {
    const info = await client.getSystemHomeInfo();
    machineUsed = info.usage.everUsed;
    machineHome = info.home;
  } catch (err) {
    opts.logger?.info?.(
      `[supervisor] machine home-info probe unavailable (${(err as Error).message}); staying on the machine service`,
    );
    return null;
  }
  if (machineUsed) return null;
  const pinned = await writeHostingPin(opts.home, 'per-user');
  opts.logger?.warn?.(
    `[supervisor] machine service home at ${machineHome} has never been used, while ` +
      `${opts.home} holds ${local.gezelCount} gezels / ${local.projectCount} projects — ` +
      `staying on the per-user daemon${pinned ? " (pinned hosting='per-user')" : ''}`,
  );
  return {
    code: 'machine-service-home-fresh',
    sourceMode: 'system-service',
    message:
      'The machine-wide background service is healthy but its data home has never been used, ' +
      `while this account's per-user home has your gezellen and projects. Gezel connected to ` +
      'your per-user data and will keep doing so; change Hosting in Settings to switch.',
  };
}

/**
 * Pre-spawn re-check: discover a machine service that published after mode
 * resolution. A split engine is only probed (the caller still starts its user
 * daemon); a legacy full-product daemon may be adopted under its compatibility
 * hosting preference.
 */
async function lateMachineServiceCheck(opts: ConnectOptions): Promise<SupervisedService | null> {
  if (!opts.packaged) return null;
  const sysHome = systemServiceHome();
  if (!sysHome) return null;
  const pin = await readHostingPin(opts.home);
  const runtime = await readSystemServiceRuntime(sysHome);
  if (!runtime) return null;
  if (pin === 'per-user' && runtime.serviceRole !== 'machine-engine') return null;
  opts.logger?.info?.(
    '[supervisor] machine service published its runtime while preparing the user daemon; probing its declared role',
  );
  const outcome = await connectSystemService(opts, {
    kind: 'system-service',
    serviceHome: sysHome,
    runtime,
    waitForStartup: false,
    hostingPin: pin,
  });
  return outcome.kind === 'connected' ? outcome.service : null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shippedServiceVersion(): Promise<string | null> {
  try {
    const { metaPath } = defaultBundlePaths(import.meta.url);
    const meta = await readBundleMeta(metaPath);
    return meta?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Dev-mode adopt staleness check: returns true when the running daemon
 * was started before the latest workspace build of
 * `@bendyline/gezel-service`. Used to short-circuit local-adopt and
 * fall back to embedded so the user never silently runs against
 * out-of-date service code after `pnpm app` rebuilds.
 *
 * The "daemon start time" proxy is the pid file's mtime — gezeld
 * writes `<home>/runtime/pid` once at startup. The "workspace build
 * time" proxy is the mtime of the resolved
 * `@bendyline/gezel-service/dist/index.js`. If we can't resolve either
 * file (cold workspace, paths package didn't load, etc), we
 * conservatively return false and let adopt proceed — the staleness
 * check is a UX optimization, not a correctness guard.
 */
async function isAdoptDaemonStaleForDev(
  home: string,
  logger?: ConnectOptions['logger'],
): Promise<boolean> {
  try {
    const pidPath = gezelPaths(home).runtime.pid;
    let workspaceServicePath: string;
    try {
      const requireFromHere = createRequire(import.meta.url);
      workspaceServicePath = requireFromHere.resolve('@bendyline/gezel-service');
    } catch {
      // Service package not resolvable (shouldn't happen in dev — it's
      // a workspace dep — but bail safely if it does).
      return false;
    }
    const [pidStat, serviceStat] = await Promise.all([
      stat(pidPath).catch(() => null),
      stat(workspaceServicePath).catch(() => null),
    ]);
    if (!pidStat || !serviceStat) return false;
    const isStale = serviceStat.mtimeMs > pidStat.mtimeMs;
    if (isStale) {
      logger?.info?.(
        `[supervisor] workspace service mtime ${new Date(serviceStat.mtimeMs).toISOString()} > daemon pid mtime ${new Date(pidStat.mtimeMs).toISOString()}`,
      );
    }
    return isStale;
  } catch (err) {
    logger?.warn?.(
      `[supervisor] dev staleness check failed (will adopt): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Version negotiation for an adopted machine service. Returns the banner
 * reason when the daemon and this app disagree, or null when they match.
 *
 * The system service runs gezeld out of the installer-owned tree
 * (`/Library/Application Support/Gezel/service`, `C:\ProgramData\Gezel\
 * service`, `/var/lib/gezel/service`), and the platform installer is the
 * only thing that ever writes it — `extractBundleIfNeeded` targets
 * `gezelPaths(opts.home).install`, the per-user tree, and never runs on
 * this branch. An app-only update therefore leaves the daemon behind:
 * electron-updater hands Squirrel.Mac a new .app, the shell and the
 * bundled UI move forward, and gezeld keeps executing the previous
 * release's code. Before this check the mismatch was invisible.
 *
 * Unlike `local-adopt` below, we cannot repair it. That branch SIGTERMs
 * the stale pid and respawns from our own bundle; here the process belongs
 * to launchd / systemd / the SCM under a service account, we have no
 * permission to stop it, the service manager would restart it anyway, and
 * what it re-executed would be the same root-owned tree.
 *
 * Falling back to embedded would be worse than the skew rather than
 * better: the machine service reads the system-scope home, while an
 * embedded boot comes up against `opts.home` (`~/.gezel`). Every gezel,
 * project, and session the user has would appear to vanish. So we stay
 * connected and say plainly that the installer needs to run again.
 *
 * Packaged only. In dev the workspace version moves constantly and any
 * system service present is a leftover from a real install, so firing
 * there would be noise. Also null when our own bundle metadata is
 * unreadable — same conservative stance `local-adopt` takes.
 */
async function systemServiceVersionSkew(
  daemonVersion: string,
  serviceHome: string,
  opts: ConnectOptions,
): Promise<ServiceFallbackReason | null> {
  if (!opts.packaged) return null;
  const shipped = await shippedServiceVersion();
  if (!shipped || daemonVersion === shipped) return null;
  opts.logger?.warn?.(
    `[supervisor] system service at ${serviceHome} is v${daemonVersion} but this app ships ` +
      `v${shipped}; staying connected (its tree is installer-owned) and flagging it in the UI`,
  );
  return {
    code: 'system-service-version-mismatch',
    sourceMode: 'system-service',
    message:
      `The Gezel background service is running version ${daemonVersion}, but this copy of ` +
      `Gezel expects version ${shipped}. Its files at ${serviceHome} are only replaced by the installer.`,
  };
}

/**
 * The per-user product daemon is healthy, but the installer failed to
 * register the shared machine engine and said so in the registry.
 *
 * Worth a notice even though the product data path is healthy: model
 * downloads, engine residency, and GPU/RAM queues are no longer shared with
 * other accounts on the machine. Only the installer can repair that broker.
 *
 * Packaged only, and only on a positive `MachineServiceInstalled = 0`. See
 * machine-service-state.ts for why absence is never treated as failure.
 */
async function machineServiceMissing(
  opts: ConnectOptions,
  sourceMode: ConnectionMode,
): Promise<ServiceFallbackReason | null> {
  if (!opts.packaged) return null;
  if (!(await machineServiceInstallFailed())) return null;
  opts.logger?.warn?.(
    '[supervisor] the installer recorded a failed GezelService registration; ' +
      'running engines through the per-user daemon and flagging it in the UI',
  );
  return {
    code: 'machine-service-not-installed',
    sourceMode,
    message:
      'The Gezel installer could not register the shared machine model engine, ' +
      'so this account is running local engines itself instead.',
  };
}

/**
 * Packaged-mode version mismatch: the running daemon is pinned at an old
 * release. Try to respawn — this will extract our newer bundle and launch
 * it fresh. Falls through to embedded if the respawn itself fails.
 */
async function respawnPackagedAfterMismatch(opts: ConnectOptions): Promise<SupervisedService> {
  try {
    const result = await spawnChildFromInstall(opts);
    const svc = new SupervisedService(
      'local-spawn-packaged',
      result.baseUrl,
      result.token,
      result.cert,
      opts,
    );
    svc.attachSpawned(result.child);
    return svc;
  } catch (err) {
    if (isLiveDaemonUnhealthyError(err)) throw err;
    opts.logger?.warn?.(
      `[supervisor] post-mismatch respawn failed: ${(err as Error).message}; falling back to embedded`,
    );
    return buildEmbedded(opts, {
      code: 'version-mismatch-respawn-failed',
      sourceMode: 'local-adopt',
      message: `The updated background service could not start: ${(err as Error).message}`,
    });
  }
}

/**
 * Connect a store build to the daemon a direct-download install is running,
 * or start our own when that daemon cannot be adopted.
 *
 * Shaped after the `remote` branch — probe only, never manage — rather than
 * after `local-adopt`, which stops and respawns a version-mismatched daemon.
 * That behavior is right for a daemon the same install spawned and wrong for
 * another product's service: a store build cannot signal one under the macOS
 * sandbox, and should not on Windows either.
 *
 * Every failure here lands in the same place: our own embedded service. That
 * is a complete product, not a degraded one — the only thing lost is sharing a
 * single daemon (and its resident models) with the other install, which is
 * what the notice explains.
 */
async function connectStoreService(
  opts: ConnectOptions,
  mode: Extract<Mode, { kind: 'store-connect' }>,
): Promise<SupervisedService> {
  const client = buildHealthClient(mode.baseUrl, mode.token, mode.cert);
  let health: HealthResponse;
  try {
    health = await healthWithTimeout(client);
  } catch (error) {
    // Rendezvous files outlive the daemon that wrote them — it may have been
    // stopped or have crashed. Nothing to clean up: they are the other
    // install's to manage, and it rewrites them on its next start.
    opts.logger?.info?.(
      `[supervisor] installed Gezel service did not answer (${(error as Error).message}); starting our own`,
    );
    return buildEmbedded(opts, {
      code: 'store-service-unhealthy',
      sourceMode: 'store-connect',
      message: 'the installed Gezel service is not responding, so this app started its own',
    });
  }

  const verdict = evaluateStoreCompat(health);
  if (!verdict.compatible) {
    opts.logger?.info?.(`[supervisor] declining the installed Gezel service: ${verdict.reason}`);
    return buildEmbedded(opts, {
      code: 'store-service-incompatible',
      sourceMode: 'store-connect',
      message: `This app started its own Gezel service because ${verdict.reason}.`,
    });
  }

  opts.logger?.info?.(
    `[supervisor] adopted the installed Gezel service ${health.version} at ${mode.baseUrl}`,
  );
  return new SupervisedService('store-connect', mode.baseUrl, mode.token, mode.cert, opts);
}

async function buildEmbedded(
  opts: ConnectOptions,
  fallbackReason: ServiceFallbackReason | null = null,
): Promise<SupervisedService> {
  // Two-step bind so the service can call back into the eventually-
  // constructed SupervisedService for restart requests. The closure
  // captures `svc` after construction; until then, restart requests
  // are dropped (boot-time requests aren't a meaningful case anyway).
  let svc: SupervisedService | null = null;
  const embedded = await startEmbeddedRaw(opts, (reason) => {
    svc?.emit('restart-requested', reason);
  });
  svc = new SupervisedService('embedded', embedded.baseUrl, embedded.token, embedded.cert, opts, {
    fallbackReason,
  });
  svc.attachEmbedded(embedded.stop);
  return svc;
}

/**
 * GezelClient wired with the trusting fetch when the daemon is serving
 * HTTPS — keeps the cert plumbing concentrated in one place so each
 * mode-branch reads identically.
 */
function buildHealthClient(baseUrl: string, token: string, cert: string | null): GezelClient {
  if (cert) {
    return new GezelClient({ baseUrl, token, fetch: createTrustingFetch({ cert }) });
  }
  return new GezelClient({ baseUrl, token });
}

/**
 * Health endpoints must be short-lived even though the shared TLS fetch is
 * intentionally patient for long-running model/tool requests. The explicit
 * rejection race also bounds injected fetches that fail to observe abort.
 */
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
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class AdoptedDaemonHealthError extends Error {
  constructor(
    cause: unknown,
    readonly runtime: LocalAdoptRuntime,
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'AdoptedDaemonHealthError';
  }
}

function sameLocalRuntime(a: LocalAdoptRuntime, b: LocalAdoptRuntime): boolean {
  return a.pid === b.pid && a.baseUrl === b.baseUrl && a.token === b.token && a.cert === b.cert;
}

export async function adoptedDaemonHealth(
  initialRuntime: LocalAdoptRuntime,
  opts: Pick<ConnectOptions, 'home' | 'logger'>,
  budgetMs: number = ADOPT_HEALTH_WAIT_MS,
  pollMs: number = ADOPT_HEALTH_POLL_MS,
  alive: (pid: number) => boolean = isProcessAlive,
  readCurrent: typeof readRuntime = readRuntime,
): Promise<{
  health: Awaited<ReturnType<GezelClient['health']>>;
  runtime: LocalAdoptRuntime;
}> {
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
      await sleepMs(pollMs);
    }
  }
}

export async function healthWithTimeout(
  client: Pick<GezelClient, 'health'>,
  timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  controller = new AbortController(),
): Promise<Awaited<ReturnType<GezelClient['health']>>> {
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

async function probeRemote(baseUrl: string, token: string): Promise<void> {
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

/**
 * Resolve the tree the per-user daemon will run from, extracting only when we
 * cannot safely run from the one the installer already unpacked.
 *
 * Returns the directory, which the caller must pass to `spawnChildFromInstall`
 * rather than recomputing `gezelPaths(home).install` — the whole point is that
 * the answer is sometimes not that path.
 */
async function preparePackagedInstall(opts: ConnectOptions): Promise<string> {
  // The store lane on macOS ships the service tree unpacked and imports it
  // where it sits. Extracting a second copy of executable code into the
  // container is what guideline 2.4.5 describes, and the tarball's reason for
  // existing — Defender scanning every one of ~100k extracted files — is a
  // Windows problem that does not apply here.
  if (shouldRunRuntimesInPlace({ storeProfile: opts.storeProfile === true })) {
    const tree = inBundleServiceTree(import.meta.url);
    if (tree) {
      opts.logger?.info?.(`[supervisor] using the in-bundle service tree: ${tree}`);
      return tree;
    }
    // Falling through would extract into the container — correct bytes, wrong
    // shape for this channel. Fail loudly instead: a MAS build without its
    // unpacked tree is a packaging bug, and it is far better caught here than
    // discovered by a reviewer.
    throw new Error(
      'store build is missing its in-bundle service tree (dist/service-bundle); ' +
        'the MAS packaging lane must ship it unpacked',
    );
  }

  const { tarballPath, metaPath } = defaultBundlePaths(import.meta.url);
  const shared = await resolveSharedServiceTree({
    metaPath,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  if (shared) return shared;
  const installDir = gezelPaths(opts.home).install;
  await extractBundleIfNeeded({ installDir, tarballPath, metaPath, logger: opts.logger });
  return installDir;
}

async function spawnChildFromInstall(
  opts: ConnectOptions,
  options: { preparedInstallDir?: string } = {},
): Promise<{
  child: ChildProcess;
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number;
}> {
  // Bundle ships as a tarball + meta sidecar that electron-builder
  // asar-unpacks to `app.asar.unpacked/dist/service-bundle.tar.gz`.
  // Either the installer already unpacked it machine-wide (adopted as-is) or
  // we extract to the user's install dir when the shipped version is newer or
  // missing. See extract-bundle.ts and shared-service-tree.ts.
  const installDir = options.preparedInstallDir ?? (await preparePackagedInstall(opts));
  const daemonEntry = join(installDir, 'dist', 'bin', 'gezeld.js');
  // The spawned daemon's own `findBundledUi` (in service/bin/gezeld.ts)
  // looks adjacent to itself for the UI, but at this point gezeld lives
  // under `~/.gezel/service/` and the UI lives under
  // `app.asar.unpacked/dist/ui/` — different trees. Hand the daemon the
  // resolved UI path via env so it can serve `/`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEZEL_HOME: opts.home,
    GEZEL_SERVICE_ROLE: 'user',
  };
  if (opts.uiDir) env.GEZEL_UI_DIR = opts.uiDir;
  const result = await discoverOrSpawn({
    daemonEntry,
    detached: false,
    env,
    home: opts.home,
    logger: opts.logger,
    timeoutMs: PACKAGED_STARTUP_TIMEOUT_MS,
  });
  if (!result.child) {
    throw new Error('[supervisor] expected a spawned child, got an adopted daemon instead');
  }
  opts.logger?.info?.(`[supervisor] spawned packaged gezeld from ${installDir} pid=${result.pid}`);
  return {
    child: result.child,
    baseUrl: result.baseUrl,
    token: result.token,
    cert: result.cert,
    pid: result.pid,
  };
}

async function spawnChild(opts: ConnectOptions): Promise<{
  child: ChildProcess;
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number;
}> {
  const daemonEntry = resolveDaemonEntry(import.meta.url);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEZEL_HOME: opts.home,
    GEZEL_SERVICE_ROLE: 'user',
  };
  if (process.env.GEZEL_USE_MACHINE_ENGINE !== '1') {
    env.GEZEL_DISABLE_MACHINE_ENGINE = '1';
  }
  if (opts.uiDir) env.GEZEL_UI_DIR = opts.uiDir;
  const result = await discoverOrSpawn({
    daemonEntry,
    detached: false,
    env,
    home: opts.home,
    logger: opts.logger,
  });
  opts.logger?.info?.(
    `[supervisor] spawned gezeld pid=${result.pid} port=${new URL(result.baseUrl).port}`,
  );
  if (!result.child) {
    throw new Error('[supervisor] expected a spawned child, got an adopted daemon instead');
  }
  return {
    child: result.child,
    baseUrl: result.baseUrl,
    token: result.token,
    cert: result.cert,
    pid: result.pid,
  };
}

export interface StopProcessByPidOptions {
  graceMs?: number;
  pollIntervalMs?: number;
  platform?: NodeJS.Platform;
  isAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
  terminateWindowsTree?: (pid: number) => Promise<void>;
}

/**
 * Stop an adopted per-user daemon only on the two explicitly-authorized stale
 * version/build paths. On POSIX a signal is not evidence of exit: confirm
 * liveness and escalate once. On Windows, where signals are single-process
 * TerminateProcess calls, force-stop the whole descendant tree. Refuse the
 * next writer if the pid survives either bounded ladder.
 */
export async function stopProcessByPid(
  pid: number,
  logger: ConnectOptions['logger'],
  options: StopProcessByPidOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const alive = options.isAlive ?? isProcessAlive;
  if (!alive(pid)) return true;

  if (platform === 'win32') {
    logger?.warn?.(`[supervisor] force-stopping stale Windows gezeld tree pid=${pid}`);
  }
  return stopDaemonProcessByPid(pid, {
    graceMs: options.graceMs ?? GRACEFUL_STOP_MS,
    pollIntervalMs: options.pollIntervalMs,
    platform,
    isAlive: alive,
    signalProcess: options.signalProcess,
    terminateWindowsTree: options.terminateWindowsTree,
    logger,
  });
}

export async function gracefullyStop(
  child: ChildProcess | undefined,
  logger: ConnectOptions['logger'],
): Promise<void> {
  if (!child) return;
  logger?.info?.('[supervisor] stopping gezeld child...');
  await stopOwnedDaemon(child, logger, {
    graceMs: GRACEFUL_STOP_MS,
    forceMs: GRACEFUL_STOP_MS,
  });
  if (child.exitCode == null && child.signalCode == null) {
    throw new Error(
      `gezeld child did not confirm exit after the bounded stop ladder (pid=${child.pid ?? 'unknown'} killed=${child.killed} exitCode=null signalCode=null)`,
    );
  }
}

function assertNeverMode(mode: never): never {
  throw new Error(`Unhandled supervisor mode: ${String(mode)}`);
}

function isLiveDaemonUnhealthyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'LiveDaemonUnhealthyError';
}

async function startEmbeddedRaw(
  opts: ConnectOptions,
  onRestartRequested?: (reason: string) => void,
): Promise<{
  baseUrl: string;
  token: string;
  cert: string | null;
  stop: () => Promise<void>;
}> {
  // Load the service from the user-extracted service tree when a packaged
  // tarball ships, falling back to the bare specifier in dev (workspace
  // symlink). This deliberately avoids resolving `@bendyline/gezel-service`
  // through `app.asar/node_modules/`: electron-builder's pnpm dep walker
  // copies the service package into the asar but doesn't follow its
  // transitive deps (nearly 100 are missing), so any embedded boot from
  // there crashes with `ERR_MODULE_NOT_FOUND` on whichever transitive
  // gets imported first. The service-bundle is built by `pnpm deploy
  // --prod --legacy` and has a correct, self-contained tree — same shape
  // the spawned daemon uses.
  //
  // The tarball-on-disk approach unifies embedded and spawn paths: both
  // read the same extracted tree at `<home>/service/`. The first call to
  // extractBundleIfNeeded does the work; subsequent calls are no-ops when
  // the version matches.
  type ServiceModule = {
    startService: (o?: {
      uiDir?: string;
      home?: string;
      preferCanonicalPort?: boolean;
      role?: 'user' | 'machine-engine' | 'legacy-full';
      machineEngineDiscovery?: boolean;
      onRestartRequested?: (reason: string) => void;
    }) => Promise<{
      port: number;
      context: { token: string };
      clientToken?: string;
      cert: { certPem: string } | null;
      stop: () => Promise<void>;
    }>;
  };
  const { tarballPath, metaPath } = defaultBundlePaths(import.meta.url);
  let mod: ServiceModule;
  if (existsSync(tarballPath)) {
    // Same adopt-or-extract decision the spawn path makes: the embedded
    // fallback imports the tree instead of executing it as a child, but the
    // bytes and the trust question are identical.
    const installDir = await preparePackagedInstall(opts);
    const indexUrl = pathToFileURL(join(installDir, 'dist', 'index.js')).href;
    mod = (await import(indexUrl)) as ServiceModule;
  } else {
    mod = (await import('@bendyline/gezel-service')) as ServiceModule;
  }
  const running = await mod.startService({
    uiDir: opts.uiDir,
    home: opts.home,
    // The embedded desktop service is the daemon third-party clients
    // connect to — claim the canonical fixed port (with ephemeral
    // fallback) so it has a stable base URL.
    preferCanonicalPort: true,
    role: 'user',
    // Dev must exercise the provider code that `pnpm app` just built. The
    // installed release broker is deliberately opt-in for compatibility and
    // machine-boundary testing, not an implicit shadow runtime.
    machineEngineDiscovery: opts.packaged || process.env.GEZEL_USE_MACHINE_ENGINE === '1',
    onRestartRequested,
  });
  const scheme = running.cert ? 'https' : 'http';
  opts.logger?.info?.(
    `[supervisor] embedded service bound on ${scheme}://127.0.0.1:${running.port}`,
  );
  return {
    baseUrl: `${scheme}://127.0.0.1:${running.port}`,
    // Newer services expose a least-privilege first-party token. Keep the
    // root fallback only for compatibility with an older extracted dev
    // bundle; packaged bundles are version-locked to this supervisor.
    token: running.clientToken ?? running.context.token,
    cert: running.cert?.certPem ?? null,
    stop: () => running.stop(),
  };
}

/**
 * Read just the `llamaCppBackendOverride` field from `<home>/config.json`.
 * The supervisor runs before the service starts, so we can't use the
 * service API — direct file read is the only path. Tolerant of every
 * failure mode (file missing, JSON malformed, field absent or wrong
 * type) — return `undefined` and let the auto-detect take over.
 */
async function readBackendOverride(
  home: string,
): Promise<'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu' | undefined> {
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { llamaCppBackendOverride?: unknown };
    const v = parsed.llamaCppBackendOverride;
    if (v === 'auto' || v === 'cuda' || v === 'vulkan' || v === 'metal' || v === 'cpu') {
      return v;
    }
  } catch {
    /* missing or malformed — fall through to auto */
  }
  return undefined;
}
