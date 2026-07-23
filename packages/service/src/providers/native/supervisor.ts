/**
 * NativeEngineSupervisor — lifecycle for a native engine child process
 * (e.g. `sd-server`, `llama-server`).
 *
 * Responsibilities:
 *   - **Lazy start** the engine on the first `ensureRunning()` call, not
 *     at service boot. No VRAM is held until something actually asks
 *     for work.
 *   - **Idle timeout**: after `idleTimeoutMs` with no activity the
 *     engine is SIGTERM'd to free GPU/VRAM. Fresh activity lazy-starts
 *     again.
 *   - **Health watch**: every `healthIntervalMs` probe `/health`. After
 *     three consecutive failures the process is killed and a restart
 *     is attempted. Restart budget is 3 attempts in 60s, matching the
 *     gezeld supervisor's policy.
 *
 * Intentionally engine-agnostic — callers (`StableDiffusionCppProvider`,
 * `LlamaCppProvider`, future STT/TTS providers) ask `ensureRunning()`
 * before each request, mark activity via `markUsed()`, and otherwise
 * know nothing about subprocess plumbing. Tests inject a `spawn` hook
 * so we can drive the lifecycle without a real binary.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { basename } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('native');

export interface NativeEngineLaunch {
  /** Args passed to the binary. The binary path is opaque to this class. */
  command: string;
  args: string[];
  /** Extra env injected into the child; PATH/HOME/etc. flow through by default. */
  env?: Record<string, string>;
  /**
   * Working directory for the child. Defaults to the parent's cwd. Set when
   * the binary resolves runtime assets relative to cwd — e.g. ds4-server
   * loads its Metal shader sources from `./metal/*.metal`, so its launch
   * points cwd at the bundle dir that holds them.
   */
  cwd?: string;
  /** Base URL the provider will use to talk to the engine. */
  baseUrl: string;
}

/**
 * Convert Electron's virtual `app.asar` paths to the real files staged by
 * electron-builder under `app.asar.unpacked`. Electron patches `fs`, so an
 * existence check in the main process can succeed through the virtual path,
 * but the OS receives native spawn paths unchanged and rejects them with
 * ENOTDIR. Normalize again at the service's final launch boundary so embedded
 * mode is safe even when a pre-set env var bypassed the Electron resolver.
 */
export function normalizeNativeEngineLaunch(launch: NativeEngineLaunch): NativeEngineLaunch {
  const redirect = (value: string): string =>
    value.replace(/(^|[\\/])app\.asar(?=[\\/]|$)/g, '$1app.asar.unpacked');

  return {
    ...launch,
    command: redirect(launch.command),
    args: launch.args.map(redirect),
    ...(launch.cwd ? { cwd: redirect(launch.cwd) } : {}),
    ...(launch.env
      ? {
          env: Object.fromEntries(
            Object.entries(launch.env).map(([key, value]) => [key, redirect(value)]),
          ),
        }
      : {}),
  };
}

export interface NativeProcessSnapshot {
  pid: number;
  /** Parent pid from ps. Optional only for injected legacy test seams. */
  ppid?: number;
  command: string;
}

export interface NativeEngineSupervisorOptions {
  /**
   * Resolves to the launch spec on demand. Called each time the
   * supervisor needs to start the engine, so the caller can observe
   * config changes (active model, GPU backend, etc.) without recreating
   * the supervisor.
   */
  resolveLaunch: () => Promise<NativeEngineLaunch>;
  idleTimeoutMs?: number;
  /**
   * Stage-1 idle timeout in ms. When set and < idleTimeoutMs, the
   * supervisor fires `onFreeze` after this much inactivity but does
   * NOT stop the child — the model stays resident, ready to serve
   * the next request without a cold reload. The `onFreeze` callback
   * is the provider's chance to persist transient state (prompt
   * caches, slot files) to disk so a SIGKILL between Stage 1 and
   * Stage 2 doesn't lose anything. If activity resumes before
   * Stage 2, both timers reset cleanly. Unset = single-stage idle
   * (the legacy behavior).
   */
  freezeTimeoutMs?: number;
  /**
   * Called when the Stage-1 freeze timer fires. Best-effort; errors
   * are caught + logged so a misbehaving callback can't take down
   * the supervisor. Returns a promise the supervisor awaits before
   * resetting state — the freeze is intentionally a one-shot per
   * idle window, so callbacks do their work in one pass and the next
   * `markUsed` re-arms.
   */
  onFreeze?: () => void | Promise<void>;
  /**
   * Busy predicate consulted at the Stage-2 idle deadline: when it returns
   * true, the supervisor does NOT stop the engine — it reschedules the idle
   * timer for another full window. Prevents idle-unloading an engine that a
   * turn still needs (the "engine idle-stopped mid-turn → next request fails
   * with `unreachable / fetch failed`" bug). The idle timer resets on every
   * request via `markUsed`, so this only matters when a turn is in-flight but
   * BETWEEN engine requests (a long tool call, a parked question) — exactly
   * the window `lastUsedAt` alone misses. Wired to the ChatManager's
   * `isAnyActive()`.
   */
  isBusy?: () => boolean;
  healthIntervalMs?: number;
  /** Poll budget for the post-spawn readiness probe. Defaults to 60s. */
  startupTimeoutMs?: number;
  spawn?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  onLog?: (line: string) => void;
  /**
   * Called on every raw stdout/stderr line BEFORE `onLog`. Optional —
   * when set, callers can parse the engine's log output and emit
   * structured signals (e.g. llama-server's startup-phase classifier).
   * Return value is ignored; errors are caught + logged so a bad
   * classifier can't take down the supervisor. Runs synchronously on
   * every line, so keep the work bounded.
   */
  onRawLine?: (line: string) => void;
  /**
   * Prefix prepended to stdout/stderr log lines and lifecycle events
   * (idle-stop, restart, exit). Identifies the engine in shared log
   * streams. Defaults to `[native]`.
   */
  logPrefix?: string;
  /**
   * Path the readiness probe hits, relative to the launch baseUrl.
   * Defaults to `/health` — llama-server convention. Engines without a
   * dedicated health endpoint (sd-server treats the root as either a
   * served HTML file or a 404) override to `/` and pair with
   * {@link readyOnAnyResponse}.
   */
  readinessPath?: string;
  /**
   * When true, ANY successful HTTP response counts as ready — even a
   * 404. Useful for engines that don't implement a health endpoint:
   * the act of returning HTTP status bytes proves the port is open
   * and the request loop is alive. Defaults to `false` (2xx only),
   * preserving the strict semantics for engines like llama-server
   * whose `/health` returns 503 during model load and 200 once ready.
   */
  readyOnAnyResponse?: boolean;
  /**
   * Test seam: produce the `(pid, ppid, command)` snapshot used by the
   * orphan-reaper. Defaults to running `ps -axo pid=,ppid=,command=` and
   * parsing the output. `ppid` is optional only for backwards-compatible
   * test seams; the real runner always supplies it. Tests inject a
   * deterministic list so we can assert reap behavior without spawning
   * real processes.
   */
  psRunner?: () => Promise<NativeProcessSnapshot[]>;
  /**
   * Test seam paired with `psRunner` — invoked instead of
   * `process.kill(pid, 'SIGKILL')`. Lets unit tests assert which pids
   * were targeted without actually delivering signals. Defaults to
   * `process.kill`.
   */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

type State =
  | { kind: 'stopped' }
  | {
      kind: 'starting';
      launch: NativeEngineLaunch;
      child: ChildProcess;
      readyPromise: Promise<void>;
    }
  | { kind: 'running'; launch: NativeEngineLaunch; child: ChildProcess; healthFails: number }
  | { kind: 'restart-budget-exhausted'; at: number };

const RESTART_BUDGET = 3;
const RESTART_WINDOW_MS = 60_000;
const HEALTH_FAIL_THRESHOLD = 3;
/**
 * After SIGKILLing reaped orphans, how long to wait for them to actually leave
 * the process table before spawning the replacement. SIGKILL is asynchronous
 * and a model-loaded engine holding tens of GB of wired GPU memory (ds4-server
 * especially) takes a beat to die. ds4-server enforces a HARD singleton, so
 * spawning into a still-dying orphan races straight into its "another ds4
 * process is already running; refusing to start".
 */
const ORPHAN_REAP_WAIT_MS = 10_000;

/**
 * Process-wide set of engine child PIDs currently owned by a LIVE
 * supervisor in this daemon. The orphan reaper consults it so a freshly
 * constructed supervisor never reaps a *sibling* engine that another
 * live supervisor is actively driving.
 *
 * This is the fix for a real outage: a model switch (or any second
 * engine) spins up a new supervisor whose once-per-instance orphan
 * sweep matches every process sharing the engine's script path —
 * including the engine still mid-agentic-turn for another session. The
 * old reaper SIGKILL'd it, dropping the in-flight HTTP stream, which
 * surfaced to the user as a bare "terminated". A live, owned engine is
 * never an orphan: its supervisor manages its lifecycle (idle stop,
 * eviction, health restart) and can drain a turn cleanly. The reaper is
 * only for engines whose owner is *gone* (force-quit, OS-reaped
 * Electron), which by definition aren't in this set.
 *
 * Shared module singleton: every supervisor in the process registers
 * its child here on spawn and removes it on exit.
 */
const liveEnginePids = new Set<number>();

/** Test-only: clear the live-engine registry between cases so a pid
 *  registered by one test can't suppress an orphan reap in the next. */
export function __resetLiveEnginePidsForTest(): void {
  liveEnginePids.clear();
}

export class NativeEngineSupervisor {
  private state: State = { kind: 'stopped' };
  private readonly resolveLaunch: () => Promise<NativeEngineLaunch>;
  private readonly idleTimeoutMs: number;
  private readonly freezeTimeoutMs: number;
  private readonly onFreeze?: () => void | Promise<void>;
  private readonly isBusy?: () => boolean;
  private freezeTimer?: NodeJS.Timeout;
  /** True once the current idle window has fired its Stage-1 freeze.
   *  Reset on next `markUsed` so subsequent idle windows re-fire. */
  private freezeFired = false;
  private readonly healthIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly spawn: typeof nodeSpawn;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (line: string) => void;
  private readonly onRawLine?: (line: string) => void;
  private readonly logPrefix: string;
  private readonly readinessPath: string;
  private readonly readyOnAnyResponse: boolean;
  private readonly psRunner: () => Promise<NativeProcessSnapshot[]>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  // Ad-hoc log listeners attached at runtime (vs. the construction-time
  // `onLog` / `onRawLine` hooks). Used by the owning provider to
  // subscribe to engine log lines for the duration of a single request
  // — e.g. `StableDiffusionCppProvider.generate` parses sd-server's
  // sampling progress from each line and republishes it as chat
  // events. Listeners receive the SAME prefixed line (`[sd-server] …`)
  // that `onLog` would; supervisor errors thrown from a listener are
  // swallowed so a buggy parser can't take down the supervisor.
  private readonly logListeners = new Set<(line: string) => void>();
  private recentStarts: number[] = [];
  private lastUsedAt = 0;
  /** PID of the engine child this supervisor currently owns, registered
   *  in {@link liveEnginePids} so a sibling supervisor's orphan reaper
   *  leaves it alone. Set on spawn, cleared on exit. */
  private ownedPid?: number;
  // Tracks whether we've already done the once-per-process orphan
  // sweep. Reaping runs ONLY before the first spawn — during restarts
  // we'd risk killing our own freshly-launched child.
  private didOrphanSweep = false;
  // When the owning provider detects a fatal error in the child's
  // stdout (e.g. MLX's `ValueError: Received N parameters not in
  // model`), it calls `abortStartup(err)` to short-circuit the
  // `waitForReady` poll loop — otherwise the supervisor would keep
  // pinging `/health` for the full startup-timeout window even
  // though the worker thread has already died. Cleared on each
  // fresh start.
  private startupAbort: AbortController | null = null;
  private idleTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;

  constructor(opts: NativeEngineSupervisorOptions) {
    this.resolveLaunch = opts.resolveLaunch;
    // 30 min by default — aligns with `OLLAMA_TURN_TIMEOUT_MS` in chat/manager.ts,
    // the accepted ceiling for a single local-engine turn. The previous 10-min
    // default killed llama-server mid-stream on legitimately-long Builder
    // generations (tankcombat trial: 1.7 MB streamed at T+10:27 →
    // VRAM-saver fired → empty assistant message). Callers that want faster
    // VRAM reclaim (sd-server idle policy, tests) pass an explicit value.
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    // Default freeze = half of idle when both are set. Operators get
    // the staged behavior automatically without further config; legacy
    // callers that pass explicit idleTimeoutMs and don't want a freeze
    // can pass freezeTimeoutMs:0 to disable it explicitly.
    if (opts.freezeTimeoutMs !== undefined) {
      this.freezeTimeoutMs = opts.freezeTimeoutMs;
    } else {
      this.freezeTimeoutMs = 0; // disabled by default
    }
    if (opts.onFreeze) this.onFreeze = opts.onFreeze;
    if (opts.isBusy) this.isBusy = opts.isBusy;
    this.healthIntervalMs = opts.healthIntervalMs ?? 15_000;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog ?? ((line) => log.info(line));
    if (opts.onRawLine) this.onRawLine = opts.onRawLine;
    this.logPrefix = opts.logPrefix ?? '[native]';
    this.readinessPath = opts.readinessPath ?? '/health';
    this.readyOnAnyResponse = opts.readyOnAnyResponse ?? false;
    this.psRunner = opts.psRunner ?? defaultPsRunner;
    this.killProcess = opts.killProcess ?? ((pid, sig) => process.kill(pid, sig));
  }

  /** URL the provider should hit. Only meaningful while running. */
  currentBaseUrl(): string | undefined {
    if (this.state.kind === 'running' || this.state.kind === 'starting') {
      return this.state.launch.baseUrl;
    }
    return undefined;
  }

  /**
   * PID of the supervised child when running. Used by providers that
   * want to poll the child's resource usage (e.g. resident-set size
   * for an "engine memory" telemetry event) — the supervisor owns
   * the lifetime of the pid, so consumers don't have to track
   * restarts themselves.
   */
  currentChildPid(): number | undefined {
    if (this.state.kind === 'running' || this.state.kind === 'starting') {
      return this.state.child.pid ?? undefined;
    }
    return undefined;
  }

  /**
   * Ensure the engine is running and reachable. If it's stopped, spawn
   * it; if it's starting, await the in-flight readiness probe; if it's
   * already running, no-op. Rejects if the restart budget is exhausted.
   */
  async ensureRunning(): Promise<NativeEngineLaunch> {
    this.lastUsedAt = Date.now();
    if (this.state.kind === 'running') {
      this.resetIdleTimer();
      return this.state.launch;
    }
    if (this.state.kind === 'starting') {
      await this.state.readyPromise;
      const current = this.state as State;
      if (current.kind === 'running') return current.launch;
      throw new Error(`${this.logPrefix} failed to start`);
    }
    if (this.state.kind === 'restart-budget-exhausted') {
      if (Date.now() - this.state.at < RESTART_WINDOW_MS) {
        throw new Error(
          `${this.logPrefix} failed repeatedly. Wait a minute and try again, or check logs in Settings.`,
        );
      }
      this.recentStarts = [];
      this.state = { kind: 'stopped' };
    }
    await this.startFresh();
    const current = this.state as State;
    if (current.kind === 'running') return current.launch;
    throw new Error(`${this.logPrefix} did not reach running state`);
  }

  /**
   * Attach a transient log listener that receives every prefixed
   * stdout/stderr line (`[sd-server] …`) for the duration of the
   * returned unsubscribe call. Used by the owning provider to parse
   * engine progress for a single in-flight request — e.g. sd-server's
   * `|==> | 3/20 - 18.20s/it` sampling lines — and translate them
   * into structured progress events for the UI.
   *
   * Listeners are independent of `onLog` / `onRawLine` (which are
   * construction-time hooks for log routing + classification). Adding
   * one does not suppress either.
   */
  subscribeLogLines(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  /** Update the last-used clock without triggering a start. */
  markUsed(): void {
    this.lastUsedAt = Date.now();
    this.resetIdleTimer();
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.clearFreezeTimer();
    this.clearHealthTimer();
    if (this.state.kind === 'stopped' || this.state.kind === 'restart-budget-exhausted') return;
    const { child } = this.state;
    this.state = { kind: 'stopped' };
    await killGracefully(child);
  }

  private async startFresh(isRetry = false): Promise<void> {
    const now = Date.now();
    this.recentStarts = this.recentStarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.recentStarts.length >= RESTART_BUDGET) {
      this.state = { kind: 'restart-budget-exhausted', at: now };
      throw new Error(
        `${this.logPrefix} crashed too many times; stopping restart attempts for a minute`,
      );
    }
    this.recentStarts.push(now);

    const launch = normalizeNativeEngineLaunch(await this.resolveLaunch());
    // First spawn of this process? Sweep up any matching orphans from
    // previous app launches that didn't get a chance to clean up
    // (force-quit, OS reaped Electron, before-quit handler crashed,
    // etc.). Match is anchored on the binary path so we don't touch
    // unrelated processes; restarts skip the sweep so we don't shoot
    // our own foot.
    if (!this.didOrphanSweep) {
      this.didOrphanSweep = true;
      await this.reapOrphansMatching(launch).catch((err) => {
        this.onLog(
          `${this.logPrefix} orphan sweep failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      });
    }
    let child: ChildProcess;
    try {
      child = this.spawn(launch.command, launch.args, {
        env: { ...process.env, ...(launch.env ?? {}) },
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw nativeSpawnError(this.logPrefix, launch, err);
    }
    // Register the child as a live, owned engine so no sibling
    // supervisor's orphan reaper can SIGKILL it mid-turn. Cleared in
    // handleExit. `pid` is undefined only if the spawn itself failed —
    // handleExit will fire and tear the state down regardless.
    this.ownedPid = typeof child.pid === 'number' ? child.pid : undefined;
    if (this.ownedPid !== undefined) liveEnginePids.add(this.ownedPid);

    const onChunk = (buf: Buffer) => {
      const text = buf.toString();
      // Split on CR *and* LF so the optional line classifier sees one
      // logical record at a time. Most engines emit line-buffered
      // output (\n), but tqdm-style progress bars — notably mlx's
      // chunked-prefill `Prefill: NN%|…` meter — repaint a single line
      // in place with a bare `\r` and emit no `\n` until the bar hits
      // 100%. Splitting on `\n` alone buffers the entire prefill arc
      // into one unterminated record that only flushes at completion,
      // so the classifier never sees per-step progress and the mlx
      // idle watchdog kills the turn mid-prefill (it never gets the
      // progress events that reset its per-chunk budget). Treating each
      // `\r` repaint as its own line lets progress flow. A partial
      // final line is rare and still fed through.
      for (const rawLine of text.split(/\r\n?|\n/)) {
        const line = rawLine;
        if (!line) continue;
        const prefixed = `${this.logPrefix} ${line}`;
        this.onLog(prefixed);
        if (this.onRawLine) {
          try {
            this.onRawLine(prefixed);
          } catch (err) {
            // Never let a bad classifier take down the supervisor.
            log.warn(
              `${this.logPrefix} onRawLine threw: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (this.logListeners.size > 0) {
          for (const listener of this.logListeners) {
            try {
              listener(prefixed);
            } catch (err) {
              log.warn(
                `${this.logPrefix} log listener threw: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }
      }
    };
    this.startupAbort = new AbortController();
    let spawnFailed = false;
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    // `child_process.spawn` reports missing/non-traversable executables through
    // the child's `error` event on most Node/platform combinations. Without a
    // listener this can escape as an opaque process-level exception; abort the
    // readiness wait with the same actionable detail as a synchronous throw.
    child.once('error', (err) => {
      spawnFailed = true;
      this.startupAbort?.abort(nativeSpawnError(this.logPrefix, launch, err));
    });

    const readyPromise = this.waitForReady(launch, this.startupAbort.signal);
    this.state = { kind: 'starting', launch, child, readyPromise };

    try {
      await readyPromise;
      this.state = { kind: 'running', launch, child, healthFails: 0 };
      this.resetIdleTimer();
      this.startHealthWatch();
    } catch (err) {
      // A child that failed before the OS assigned a pid cannot be signalled
      // and may never emit `exit`; waiting for killGracefully would wedge the
      // chat turn while reporting the original spawn failure.
      if (!spawnFailed) {
        await killGracefully(child);
      }
      this.state = { kind: 'stopped' };
      // Singleton-conflict recovery: a hard-singleton engine (ds4-server)
      // refuses to start while an owner-less orphan from a prior launch still
      // holds the lock, surfaced as "child exited ... before becoming ready".
      // On the first such failure, sweep orphans again — the first-spawn sweep
      // may have raced one, or this is a RESTART (which skips the sweep) and the
      // engine's own prior child lingered. Only retry if the sweep actually
      // cleared a blocking process; a failure with nothing to clear is a real
      // startup error (bad model, OOM), not a lock conflict, so don't burn a
      // retry on it. `isRetry` caps recovery at a single extra attempt.
      if (!isRetry && err instanceof Error && err.message.includes('before becoming ready')) {
        const cleared = await this.reapOrphansMatching(launch).catch(() => 0);
        if (cleared > 0) {
          this.onLog(
            `${this.logPrefix} cleared ${cleared} blocking orphan(s) after a failed start — retrying once`,
          );
          this.startupAbort = null;
          return await this.startFresh(true);
        }
      }
      throw err;
    } finally {
      this.startupAbort = null;
    }
  }

  /**
   * Abort an in-flight `startFresh` with a concrete error. Called by
   * the owning provider when the child's stdout reveals a fatal
   * condition (model-arch mismatch, OOM, missing dependency) that
   * won't resolve by waiting longer — without this, the `waitForReady`
   * poll would keep hitting `/health` for the full startup-timeout
   * window even though the worker thread has already died.
   */
  abortStartup(err: Error): void {
    const ac = this.startupAbort;
    if (!ac) return;
    ac.abort(err);
  }

  /**
   * Find and SIGKILL any owner-less engine process from a prior gezel
   * launch that matches this engine. Best-effort: any error during the
   * sweep is logged and swallowed so the spawn-on-startup path never
   * aborts because of cleanup.
   *
   * Crucially, a process whose parent is still alive is NOT an orphan and
   * is skipped. The process-local {@link liveEnginePids} registry protects
   * sibling supervisors inside this daemon; the PPID check protects engines
   * owned by a different live gezeld process/home. This matters for two
   * concurrent isolated eval daemons: each uses the same engine binary, so a
   * command-path-only sweep would otherwise SIGKILL the other's in-flight
   * child and surface a bare `terminated` fetch error.
   *
   * Match strategy — anchor on every install-specific absolute path we
   * can find in the launch spec, then check whether each `ps` row
   * contains any of them:
   *
   *   1. `launch.command` — works directly when the binary is
   *      install-specific (llama-server, sd-server: a path under
   *      `~/.gezel/native/bin/`).
   *   2. Any absolute-path argument that looks like a script or
   *      executable (`*.py`, `*.js`, etc.). For Python engines this is
   *      the case that *actually* fires: `launch.command` is the venv's
   *      `bin/python`, but that's typically a symlink chain to the
   *      system framework Python (e.g. `/Library/Frameworks/Python.../
   *      MacOS/Python`) — and macOS `ps` reports the resolved path, so
   *      the binary-path match never hits. The script path
   *      (`gezel_mlx_server.py` under the dist folder) appears verbatim
   *      in the ps command line and is unique to this install.
   *
   * `didOrphanSweep` gates this to one execution per supervisor instance
   * (so we don't re-sweep on our own restarts). A real orphan is reparented
   * to launchd/systemd (PPID 1) after its daemon exits. Any matching child
   * with PPID > 1 still has a live owner and is conservatively left alone.
   * Injected legacy `psRunner` rows may omit PPID and retain the historical
   * match behavior; the production runner always includes it.
   *
   * macOS + Linux only (`ps -axo pid=,ppid=,command=`); Windows gets a
   * silent no-op via the default psRunner.
   */
  private async reapOrphansMatching(launch: NativeEngineLaunch): Promise<number> {
    const anchors = this.buildOrphanAnchors(launch);
    if (anchors.command.length === 0 && anchors.args.length === 0) return 0;
    const procs = await this.psRunner();
    const ourPid = process.pid;
    const targets: number[] = [];
    for (const { pid, ppid, command } of procs) {
      if (pid === ourPid) continue;
      // Never reap an engine a live supervisor in this process owns —
      // it may be mid-turn for another session. Only owner-less orphans
      // (force-quit / OS-reaped prior launches) are ours to clean up.
      if (liveEnginePids.has(pid)) continue;
      // Cross-daemon ownership: a matching native engine with a non-init
      // parent is still owned by another live daemon/process. Command-path
      // matching alone cannot distinguish two isolated eval homes because
      // they intentionally share the same binary. Once the owner exits,
      // Unix reparents the child to init/launchd (PPID 1), making it safe to
      // reap on a later launch. Missing PPID is supported only for injected
      // legacy test runners; defaultPsRunner always supplies it.
      if (ppid !== undefined && ppid > 1) continue;
      const matched =
        anchors.command.some((anchor) => command === anchor || command.startsWith(`${anchor} `)) ||
        anchors.args.some((anchor) => command.includes(anchor));
      if (!matched) continue;
      targets.push(pid);
    }
    if (targets.length === 0) return 0;
    this.onLog(
      `${this.logPrefix} reaping ${targets.length} orphan(s) from prior app launches: ${targets.join(', ')}`,
    );
    for (const pid of targets) {
      try {
        this.killProcess(pid, 'SIGKILL');
      } catch (err) {
        // Already dead, or not ours to kill — either way, ignore.
        this.onLog(
          `${this.logPrefix} reap pid=${pid} failed (ignored): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // SIGKILL only *requests* termination — block until the reaped pids are
    // actually gone, so a hard-singleton engine isn't spawned while a just-
    // killed orphan still holds the lock. Without this wait the new ds4-server
    // saw the dying orphan and refused to start (the trial then stalled).
    await this.waitForPidsGone(targets, ORPHAN_REAP_WAIT_MS);
    return targets.length;
  }

  /**
   * Poll the process table until none of `pids` remain, or `timeoutMs`
   * elapses. Best-effort: a still-present pid after the timeout is logged (the
   * subsequent spawn may then fail a singleton check, surfaced normally) rather
   * than thrown, so cleanup never wedges startup.
   */
  private async waitForPidsGone(pids: number[], timeoutMs: number): Promise<void> {
    if (pids.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    let remaining = pids;
    while (remaining.length > 0 && Date.now() < deadline) {
      await sleep(150);
      const alive = new Set((await this.psRunner()).map((p) => p.pid));
      remaining = remaining.filter((pid) => alive.has(pid));
    }
    if (remaining.length > 0) {
      this.onLog(
        `${this.logPrefix} reaped orphan(s) still present after ${timeoutMs}ms: ${remaining.join(', ')} — spawn may hit the engine's singleton guard`,
      );
    }
  }

  /**
   * Pull every install-specific absolute path out of the launch spec.
   * Used by the orphan reaper to match against `ps` output. The
   * filtering is deliberately conservative: only paths that look like a
   * concrete file (have an extension) qualify, so flag values like
   * `--port 12345` or directory paths passed via `--model` don't get
   * promoted to anchors. Absolute model dirs would still be
   * install-specific in practice, but matching on a directory path
   * could collide with any tool that happens to have it on its command
   * line (e.g. a `du -sh` invocation), so we leave them out.
   */
  private buildOrphanAnchors(launch: NativeEngineLaunch): {
    command: string[];
    args: string[];
  } {
    const command: string[] = [];
    const args: string[] = [];
    const seen = new Set<string>();
    const add = (bucket: string[], p: string): void => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      bucket.push(p);
    };
    if (launch.command.startsWith('/')) add(command, launch.command);
    for (const arg of launch.args) {
      if (!arg.startsWith('/')) continue;
      // File-shaped: ends with a dot-extension whose tail contains at
      // least one letter (`gezel_mlx_server.py`, `model.bin`). Skips
      // bare directory paths (`/Users/me/.gezel/.../models/qwen3.6`),
      // including ones whose final segment looks like a version
      // number — `.6`, `1.0.0`, `3.14` would all sneak through a
      // letter-or-digit regex but none describe a real file extension.
      if (!/\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]{0,7}$/.test(arg)) continue;
      add(args, arg);
    }
    return { command, args };
  }

  private async waitForReady(launch: NativeEngineLaunch, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(`${this.logPrefix} startup aborted`);
      }
      try {
        const res = await this.fetchImpl(`${launch.baseUrl}${this.readinessPath}`, { signal });
        if (res.ok || this.readyOnAnyResponse) {
          // For engines without a dedicated health endpoint, returning
          // any HTTP status proves the port is open and accepting work
          // — that's the readiness signal we care about. Drain the body
          // so the connection isn't left half-open.
          void res.body?.cancel?.().catch(() => {});
          return;
        }
        lastError = new Error(`${this.readinessPath} returned ${res.status}`);
      } catch (err) {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`${this.logPrefix} startup aborted`);
        }
        lastError = err;
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        const onAbort = () => {
          clearTimeout(t);
          reject(signal.reason instanceof Error ? signal.reason : new Error('startup aborted'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw new Error(
      `${this.logPrefix} did not become ready within ${this.startupTimeoutMs / 1000}s: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Deregister before any early-return: this owned engine is gone, so
    // it's free for a future reaper to clean up if it somehow outlives us.
    if (this.ownedPid !== undefined) {
      liveEnginePids.delete(this.ownedPid);
      this.ownedPid = undefined;
    }
    this.clearIdleTimer();
    this.clearFreezeTimer();
    this.clearHealthTimer();
    if (this.state.kind === 'stopped') return;
    this.onLog(`${this.logPrefix} exited (code=${code} signal=${signal ?? 'none'})`);
    // If the child died while we were still waiting for /health to come
    // up, abort the startup wait immediately. Otherwise `waitForReady`
    // would keep polling a dead port for the full startup-timeout
    // budget (default 180s) — observed as a 3-minute wedge in chat
    // when an unclassified Python exception kills the engine before
    // ready. The provider's stdout classifier may still produce a
    // better-typed error a moment later via `abortStartup(err)`; that
    // call wins because it lands first (the classifier sees the leaf
    // exception line slightly before the kernel reports the exit).
    if (this.startupAbort && this.state.kind === 'starting') {
      this.startupAbort.abort(
        new Error(
          `${this.logPrefix} child exited (code=${code} signal=${signal ?? 'none'}) before becoming ready`,
        ),
      );
    }
    this.state = { kind: 'stopped' };
  }

  private startHealthWatch(): void {
    this.clearHealthTimer();
    this.healthTimer = setInterval(() => {
      void this.healthProbe();
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private async healthProbe(): Promise<void> {
    if (this.state.kind !== 'running') return;
    const launch = this.state.launch;
    try {
      const res = await this.fetchImpl(`${launch.baseUrl}${this.readinessPath}`);
      if (res.ok || this.readyOnAnyResponse) {
        void res.body?.cancel?.().catch(() => {});
        if (this.state.kind === 'running') this.state.healthFails = 0;
        return;
      }
    } catch {
      /* treat as failure below */
    }
    if (this.state.kind !== 'running') return;
    this.state.healthFails++;
    if (this.state.healthFails >= HEALTH_FAIL_THRESHOLD) {
      this.onLog(`${this.logPrefix} ${HEALTH_FAIL_THRESHOLD} health failures — restarting`);
      const child = this.state.child;
      this.state = { kind: 'stopped' };
      await killGracefully(child);
      try {
        await this.startFresh();
      } catch (err) {
        this.onLog(`${this.logPrefix} restart failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.clearFreezeTimer();
    this.freezeFired = false;
    // Stage 1 (freeze): persist transient state to disk while the
    // child is still healthy. Doesn't stop the engine. Skipped when
    // freezeTimeoutMs is unset/0 (legacy single-stage behavior) or
    // when no onFreeze callback was supplied.
    if (this.freezeTimeoutMs > 0 && this.onFreeze && this.freezeTimeoutMs < this.idleTimeoutMs) {
      this.freezeTimer = setTimeout(() => {
        // Fire-and-forget; supervisor logs + swallows any error so a
        // bad callback can't crash the host.
        void this.runFreeze();
      }, this.freezeTimeoutMs + 50);
      this.freezeTimer.unref?.();
    }
    // Stage 2 (idle): full SIGTERM. Existing behavior — runs after
    // idleTimeoutMs regardless of whether Stage 1 fired.
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      const since = Date.now() - this.lastUsedAt;
      if (since < this.idleTimeoutMs) return;
      // Don't strand an in-flight turn. A turn parked between engine requests
      // (long tool call, a `ask_user_question` awaiting the human) leaves
      // `lastUsedAt` stale, so without this the idle timer would SIGTERM an
      // engine the turn is about to use again — the next request then dies
      // with `unreachable / fetch failed`. Defer a full window and re-check.
      if (this.isBusy?.()) {
        this.onLog(
          `${this.logPrefix} idle deadline reached but a turn is active — deferring VRAM stop`,
        );
        this.resetIdleTimer();
        return;
      }
      this.onLog(`${this.logPrefix} idle timeout — stopping to free VRAM`);
      void this.stop();
    }, this.idleTimeoutMs + 50);
    this.idleTimer.unref?.();
  }

  /**
   * Run the user-supplied onFreeze hook with proper guarding. Marks
   * `freezeFired` so subsequent ticks within this idle window don't
   * re-fire (idempotency for callers, e.g. a re-entrant flush would
   * double-write the same content).
   */
  private async runFreeze(): Promise<void> {
    if (this.freezeFired) return;
    this.freezeFired = true;
    if (!this.onFreeze) return;
    this.onLog(`${this.logPrefix} idle freeze — flushing caches to disk (model stays resident)`);
    try {
      await this.onFreeze();
    } catch (err) {
      this.onLog(
        `${this.logPrefix} freeze callback threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearFreezeTimer(): void {
    if (this.freezeTimer) {
      clearTimeout(this.freezeTimer);
      this.freezeTimer = undefined;
    }
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
}

/**
 * Default `psRunner` — executes `ps -axo pid=,ppid=,command=` and parses
 * the output into `{ pid, ppid, command }` rows. PPID is load-bearing:
 * command paths identify *which* engine a row belongs to, while PPID
 * distinguishes an owner-less prior-launch orphan (reparented to init,
 * PPID 1) from an engine actively owned by another gezeld process.
 * macOS + Linux both ship a `ps` with this format. On Windows there's no
 * comparable one-liner; we return an empty list. Errors are swallowed and
 * treated as "no orphans" so a missing `ps` doesn't block startup.
 */
async function defaultPsRunner(): Promise<NativeProcessSnapshot[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  const { execFile } = await import('node:child_process');
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-axo', 'pid=,ppid=,command='],
        { maxBuffer: 8 * 1024 * 1024 },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        },
      );
    });
  } catch {
    return [];
  }
  return parseNativeProcessSnapshot(stdout);
}

/** Parse the portable `ps -axo pid=,ppid=,command=` shape. */
export function parseNativeProcessSnapshot(stdout: string): NativeProcessSnapshot[] {
  const out: NativeProcessSnapshot[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimStart();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const ppid = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    out.push({ pid, ppid, command: m[3]! });
  }
  return out;
}

function nativeSpawnError(logPrefix: string, launch: NativeEngineLaunch, cause: unknown): Error {
  const code =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `${logPrefix} could not launch ${basename(launch.command)}${code ? ` (${code})` : ''}. ` +
      `Executable: ${launch.command}${launch.cwd ? `; cwd: ${launch.cwd}` : ''}. ${detail}`,
    { cause },
  );
}

async function killGracefully(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  const timeout = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* */
    }
  }, 3_000);
  timeout.unref?.();
  await exited;
  clearTimeout(timeout);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
