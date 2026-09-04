import { type FileHandle, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import {
  type DiscoverOrSpawnResult,
  discoverOrSpawn,
  isGezelEngineCommand,
  listProcessSnapshots,
  resolveDaemonEntry,
  stopOwnedDaemon,
} from '@bendyline/gezel-client/node';
import { assertServiceDistArtifact } from './service-dist-authority.ts';

export interface SpawnTrialDaemonOptions {
  /** GEZEL_HOME for this daemon — should be a writable, ideally fresh dir. */
  home: string;
  /**
   * Absolute path to the bundled `llama-server` binary. Optional —
   * MLX trials don't need llama-server at all, so the env var is only
   * set when this is provided. Llama-cpp trials still require it; the
   * runner enforces that.
   */
  llamaBin?: string;
  /**
   * Absolute path to the bundled `sd-server` binary. Optional —
   * scenarios that don't need image generation can omit this; the
   * service falls back to default loopback URL mode and the eval
   * surfaces a clear error if a tool tries to render an image.
   */
  sdBin?: string;
  /** Optional file path to mirror the daemon's stderr into (for postmortem). */
  stderrLogPath?: string;
  /** Extra env to merge over the defaults. */
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Wait budget in ms; default 120_000. Cold first-run boot is slow, and
   * after an image scenario (`petshop`/`tool-routing-image`) the previous
   * trial's native `sd-server` can hold Metal/RAM for several seconds past
   * its SIGKILL while the OS reclaims the allocation — the next daemon's
   * boot races that release. 60s was too tight (wild-caught:
   * `tankcombat` spawn-timed-out immediately after `petshop`, then PASSed
   * standalone); 120s clears the window without masking a genuinely dead
   * daemon (which still fails fast with a connection error, not a hang).
   */
  timeoutMs?: number;
}

export type TrialDaemon = DiscoverOrSpawnResult & {
  home: string;
  /** Resolves after the bounded daemon-log sink has flushed and closed. */
  daemonLogDrain?: Promise<void>;
};

/**
 * Normal daemon logs are well under 1 MiB. Keep a generous ceiling so a
 * native-engine log loop cannot consume the host disk while an unattended
 * matrix is running. The compacted form retains the service/engine launch at
 * the beginning and several MiB of the latest diagnostics at the end.
 */
export const TRIAL_DAEMON_LOG_MAX_BYTES = 32 * 1024 * 1024;
const TRIAL_DAEMON_LOG_HEAD_BYTES = 2 * 1024 * 1024;
const TRIAL_DAEMON_LOG_TAIL_BYTES = 8 * 1024 * 1024;

export interface BoundedDaemonLogOptions {
  maxBytes?: number;
  headBytes?: number;
  tailBytes?: number;
}

/**
 * A live, bounded daemon-log sink.
 *
 * Once the file reaches its ceiling, it is atomically compacted to its fixed
 * startup prefix plus a recent tail, leaving room for new output. This is
 * deliberately not a rotate-to-more-files scheme: per-trial disk usage stays
 * bounded, while readers that poll `daemon.log` continue to see the latest
 * engine progress at the end of the same path.
 */
export class BoundedDaemonLogSink extends Writable {
  private readonly maxBytes: number;
  private readonly headBytes: number;
  private readonly tailBytes: number;
  private readonly marker: Buffer;
  private readonly ready: Promise<void>;
  private handle: FileHandle | null = null;
  private closePromise: Promise<void> | null = null;
  private bytesWritten = 0;
  private head = Buffer.alloc(0);

  constructor(
    private readonly path: string,
    options: BoundedDaemonLogOptions = {},
  ) {
    super();
    this.maxBytes = options.maxBytes ?? TRIAL_DAEMON_LOG_MAX_BYTES;
    this.headBytes = options.headBytes ?? TRIAL_DAEMON_LOG_HEAD_BYTES;
    this.tailBytes = options.tailBytes ?? TRIAL_DAEMON_LOG_TAIL_BYTES;
    this.marker = Buffer.from(
      `\n[eval-log] middle daemon output omitted after reaching the ${this.maxBytes}-byte trial log limit; startup and latest tail retained\n`,
      'utf8',
    );
    if (
      this.maxBytes <= 0 ||
      this.headBytes < 0 ||
      this.tailBytes < 0 ||
      this.headBytes + this.tailBytes + this.marker.length >= this.maxBytes
    ) {
      throw new Error('bounded daemon log requires head + tail + marker to fit below maxBytes');
    }
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.handle = await open(this.path, 'a+');
    const size = (await this.handle.stat()).size;
    this.bytesWritten = size;
    const initialHeadBytes = Math.min(size, this.headBytes);
    if (initialHeadBytes > 0) {
      const buf = Buffer.alloc(initialHeadBytes);
      const { bytesRead } = await this.handle.read({
        buffer: buf,
        position: 0,
        length: initialHeadBytes,
      });
      this.head = buf.subarray(0, bytesRead);
    }
    if (this.bytesWritten > this.maxBytes) await this.compact();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    void this.append(data).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.closeHandle().then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.closeHandle().then(
      () => callback(error),
      (closeError: Error) => callback(error ?? closeError),
    );
  }

  private async append(data: Buffer): Promise<void> {
    await this.ready;
    if (data.length === 0) return;
    if (this.head.length < this.headBytes) {
      const take = Math.min(this.headBytes - this.head.length, data.length);
      this.head = Buffer.concat([this.head, data.subarray(0, take)]);
    }

    let offset = 0;
    while (offset < data.length) {
      if (this.bytesWritten >= this.maxBytes) await this.compact();
      const length = Math.min(data.length - offset, this.maxBytes - this.bytesWritten);
      if (length <= 0) throw new Error('bounded daemon log compaction made no write room');
      const handle = this.handle;
      if (!handle) throw new Error('bounded daemon log is closed');
      const slice = data.subarray(offset, offset + length);
      let sliceOffset = 0;
      while (sliceOffset < slice.length) {
        const { bytesWritten } = await handle.write(
          slice,
          sliceOffset,
          slice.length - sliceOffset,
          null,
        );
        if (bytesWritten <= 0) throw new Error('bounded daemon log write made no progress');
        sliceOffset += bytesWritten;
        this.bytesWritten += bytesWritten;
      }
      offset += slice.length;
    }
  }

  private async compact(): Promise<void> {
    const handle = this.handle;
    if (!handle) throw new Error('bounded daemon log is closed');

    const tailLength = Math.min(this.tailBytes, Math.max(0, this.bytesWritten - this.head.length));
    let tailBuffer = Buffer.alloc(tailLength);
    if (tailLength > 0) {
      const { bytesRead } = await handle.read({
        buffer: tailBuffer,
        position: this.bytesWritten - tailLength,
        length: tailLength,
      });
      tailBuffer = tailBuffer.subarray(0, bytesRead);
    }
    // The tail starts at an arbitrary byte offset. Drop its first partial line
    // so downstream regex readers never mistake a torn record for evidence.
    const firstNewline = tailBuffer.indexOf(0x0a);
    const tail = firstNewline >= 0 ? tailBuffer.subarray(firstNewline + 1) : Buffer.alloc(0);
    const snapshot = Buffer.concat([this.head, this.marker, tail]);
    if (snapshot.length >= this.maxBytes) {
      throw new Error('bounded daemon log snapshot does not leave append capacity');
    }

    await handle.close();
    this.handle = null;
    const tempPath = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, snapshot, { flag: 'wx' });
      await rename(tempPath, this.path);
      this.handle = await open(this.path, 'a+');
      this.bytesWritten = snapshot.length;
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      // The atomic rename leaves the old path intact on failure. Reopen it so
      // destroy/fallback can close cleanly and the caller can keep draining.
      this.handle = await open(this.path, 'a+').catch(() => null);
      if (this.handle) this.bytesWritten = (await this.handle.stat()).size;
      throw error;
    }
  }

  private closeHandle(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.ready.catch(() => {});
      const handle = this.handle;
      this.handle = null;
      if (handle) await handle.close();
    })();
    return this.closePromise;
  }
}

/**
 * Spawn a fresh `gezeld` against a custom GEZEL_HOME with the bundled
 * llama-server binary wired in. We always go through `discoverOrSpawn` so we
 * inherit the same auth-token / runtime-file handshake the CLI and supervisor
 * use — no special trust path here.
 *
 * The daemon is spawned attached (`detached: false`) so the caller owns
 * teardown. `stderr` is piped through to a log file when requested; without
 * a log path it's still piped (can't be ignored, the daemon may produce a
 * lot of output) but discarded.
 */
export async function spawnTrialDaemon(opts: SpawnTrialDaemonOptions): Promise<TrialDaemon> {
  const daemonEntry = resolveDaemonEntry(import.meta.url);
  assertServiceDistArtifact(daemonEntry);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEZEL_HOME: opts.home,
    ...(opts.llamaBin ? { GEZEL_LLAMA_SERVER_BIN: opts.llamaBin } : {}),
    ...(opts.sdBin ? { GEZEL_SD_SERVER_BIN: opts.sdBin } : {}),
    GEZEL_LOG_LEVEL: process.env.GEZEL_LOG_LEVEL ?? 'debug',
    // Skip system-toolsets bootstrap (playwright install + browser
    // download). Eval scenarios don't drive `browser_*` tools, and
    // the bootstrap's `pnpm install` for @playwright/mcp on a fresh
    // GEZEL_HOME runs in the background but its child process
    // inherits the daemon's stdio — when the daemon's stdio is piped
    // to us, pnpm + playwright's multi-MB progress output fills the
    // OS pipe buffer and back-pressures the daemon's HTTPS server
    // (TLS handshake hangs, eval `client.updateConfig` deadlocks).
    // Setting this env keeps the trial home tools-free, which is
    // what the scenarios want anyway.
    GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    // Hermetic trials: never reach the npm registry from an eval step.
    // Declines EVERY npm_install (including the shipped no-approval
    // allowlist) with a built-ins steer; see workspace/npm.ts. Evals
    // must run on local faked data only — a registry fetch mid-trial
    // is both a hermeticity leak and a flake source (registry outages
    // would read as model failures).
    GEZEL_NPM_INSTALL_OFFLINE: '1',
    // Force file-backed secret store. The default
    // `OS keychain` path tries to write the per-launch eval auth
    // token into the user's macOS keychain, which on a locked /
    // never-unlocked-this-session keychain can pop a Touch ID prompt
    // (invisible to a headless eval) and hang the
    // `applyCredentialPatch` call — `client.updateConfig` deadlocks
    // forever. The file store writes to the trial home which is
    // wiped on cleanup, so there's no cross-trial leak risk to
    // worry about.
    GEZEL_SECRETS_BACKEND: 'file',
    // Tighten the llama-cpp stream-idle watchdog so the salvage path
    // (see `provider.ts` `recoveredFromIdleStall`) fires BEFORE the
    // harness's retry-loop kills the trial. Default is 5 min, harness
    // retry-loop fast-path commonly fires at 2-3 min of sniff-plateau —
    // the watchdog never got a chance to commit buffered content. 120s
    // lets a stuck stream close cleanly with a salvage warning while
    // staying well above any normal between-chunk gap. Wild-caught
    // squisq-review (qwen3.6): 200+ chunks streamed then
    // silence, harness killed the trial, zero assistant messages
    // committed, no usable artifact.
    GEZEL_LLAMA_CPP_STREAMING_IDLE_MS: process.env.GEZEL_LLAMA_CPP_STREAMING_IDLE_MS ?? '120000',
    // A fresh GEZEL_HOME is NOT sufficient isolation on a machine with a
    // packaged Gezel installed. That install registers a machine-engine
    // system service, and a user daemon is built to find it: it hands
    // native inference to the machine engine and mounts its
    // machine-shared gezels. Both behaviours are correct in production
    // and ruinous here — the trial's model is loaded in the trial's
    // engine, not the service's, so every turn dies on
    // `/v1/remote/admit -> 404 model_not_loaded`, and the "fresh" home
    // arrives carrying another install's gezels and tasks.
    //
    // Wild-caught on an arcade-deluxe run that failed at 4% GPU
    // utilisation with zero model turns, having adopted 4 machine-shared
    // gezels and 44 tasks it never created. Silent: nothing in the trial
    // log says "your results came from somewhere else".
    //
    // Pointing the shared-home override at a path with no marker file is
    // what disables discovery (see `machineSharedHome` in core/paths).
    GEZEL_DISABLE_MACHINE_ENGINE: process.env.GEZEL_DISABLE_MACHINE_ENGINE ?? '1',
    GEZEL_MACHINE_SHARED_HOME:
      process.env.GEZEL_MACHINE_SHARED_HOME ?? join(opts.home, '.no-machine-shared'),
    ...opts.extraEnv,
  };

  // Pipe + drain. We CAN safely pipe stdio now because
  // `GEZEL_SKIP_SYSTEM_BOOTSTRAP=1` (set above) suppresses the
  // first-run `pnpm install` for `@playwright/mcp` whose multi-MB
  // progress output was the original cause of the pipe-buffer
  // back-pressure deadlock. Without bootstrap, the only stdout/stderr
  // is the daemon's structured logger. It drains continuously into the run
  // dir's `daemon.log` for postmortem, with a hard head+tail bound below in
  // case a native engine enters a log loop.
  //
  // Daemon logs are critical for debugging eval failures: the
  // chat-manager's "stalled session" / "model produced no visible
  // content" / continuation-nudge trace lines all live in INFO-level
  // log output. Without piping them to disk, an eval failure shows
  // only the empty session JSON and the user has to re-run with a
  // different setup to diagnose. With this in place, every trial dir
  // includes the full daemon log.
  const result = await discoverOrSpawn({
    daemonEntry,
    detached: false,
    stdio: 'pipe',
    home: opts.home,
    env,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });

  // Sink BOTH stdout and stderr into a single chronological log file
  // alongside the trial's other captures. The historical caller's
  // `stderrLogPath` becomes a `daemon.log` path — both streams
  // interleave into it. The bounded sink preserves startup provenance and the
  // latest diagnostics without allowing an unattended trial to exhaust disk.
  let daemonLogDrain: Promise<void> | undefined;
  if (opts.stderrLogPath && result.child) {
    const sink = new BoundedDaemonLogSink(opts.stderrLogPath);
    daemonLogDrain = new Promise((resolve) => sink.once('close', resolve));
    const streams = [result.child.stdout, result.child.stderr].filter(
      (stream): stream is NonNullable<typeof stream> => stream !== null,
    );
    for (const stream of streams) stream.pipe(sink, { end: false });
    result.child.once('close', () => sink.end());
    sink.once('error', (error) => {
      // Logging must never back-pressure the daemon after a filesystem error.
      // Unpipe and explicitly resume both streams so the trial can still end
      // and report the log failure instead of deadlocking on a full OS pipe.
      console.warn(
        `[spawn] daemon log disabled after write failure (${error instanceof Error ? error.message : error})`,
      );
      for (const stream of streams) {
        stream.unpipe(sink);
        stream.resume();
      }
    });
  } else {
    // No log path provided — drain to /dev/null equivalent so the
    // child doesn't block on a full pipe buffer.
    result.child?.stdout?.resume();
    result.child?.stderr?.resume();
  }

  return { ...result, home: opts.home, ...(daemonLogDrain ? { daemonLogDrain } : {}) };
}

/**
 * Stop a spawned daemon through the cross-platform ownership channel.
 * Closing stdin lets gezeld run its cleanup hooks (and also happens if the
 * eval runner crashes). After `gracefulMs`, the shared helper force-stops the
 * full Windows process tree or uses the POSIX signal ladder. A final
 * process-table sweep catches engines left by an already-abrupt daemon exit.
 */
export async function shutdownTrialDaemon(
  spawned: TrialDaemon,
  gracefulMs = 10_000,
): Promise<void> {
  await stopOwnedDaemon(spawned.child, undefined, {
    graceMs: gracefulMs,
    forceMs: Math.min(gracefulMs, 3_000),
  });
  await spawned.daemonLogDrain;
  await reapTrialNativeChildren(spawned.home);
}

async function reapTrialNativeChildren(home: string): Promise<void> {
  const victims = await findTrialNativeChildren(home);
  if (victims.length === 0) return;
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const pid of victims) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export async function findTrialNativeChildren(
  home: string,
  options: {
    platform?: NodeJS.Platform;
    listProcesses?: typeof listProcessSnapshots;
  } = {},
): Promise<number[]> {
  try {
    const platform = options.platform ?? process.platform;
    const homeNeedle = normalizeCommandForPlatform(home, platform);
    return (await (options.listProcesses ?? listProcessSnapshots)({ platform }))
      .filter(
        ({ pid, command }) =>
          pid !== process.pid &&
          normalizeCommandForPlatform(command, platform).includes(homeNeedle) &&
          // The MLX server (`python …/gezel_mlx_server.py --model <home>/…`)
          // was missing here, so MLX trials orphaned their server on teardown —
          // and MLX pins the model in WIRED Metal memory, which accumulated
          // across a matrix until the machine thrashed (wild-caught:
          // a single leaked qwen3.6-27b-q8 server held ~41 GB wired). Match it
          // alongside the llama.cpp / sd-cpp native servers.
          // ds4-server (DeepSeek-V4) is a long-lived native engine like
          // llama-server; an unreaped one orphans tens of GB of WIRED Metal
          // RAM after a trial (same failure mode as the MLX leak above —
          // fatal on a 64GB box), so it must be matched here too.
          isGezelEngineCommand(command),
      )
      .map(({ pid }) => pid);
  } catch (err) {
    // Loud, not silent: failed process discovery means engines can leak
    // across trials. This caught both the historical macOS `ps` keyword bug
    // and the Windows no-`ps` gap that left GPU servers resident.
    console.warn(
      `[spawn] findTrialNativeChildren: process snapshot failed (${err instanceof Error ? err.message : err}) — native engine reap skipped`,
    );
    return [];
  }
}

function normalizeCommandForPlatform(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
}
