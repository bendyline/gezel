import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DiscoverOrSpawnResult,
  discoverOrSpawn,
  isGezelEngineCommand,
  listProcessSnapshots,
  resolveDaemonEntry,
  stopOwnedDaemon,
} from '@bendyline/gezel-client/node';

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
};

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
    ...opts.extraEnv,
  };

  // Pipe + drain. We CAN safely pipe stdio now because
  // `GEZEL_SKIP_SYSTEM_BOOTSTRAP=1` (set above) suppresses the
  // first-run `pnpm install` for `@playwright/mcp` whose multi-MB
  // progress output was the original cause of the pipe-buffer
  // back-pressure deadlock. Without bootstrap, the only stdout/stderr
  // is the daemon's structured logger — manageable volume that drains
  // continuously into the run dir's `daemon.log` for postmortem.
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
  // interleave into it.
  if (opts.stderrLogPath && result.child) {
    await mkdir(dirname(opts.stderrLogPath), { recursive: true });
    const sink = createWriteStream(opts.stderrLogPath, { flags: 'a' });
    if (result.child.stdout) result.child.stdout.pipe(sink, { end: false });
    if (result.child.stderr) result.child.stderr.pipe(sink, { end: false });
  } else {
    // No log path provided — drain to /dev/null equivalent so the
    // child doesn't block on a full pipe buffer.
    result.child?.stdout?.resume();
    result.child?.stderr?.resume();
  }

  return { ...result, home: opts.home };
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
