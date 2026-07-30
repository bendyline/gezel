import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
  isProcessAlive,
  readRuntime,
  resolveDaemonEntry,
} from '@bendyline/gezel-client/node';
import {
  LLAMA_ENGINE_VERSION,
  detectLlamaBackend,
  resolveAvailableLlamaBinary,
} from '@bendyline/gezel/native';
import { gezelPaths } from '@bendyline/gezel/paths';
import { defaultBundlePaths, extractBundleIfNeeded, readBundleMeta } from './extract-bundle.js';
import { defaultNodeBundleDir, installNodeIfNeeded } from './extract-node.js';
import { defaultPnpmBundleDir, installPnpmIfNeeded } from './extract-pnpm.js';
import { LogRotator } from './log-rotator.js';
import { type Mode, resolveMode } from './mode.js';
import { nativeBinDir, resolveNativeBinaryPath } from './native-bin.js';
import { readSystemServiceRuntime } from './system-service.js';

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
}

export type ConnectionMode = Mode['kind'];

export type ServiceFallbackCode =
  | 'system-service-unhealthy'
  | 'system-service-version-mismatch'
  | 'adopted-daemon-stale'
  | 'adopted-daemon-unhealthy'
  | 'packaged-spawn-failed'
  | 'dev-spawn-failed'
  | 'version-mismatch-respawn-failed'
  | 'restart-budget-exhausted'
  | 'restart-failed';

/**
 * A degraded service situation worth telling the user about, surfaced as a
 * persistent banner. Most codes mean "we fell back to embedded"; the
 * exception is `system-service-version-mismatch`, where we stayed connected
 * to the machine service on purpose and the banner is asking the user to
 * rerun the installer. Branch on `code`, not on the mode, when the copy
 * matters — see `FallbackBanner` in the UI.
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
  private child?: ChildProcess;
  private embeddedStop?: () => Promise<void>;
  /** Restores the original stdout/stderr writers after an embedded tee. */
  private embeddedLogTeeRestore?: () => void;
  private healthTimer?: NodeJS.Timeout;
  private healthGeneration = 0;
  private healthProbe?: { generation: number; controller: AbortController };
  private consecutiveHealthFailures = 0;
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
    await this.runTransition(() => this.restartForCurrentMode());
  }

  private async restartForCurrentMode(): Promise<void> {
    const mode = this._mode;
    switch (mode) {
      case 'embedded':
        await this.restartEmbedded();
        return;
      case 'local-spawn-packaged':
      case 'local-spawn-dev':
        await this.restartSpawn();
        return;
      case 'remote':
        await this.reconnectRemote();
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
    this.stopHealthWatch();
    if (this.embeddedStop) await this.embeddedStop();
    this.embeddedStop = undefined;
    const embedded = await startEmbeddedRaw(this.opts, this.requestRestartFromService);
    this._baseUrl = embedded.baseUrl;
    this._token = embedded.token;
    this._cert = embedded.cert;
    this.attachEmbedded(embedded.stop);
    this.emit('restart');
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
    if (this.child) await gracefullyStop(this.child, this.opts.logger);
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
    try {
      await healthWithTimeout(client, HEALTH_REQUEST_TIMEOUT_MS, probe.controller);
      if (generation !== this.healthGeneration) return;
      this.consecutiveHealthFailures = 0;
    } catch {
      if (generation !== this.healthGeneration) return;
      this.consecutiveHealthFailures += 1;
      this.opts.logger?.warn?.(
        `[supervisor] health-check failure ${this.consecutiveHealthFailures}/${HEALTH_FAILURES_BEFORE_RESTART}`,
      );
      if (this.consecutiveHealthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
        this.consecutiveHealthFailures = 0;
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
    this.stopHealthWatch();
    if (this.child) await gracefullyStop(this.child, this.opts.logger);
    const mode = this._mode;
    const result =
      mode === 'local-spawn-packaged'
        ? await spawnChildFromInstall(this.opts)
        : mode === 'local-spawn-dev'
          ? await spawnChild(this.opts)
          : (() => {
              throw new Error(`Cannot spawn-restart unowned mode ${mode}`);
            })();
    this._baseUrl = result.baseUrl;
    this._token = result.token;
    this._cert = result.cert;
    this.attachSpawned(result.child);
    this.emit('restart');
  }

  private async fallbackToEmbedded(reason: ServiceFallbackReason): Promise<void> {
    this.opts.logger?.error?.(`[supervisor] falling back to embedded: ${reason.message}`);
    this.stopHealthWatch();
    if (this.child) {
      await gracefullyStop(this.child, this.opts.logger);
      this.child = undefined;
    }
    const embedded = await startEmbeddedRaw(this.opts, this.requestRestartFromService);
    this._mode = 'embedded';
    this._baseUrl = embedded.baseUrl;
    this._token = embedded.token;
    this._cert = embedded.cert;
    this._fallbackReason = reason;
    this.attachEmbedded(embedded.stop);
    this.emit('fallback', reason);
    this.emit('restart');
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
  // Install Node first: the bundled pnpm package is a JavaScript CLI and
  // every packaged platform launches it with this runtime. The sandbox
  // runner also prefers `GEZEL_NODE_PATH` over `node` on PATH so
  // `run_nodejs_script` works on machines without a global Node
  // install. Absent bundle → supervisor logs "no-bundle" and the
  // sandbox falls back to whatever `node` the shell resolves.
  try {
    const nodeBundleDir = defaultNodeBundleDir(import.meta.url);
    const node = await installNodeIfNeeded({
      home: opts.home,
      bundleDir: nodeBundleDir,
      logger: opts.logger,
    });
    if (node.binaryPath) {
      process.env.GEZEL_NODE_PATH = node.binaryPath;
    }
  } catch (err) {
    opts.logger?.warn?.(
      `[supervisor] node install step failed: ${(err as Error).message}; continuing without bundled node`,
    );
  }

  // Lay down the ordinary pnpm package at
  // `~/.gezel/bin/pnpm-runtime/` and point the service at its JS
  // entrypoint. Invocation resolution combines this with
  // `GEZEL_NODE_PATH`; dev mode still falls back to pnpm on PATH.
  try {
    const bundleDir = defaultPnpmBundleDir(import.meta.url);
    const pnpm = await installPnpmIfNeeded({ home: opts.home, bundleDir, logger: opts.logger });
    if (pnpm.entryPath) {
      process.env.GEZEL_PNPM_PATH = pnpm.entryPath;
    }
  } catch (err) {
    opts.logger?.warn?.(
      `[supervisor] pnpm install step failed: ${(err as Error).message}; continuing without bundled pnpm`,
    );
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
    process.env.GEZEL_NATIVE_BIN_DIR = nativeBinDir(import.meta.url);
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
    const resolved = resolveAvailableLlamaBinary(
      probe.backend,
      (backend) => resolveNativeBinaryPath('llama-server', import.meta.url, backend),
      override === undefined || override === 'auto',
    );
    if (resolved) {
      process.env.GEZEL_LLAMA_SERVER_BIN = resolved.path;
      process.env.GEZEL_LLAMA_SERVER_BACKEND = resolved.backend;
      if (resolved.fallbackFrom) {
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

  const mode = await resolveMode({
    home: opts.home,
    packaged: opts.packaged,
    devSpawn: opts.devSpawn,
    forceEmbedded: opts.forceEmbedded,
    logger: opts.logger,
  });

  if (mode.kind === 'remote') {
    await probeRemote(mode.baseUrl, mode.token);
    return new SupervisedService('remote', mode.baseUrl, mode.token, mode.cert, opts);
  }

  if (mode.kind === 'system-service') {
    // The Windows / macOS / Linux installer registered gezeld as a system
    // service. Probe /api/health before adopting — if the service is
    // installed but not running (e.g. SCM stopped it, or the service
    // crashed), we fall through to the per-user paths so the user still
    // gets a working app instead of an indefinite spinner.
    const client = buildHealthClient(mode.baseUrl, mode.token, mode.cert);
    try {
      const health = await healthWithTimeout(client);
      opts.logger?.info?.(`[supervisor] connected to system service at ${mode.baseUrl}`);
      return new SupervisedService('system-service', mode.baseUrl, mode.token, mode.cert, opts, {
        systemServiceHome: mode.serviceHome,
        fallbackReason: await systemServiceVersionSkew(health.version, mode.serviceHome, opts),
      });
    } catch (err) {
      opts.logger?.warn?.(
        `[supervisor] system service runtime files exist at ${mode.serviceHome} but health check failed (${(err as Error).message}); falling back to embedded`,
      );
      return buildEmbedded(opts, {
        code: 'system-service-unhealthy',
        sourceMode: 'system-service',
        message: `System service was unavailable: ${(err as Error).message}`,
      });
    }
  }

  if (mode.kind === 'local-adopt') {
    const client = buildHealthClient(mode.baseUrl, mode.token, mode.cert);
    try {
      const health = await healthWithTimeout(client);
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
          // state. This is the ONE situation where we SIGTERM a pid we
          // didn't spawn — justified because the version check just told
          // us it's stale. Phase 2 will coordinate with autostart cleanly;
          // for now the autostart may restart the old one on the next
          // login cycle, which is acceptable for a skeleton.
          const stopped = await stopProcessByPid(mode.pid, opts.logger);
          if (!stopped) {
            throw new Error(
              `Stale gezeld pid=${mode.pid} did not exit after SIGTERM/SIGKILL; refusing to spawn another writer`,
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
        // to old service code. SIGTERM and fall through to embedded.
        // Without this, `pnpm app` (which always runs `pnpm build` first)
        // can silently use a daemon that doesn't reflect the just-built
        // code, exactly the failure that surfaced when iterating on the
        // salvage layer.
        const stale = await isAdoptDaemonStaleForDev(opts.home, opts.logger);
        if (stale) {
          opts.logger?.warn?.(
            `[supervisor] dev daemon at pid=${mode.pid} is older than the latest workspace build; stopping it and falling back to embedded`,
          );
          const stopped = await stopProcessByPid(mode.pid, opts.logger);
          if (!stopped) {
            throw new Error(
              `Stale development gezeld pid=${mode.pid} did not exit after SIGTERM/SIGKILL; refusing embedded startup`,
            );
          }
          return buildEmbedded(opts, {
            code: 'adopted-daemon-stale',
            sourceMode: 'local-adopt',
            message: 'The adopted development daemon was stale and was stopped',
          });
        }
      }
      return new SupervisedService('local-adopt', mode.baseUrl, mode.token, mode.cert, opts);
    } catch (err) {
      if (isProcessAlive(mode.pid)) {
        opts.logger?.error?.(
          `[supervisor] adopted daemon health check failed while pid=${mode.pid} remains alive; refusing a second writer`,
        );
        throw new Error(
          `Adopted gezeld pid=${mode.pid} is still alive but unhealthy; refusing to start an embedded writer for the same home`,
          { cause: err },
        );
      }
      opts.logger?.warn?.(
        `[supervisor] adopted daemon health check failed after pid=${mode.pid} exited: ${(err as Error).message}; falling back to embedded`,
      );
      return buildEmbedded(opts, {
        code: 'adopted-daemon-unhealthy',
        sourceMode: 'local-adopt',
        message: `The adopted daemon was unavailable: ${(err as Error).message}`,
      });
    }
  }

  if (mode.kind === 'local-spawn-packaged') {
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

  return buildEmbedded(opts);
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

async function spawnChildFromInstall(opts: ConnectOptions): Promise<{
  child: ChildProcess;
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number;
}> {
  const installDir = gezelPaths(opts.home).install;
  // Bundle ships as a tarball + meta sidecar that electron-builder
  // asar-unpacks to `app.asar.unpacked/dist/service-bundle.tar.gz`.
  // Extract to the user's install dir if the shipped version is newer
  // (or missing). See extract-bundle.ts for the rationale on archiving.
  const { tarballPath, metaPath } = defaultBundlePaths(import.meta.url);
  await extractBundleIfNeeded({ installDir, tarballPath, metaPath, logger: opts.logger });
  const daemonEntry = join(installDir, 'dist', 'bin', 'gezeld.js');
  // The spawned daemon's own `findBundledUi` (in service/bin/gezeld.ts)
  // looks adjacent to itself for the UI, but at this point gezeld lives
  // under `~/.gezel/service/` and the UI lives under
  // `app.asar.unpacked/dist/ui/` — different trees. Hand the daemon the
  // resolved UI path via env so it can serve `/`.
  const env: NodeJS.ProcessEnv = { ...process.env, GEZEL_HOME: opts.home };
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
  const env: NodeJS.ProcessEnv = { ...process.env, GEZEL_HOME: opts.home };
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
  isAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
}

/**
 * Stop an adopted per-user daemon only on the two explicitly-authorized stale
 * version/build paths. A signal is not evidence of exit: confirm liveness,
 * escalate once, and refuse the next writer if the pid still survives.
 */
export async function stopProcessByPid(
  pid: number,
  logger: ConnectOptions['logger'],
  options: StopProcessByPidOptions = {},
): Promise<boolean> {
  const graceMs = options.graceMs ?? GRACEFUL_STOP_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const alive = options.isAlive ?? isProcessAlive;
  const signal = options.signalProcess ?? ((target, sig) => process.kill(target, sig));
  if (!alive(pid)) return true;

  try {
    signal(pid, 'SIGTERM');
  } catch {
    /* verify liveness below; ESRCH is success, EPERM remains alive */
  }
  if (await waitForPidExit(pid, graceMs, pollIntervalMs, alive)) return true;

  logger?.warn?.(`[supervisor] pid=${pid} ignored SIGTERM; sending SIGKILL`);
  try {
    signal(pid, 'SIGKILL');
  } catch {
    /* verify liveness below */
  }
  const stopped = await waitForPidExit(pid, graceMs, pollIntervalMs, alive);
  if (!stopped) logger?.error?.(`[supervisor] pid=${pid} survived SIGKILL`);
  return stopped;
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (alive(pid) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, remaining))),
    );
  }
  return !alive(pid);
}

export async function gracefullyStop(
  child: ChildProcess | undefined,
  logger: ConnectOptions['logger'],
): Promise<void> {
  if (!child || childHasExited(child)) return;
  logger?.info?.('[supervisor] stopping gezeld child...');
  // Register the waiter before signalling; a fast child can exit
  // synchronously from a test double or on the next native event turn.
  const gracefulExit = waitForChildExit(child, GRACEFUL_STOP_MS);
  try {
    child.kill('SIGTERM');
  } catch {
    /* it may have exited between the predicate and signal */
  }
  if (await gracefulExit) return;

  // `child.killed` means only that kill() delivered a signal. It says
  // nothing about process termination, so exitCode/signalCode remain the
  // sole predicates here.
  if (!childHasExited(child)) {
    logger?.warn?.('[supervisor] gezeld ignored SIGTERM; sending SIGKILL');
    const forcedExit = waitForChildExit(child, GRACEFUL_STOP_MS);
    try {
      child.kill('SIGKILL');
    } catch {
      /* it may have exited immediately before escalation */
    }
    if (!(await forcedExit) && !childHasExited(child)) {
      logger?.warn?.('[supervisor] could not confirm gezeld exited after SIGKILL');
    }
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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
    const installDir = gezelPaths(opts.home).install;
    await extractBundleIfNeeded({ installDir, tarballPath, metaPath, logger: opts.logger });
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
