/**
 * Per-trial performance metrics collector.
 *
 * Captures three categories of signal so different (hardware × OS × model
 * × hosting-framework) combos are comparable across trials:
 *
 *   1. Host info — recorded once at trial start. CPU model, RAM, GPU,
 *      OS, framework. Lives in `<runDir>/host.json`.
 *   2. Process samples — the daemon process subtree polled every
 *      `sampleIntervalMs` (`ps` on POSIX, `Win32_Process` via PowerShell
 *      on Windows). Peak RSS + peak CPU% retained; raw samples
 *      ring-buffered for the report. Lives inside `metrics.json`.
 *   3. GPU samples — `nvidia-smi` polled every `sampleIntervalMs` when
 *      available. Skipped silently on hosts without NVIDIA.
 *   4. Token usage — pulled from the trial daemon's `/api/usage` once at
 *      shutdown. Best-effort; missing on providers that don't surface
 *      usage (Copilot CLI under some configurations).
 *
 * What this is NOT yet:
 *   - Per-turn TTFT / prefill time. Those live in the chat-events SSE
 *     stream and need a separate subscriber that reads through the
 *     daemon's bearer-token-auth HTTP API. Tier 5a v1 leaves this for
 *     a follow-up; the wall-clock + RSS + GPU axes already deliver the
 *     hardware-comparison story.
 *   - Cross-framework normalization. The shape here matches llama-cpp /
 *     gezel-service today; an MLX-only or Ollama-only trial will see
 *     reduced fields and the score-trial output marks them `n/a`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import type { GezelClient } from '@bendyline/gezel-client/node';

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  /** OS release string from `os.release()` — kernel version on Linux, Darwin build, NT build. */
  osRelease: string;
  /** Number of logical CPUs. */
  cpuCount: number;
  /** Model name of the first CPU entry; useful for human-readable comparison rows. */
  cpuModel: string;
  /** Total system RAM in GB, rounded. */
  totalRamGb: number;
  /** GPU model (NVIDIA-only on Linux/Win for v1; null on hosts without nvidia-smi). */
  gpuModel: string | null;
  /** Which engine the trial was driven by. */
  framework: string;
  /** Resolved binary path the harness picked — encodes the variant (cpu/cuda/vulkan/metal). */
  frameworkBinary: string | null;
}

export interface ProcessSample {
  atMs: number;
  rssKb: number;
  /** Daemon CPU% as reported by `ps`; can briefly exceed 100 on multi-core. */
  cpuPercent: number;
}

export interface GpuSample {
  atMs: number;
  utilPercent: number;
  memUsedMb: number;
  memTotalMb: number;
}

export interface TrialMetrics {
  /** Wall-clock samples taken during the trial. */
  process: {
    sampleCount: number;
    peakRssMb: number;
    peakCpuPercent: number;
    /** First and last sample timestamps relative to start. */
    firstAtMs: number | null;
    lastAtMs: number | null;
  };
  gpu: {
    available: boolean;
    sampleCount: number;
    peakUtilPercent: number;
    peakMemUsedMb: number;
    memTotalMb: number;
  };
  /** Token usage queried at shutdown via `client.getUsage()`. */
  usage: {
    available: boolean;
    /** Total input tokens summed across all providers since daemon boot. */
    totalInputTokens?: number;
    totalOutputTokens?: number;
    /** Aggregate billable cost in USD when the provider reports it. */
    totalCostUsd?: number;
    /** Raw per-provider snapshot — kept for cross-framework analysis. */
    rawProviders?: unknown;
    /**
     * Where the token counts came from. `http` = the daemon's
     * `/api/usage` tracker (cloud / CLI providers populate it).
     * `llama-server-log` = parsed from llama.cpp's per-request timing
     * lines in `daemon.log` — the local llama-cpp path doesn't feed the
     * usage tracker, so this is the only on-device token source.
     */
    source?: 'http' | 'llama-server-log';
  };
  /**
   * Coarse derived axes the score-trial layer formats for the postmortem.
   * Computed at trial end from process samples + run duration.
   */
  derived: {
    /** Trial wall-clock duration in ms. */
    durationMs: number;
    /**
     * Tokens/sec. When llama-server timing lines are available this is
     * the engine's aggregate DECODE throughput (generated tokens /
     * decode seconds) — the headline number people quote. Otherwise it
     * falls back to whole-trial average (total tokens / wall-clock),
     * which includes idle/tool-call time and reads lower. `null` when no
     * token source is available.
     */
    meanTokensPerSec: number | null;
    /**
     * Engine decode throughput (generated tokens / decode seconds) from
     * llama-server timing lines. Same as `meanTokensPerSec` on the local
     * llama-cpp path; `null` when no engine log was parsed.
     */
    genTokensPerSec?: number | null;
    /** Engine prefill throughput (prompt tokens / prefill seconds); `null` when unavailable. */
    promptTokensPerSec?: number | null;
    /**
     * Peak RSS in MB — repeated from `process.peakRssMb` for top-level
     * convenience. `null` (not `0`) when local sampling was disabled
     * for a CLI-wrapper or cloud provider — the daemon's idle RSS
     * wouldn't reflect any meaningful model work, so we report
     * "didn't sample" rather than "0 MB," which a postmortem reader
     * could otherwise misread as "the model used no RAM."
     */
    peakRssMb: number | null;
    /** Peak GPU util % — repeated from `gpu.peakUtilPercent`; null when no GPU was sampled. */
    peakGpuUtilPercent: number | null;
    /**
     * Normalized billing summary for the active chat provider. Surfaces
     * the cost surface that actually meters the provider — pay-per-token
     * for SDK providers (openai, anthropic, codex-cli), monthly-
     * interaction quota for Copilot. Postmortems should render this
     * over the raw `usage` block: 945/1500 used premium interactions
     * is a more actionable number for a Copilot user than "164k input
     * tokens" (which Copilot doesn't bill on at all).
     *
     * `null` when no provider data is available (early-spawn failure,
     * unknown provider shape).
     */
    billing: TrialBilling | null;
  };
}

/**
 * Normalized cross-provider billing summary. Limited quotas (Copilot's
 * monthly premium-interaction cap) and pay-per-token totals are
 * different surfaces — a single trial can only meaningfully report one
 * or the other, but the rendering postmortem reads both fields so the
 * shape stays uniform regardless of provider.
 */
export interface TrialBilling {
  /** Provider name reporting these numbers. */
  provider: string;
  /**
   * Monthly-quota-style cost (Copilot premium_interactions). Empty
   * array for token-billed providers. We surface ALL non-unlimited
   * buckets — usually one, but the surface supports future per-class
   * quotas (chat vs. completions vs. premium).
   */
  limitedQuota: Array<{
    name: string;
    used: number;
    limit: number;
    remainingPercent: number;
    resetDate?: string;
  }>;
  /**
   * Token-billing surface. Populated for SDK + CLI-wrapper providers
   * that report token counts (codex-cli, openai, anthropic, etc.).
   * Copilot reports tokens too but doesn't bill on them — for Copilot,
   * the `limitedQuota` field is the meaningful cost. Postmortems
   * should render BOTH when both are present so the reader can see
   * the full picture.
   */
  tokens: {
    input: number;
    output: number;
    /** USD when the provider reports it; omitted for providers that don't. */
    costUsd?: number;
  } | null;
}

// ── HostInfo capture ───────────────────────────────────────────────

export function captureHostInfo(opts: {
  framework: string;
  frameworkBinary: string | null;
}): HostInfo {
  const cpuList = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: process.arch,
    osRelease: release(),
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    totalRamGb: Math.round(totalmem() / 1024 ** 3),
    gpuModel: detectGpuModel(),
    framework: opts.framework,
    frameworkBinary: opts.frameworkBinary,
  };
}

function detectGpuModel(): string | null {
  // Single-shot nvidia-smi query. On hosts without nvidia-smi this errors
  // out and we return null — the GPU sampler does the same probe and
  // gracefully no-ops. AMD ROCm detection would go here too (rocm-smi)
  // but isn't wired yet; the eval harness today only runs CUDA-variant
  // binaries when CUDA is detected, so the ROCm path is unexercised.
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status === 0) {
      const name = r.stdout.split('\n')[0]?.trim();
      if (name) return name;
    }
  } catch {
    /* fall through to the Apple-Silicon probe */
  }
  // Apple Silicon: the GPU is an on-die part of the SoC with no
  // nvidia-smi equivalent, so the discrete-GPU query above returns
  // nothing and the field would otherwise be null on every Mac. Report
  // the chip brand string ("Apple M4 Max") as the GPU model — it's the
  // integrated GPU, and it makes host.json self-describing for the
  // hardware-comparison rows. Utilization/memory still aren't sampled
  // (no non-root API), so those stay honestly absent rather than 0.
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const brand = r.status === 0 ? r.stdout.trim() : '';
      if (brand) return `${brand} (integrated GPU)`;
    } catch {
      /* sysctl missing — give up */
    }
  }
  return null;
}

// ── PerfCollector ──────────────────────────────────────────────────

/**
 * Active collector. Owns the polling intervals + sample buffers. The
 * runner calls `start(pid)` after spawning the trial daemon and `stop()`
 * before shutdown so the final usage probe gets a chance to land.
 */
export class PerfCollector {
  private readonly startedAt = Date.now();
  private readonly processSamples: ProcessSample[] = [];
  private readonly gpuSamples: GpuSample[] = [];
  private readonly sampleIntervalMs: number;
  private readonly log: (line: string) => void;
  private readonly client: GezelClient;
  private readonly enableLocalSampling: boolean;
  private readonly daemonLogPath?: string;
  private stopped = false;
  private loop?: Promise<void>;
  /**
   * Previous Windows CPU-time reading, for turning cumulative CPU ticks
   * into an instantaneous percent via cross-sample deltas. Unused on
   * POSIX (where `ps` reports `pcpu` directly).
   */
  private prevWinCpu?: { atMs: number; cpuTime100ns: number };

  constructor(opts: {
    sampleIntervalMs?: number;
    log: (line: string) => void;
    client: GezelClient;
    /**
     * Path to the trial's `daemon.log`. When set (local-engine trials),
     * `stop()` parses llama-server's per-request timing lines out of it
     * for on-device token counts + tokens/sec — the only token source
     * on the local llama-cpp path, which doesn't feed the usage tracker.
     */
    daemonLogPath?: string;
    /**
     * When false, skip the `ps` + `nvidia-smi` samplers and just track
     * duration + usage. Right for CLI-wrapper and cloud providers:
     * the in-process daemon's RSS isn't doing the model work, so
     * reporting it as "peak RSS" in the postmortem is misleading.
     * Usage tokens still come through via the daemon's HTTP API.
     * Defaults to true so local-engine trials keep their existing
     * behaviour.
     */
    enableLocalSampling?: boolean;
  }) {
    this.sampleIntervalMs = opts.sampleIntervalMs ?? 5_000;
    this.log = opts.log;
    this.client = opts.client;
    this.enableLocalSampling = opts.enableLocalSampling ?? true;
    this.daemonLogPath = opts.daemonLogPath;
  }

  start(daemonPid: number): void {
    if (this.loop) return;
    if (!this.enableLocalSampling) {
      this.log(
        `[perf] starting collector for pid=${daemonPid} interval=${this.sampleIntervalMs}ms (usage-only — process + GPU sampling disabled for non-local provider)`,
      );
    } else {
      this.log(
        `[perf] starting collector for pid=${daemonPid} interval=${this.sampleIntervalMs}ms`,
      );
    }
    this.loop = this.runLoop(daemonPid);
  }

  private async runLoop(pid: number): Promise<void> {
    while (!this.stopped) {
      if (this.enableLocalSampling) {
        const at = Date.now() - this.startedAt;
        if (process.platform === 'win32') {
          // Windows has no `ps`; Win32_Process gives RSS + cumulative CPU
          // ticks, and we derive an instantaneous CPU% from the delta.
          const w = sampleProcessTreeWin(pid);
          if (w) {
            const curr = { atMs: at, cpuTime100ns: w.cpuTime100ns };
            const cpuPercent = winCpuPercent(this.prevWinCpu, curr);
            this.prevWinCpu = curr;
            this.processSamples.push({ atMs: at, rssKb: w.rssKb, cpuPercent });
          }
        } else {
          const ps = sampleProcessTree(pid);
          if (ps) this.processSamples.push({ atMs: at, ...ps });
        }
        const gpu = sampleNvidia();
        if (gpu) this.gpuSamples.push({ atMs: at, ...gpu });
      }
      // Sleep in small steps so stop() exits quickly. Even with
      // sampling disabled we still spin so `stop()` can be awaited
      // safely and any future per-tick work has a home.
      const deadline = Date.now() + this.sampleIntervalMs;
      while (Date.now() < deadline && !this.stopped) {
        await wait(Math.min(250, deadline - Date.now()));
      }
    }
  }

  async stop(): Promise<TrialMetrics> {
    this.stopped = true;
    if (this.loop) await this.loop;

    // Final usage probe before the daemon goes away. Best-effort —
    // network failure / missing endpoint just leaves usage `available:
    // false`.
    let usage: TrialMetrics['usage'] = { available: false };
    try {
      const got = await this.client.getUsage();
      // Got is shaped like `{ providers: {...}, total: {...} }` (see
      // service/src/usage). We don't want to encode the full shape here
      // — pass through what we can normalize, retain raw for downstream
      // analysis.
      // biome-ignore lint/suspicious/noExplicitAny: usage shape is intentionally provider-shaped + open
      const u = got as any;
      usage = {
        available: true,
        ...(typeof u?.total?.inputTokens === 'number'
          ? { totalInputTokens: u.total.inputTokens }
          : {}),
        ...(typeof u?.total?.outputTokens === 'number'
          ? { totalOutputTokens: u.total.outputTokens }
          : {}),
        ...(typeof u?.total?.costUsd === 'number' ? { totalCostUsd: u.total.costUsd } : {}),
        rawProviders: u?.providers ?? null,
      };
    } catch (err) {
      this.log(
        `[perf] usage probe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // On the local llama-cpp path the daemon's usage tracker stays empty
    // (the provider doesn't record turns), so the HTTP probe above
    // returns no token totals. llama-server still prints per-request
    // `prompt eval time` / `eval time` timing summaries, which the
    // daemon mirrors into daemon.log under the `[llama-server]` prefix —
    // parse those for real prefill/decode token counts + throughput.
    // This is what makes tokens/sec measurable on macOS/Metal, where
    // neither nvidia-smi nor getUsage supplies it.
    let engineTimings: LlamaCppTimings | null = null;
    // For local engines the daemon log is the authoritative per-request token
    // + tokens/sec source — llama-server omits usage over HTTP, and ds4-server's
    // usage tracker undercounts vs its own per-request logs — so always parse it
    // here regardless of any partial HTTP usage the tracker may also hold.
    if (this.enableLocalSampling && this.daemonLogPath) {
      try {
        const logText = await readFile(this.daemonLogPath, 'utf8');
        // llama-server and ds4-server print different per-request timing
        // formats; a trial is single-engine, so at most one parser matches.
        engineTimings = parseLlamaCppTimings(logText) ?? parseDs4Timings(logText);
      } catch {
        /* no log / unreadable — leave usage untouched */
      }
      if (engineTimings) {
        usage = {
          ...usage,
          available: true,
          source: 'llama-server-log',
          totalInputTokens: engineTimings.promptTokens,
          totalOutputTokens: engineTimings.genTokens,
        };
        this.log(
          `[perf] tokens from engine log: ${engineTimings.promptTokens} in / ${engineTimings.genTokens} out · decode ${engineTimings.genTokensPerSec ?? 'n/a'} t/s · prefill ${engineTimings.promptTokensPerSec ?? 'n/a'} t/s · ${engineTimings.requestCount} requests`,
        );
      }
    } else if (usage.totalInputTokens !== undefined || usage.totalOutputTokens !== undefined) {
      usage = { ...usage, source: 'http' };
    }

    const peakRssKb = this.processSamples.reduce((m, s) => Math.max(m, s.rssKb), 0);
    const peakCpu = this.processSamples.reduce((m, s) => Math.max(m, s.cpuPercent), 0);
    const peakGpu = this.gpuSamples.reduce((m, s) => Math.max(m, s.utilPercent), 0);
    const peakGpuMem = this.gpuSamples.reduce((m, s) => Math.max(m, s.memUsedMb), 0);
    const gpuMemTotal = this.gpuSamples[0]?.memTotalMb ?? 0;
    const durationMs = Date.now() - this.startedAt;
    const totalTokens = (usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0);
    // Prefer the engine's true decode rate; fall back to a whole-trial
    // average (includes idle + tool-call time, so it reads lower) when
    // only HTTP usage totals are available.
    const meanTokensPerSec =
      engineTimings?.genTokensPerSec ??
      (usage.available && durationMs > 0 && totalTokens > 0
        ? Math.round((totalTokens / (durationMs / 1000)) * 100) / 100
        : null);

    return {
      process: {
        sampleCount: this.processSamples.length,
        peakRssMb: Math.round(peakRssKb / 1024),
        peakCpuPercent: Math.round(peakCpu * 10) / 10,
        firstAtMs: this.processSamples[0]?.atMs ?? null,
        lastAtMs: this.processSamples[this.processSamples.length - 1]?.atMs ?? null,
      },
      gpu: {
        available: this.gpuSamples.length > 0,
        sampleCount: this.gpuSamples.length,
        peakUtilPercent: Math.round(peakGpu * 10) / 10,
        peakMemUsedMb: peakGpuMem,
        memTotalMb: gpuMemTotal,
      },
      usage,
      derived: {
        durationMs,
        meanTokensPerSec,
        genTokensPerSec: engineTimings?.genTokensPerSec ?? null,
        promptTokensPerSec: engineTimings?.promptTokensPerSec ?? null,
        // `null` when local sampling was disabled — readers should
        // see "n/a", not "0 MB peak RSS" (which reads as a real
        // measurement of zero).
        peakRssMb: this.enableLocalSampling ? Math.round(peakRssKb / 1024) : null,
        peakGpuUtilPercent:
          this.enableLocalSampling && this.gpuSamples.length > 0
            ? Math.round(peakGpu * 10) / 10
            : null,
        billing: extractBilling(usage.rawProviders),
      },
    };
  }
}

/**
 * Pull the per-provider billing data out of the raw usage snapshot and
 * normalize it for the postmortem template. Exported for testing.
 *
 * Returns `null` when no provider data is present — the postmortem
 * should then render "n/a" for the billing section. When a provider IS
 * present, returns a single `TrialBilling` for the first provider with
 * any non-zero activity. Eval trials are one chat-provider each, so
 * picking the first match is sound.
 */
export function extractBilling(rawProviders: unknown): TrialBilling | null {
  if (!rawProviders || typeof rawProviders !== 'object') return null;
  // biome-ignore lint/suspicious/noExplicitAny: provider shapes are intentionally open
  const map = rawProviders as Record<string, any>;
  for (const [provider, data] of Object.entries(map)) {
    if (!data || typeof data !== 'object') continue;
    const hasActivity =
      (typeof data.totalTurns === 'number' && data.totalTurns > 0) ||
      (typeof data.totalTokensIn === 'number' && data.totalTokensIn > 0);
    if (!hasActivity) continue;

    // Limited quotas — currently a Copilot-only surface. We filter
    // out unlimited buckets (`chat`, `completions` on most plans);
    // surfacing "0 / unlimited" is noise.
    const limitedQuota: TrialBilling['limitedQuota'] = [];
    if (Array.isArray(data.quotaBuckets)) {
      for (const b of data.quotaBuckets) {
        if (!b || typeof b !== 'object') continue;
        if (b.isUnlimited === true) continue;
        if (typeof b.used !== 'number' || typeof b.limit !== 'number') continue;
        limitedQuota.push({
          name: String(b.name ?? 'unknown'),
          used: b.used,
          limit: b.limit,
          remainingPercent: typeof b.remainingPercent === 'number' ? b.remainingPercent : 0,
          ...(typeof b.resetDate === 'string' ? { resetDate: b.resetDate } : {}),
        });
      }
    }

    const tokens =
      typeof data.totalTokensIn === 'number' && typeof data.totalTokensOut === 'number'
        ? {
            input: data.totalTokensIn,
            output: data.totalTokensOut,
            ...(typeof data.totalCost === 'number' && data.totalCost > 0
              ? { costUsd: data.totalCost }
              : {}),
          }
        : null;

    return {
      provider,
      limitedQuota,
      tokens,
    };
  }
  return null;
}

// ── Samplers ───────────────────────────────────────────────────────

/**
 * Sum (rssKb, cpu%) across `rootPid` and ALL its descendants, given the
 * raw output of `ps -axo pid=,ppid=,rss=,pcpu=`. Exported pure for tests.
 *
 * Why a subtree, not a single PID: the trial daemon is a ~400 MB Node
 * process that spawns the real model engine as a child — `llama-server`
 * holding ~20 GB of weights, plus an optional `sd-server` for image
 * scenarios. Sampling only the daemon PID (the old behaviour) reported
 * the Node wrapper's RSS and entirely missed the model's memory, which
 * is the number a hardware-comparison reader actually wants. Summing the
 * subtree captures the whole trial footprint in one `ps` call.
 *
 * Returns null when `rootPid` isn't present in the snapshot (already
 * exited) so the caller drops the sample rather than recording 0.
 */
export function sumProcessTree(
  psOutput: string,
  rootPid: number,
): { rssKb: number; cpuPercent: number; procCount: number } | null {
  const childrenOf = new Map<number, number[]>();
  const rssOf = new Map<number, number>();
  const cpuOf = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [pidStr, ppidStr, rssStr, cpuStr] = t.split(/\s+/);
    const pid = Number.parseInt(pidStr ?? '', 10);
    const ppid = Number.parseInt(ppidStr ?? '', 10);
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    rssOf.set(pid, Number.parseInt(rssStr ?? '0', 10) || 0);
    cpuOf.set(pid, Number.parseFloat(cpuStr ?? '0') || 0);
    const sibs = childrenOf.get(ppid);
    if (sibs) sibs.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  if (!rssOf.has(rootPid)) return null;
  let rssKb = 0;
  let cpuPercent = 0;
  let procCount = 0;
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    rssKb += rssOf.get(pid) ?? 0;
    cpuPercent += cpuOf.get(pid) ?? 0;
    procCount += 1;
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return { rssKb, cpuPercent, procCount };
}

/**
 * One subtree sample for `rootPid` on POSIX. One `ps` fork per poll
 * regardless of tree size. `ps` is on every POSIX host we care about
 * (Linux + macOS); Windows goes through {@link sampleProcessTreeWin}
 * instead, since `ps` doesn't exist there.
 */
function sampleProcessTree(rootPid: number): { rssKb: number; cpuPercent: number } | null {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    const summed = sumProcessTree(r.stdout, rootPid);
    if (!summed) return null;
    return { rssKb: summed.rssKb, cpuPercent: summed.cpuPercent };
  } catch {
    return null;
  }
}

/**
 * Windows analog of {@link sampleProcessTree}. `ps` doesn't exist on
 * Windows, so pull pid / parent pid / working-set / cumulative CPU time
 * from `Win32_Process` via PowerShell CIM, emitting the same
 * whitespace-separated `pid ppid rssKb cpuTicks` shape {@link sumProcessTree}
 * already parses. WorkingSetSize (bytes → KB) is the RSS analog; the 4th
 * column carries CUMULATIVE CPU time in 100-ns ticks (UserModeTime +
 * KernelModeTime) rather than an instantaneous percent — `Win32_Process`
 * has no `pcpu` equivalent — so {@link winCpuPercent} turns the summed
 * ticks into a percent from the previous sample's delta.
 *
 * Returns null (caller drops the sample) when the root pid is already
 * gone from the snapshot or PowerShell isn't spawnable, mirroring the
 * POSIX path's "record nothing rather than 0" behaviour.
 */
function sampleProcessTreeWin(rootPid: number): { rssKb: number; cpuTime100ns: number } | null {
  try {
    // `'{0} {1} {2} {3}' -f …` renders one line per process; sumProcessTree
    // reads the 4th field as its "cpu" column, so we hand it the cumulative
    // tick count there and read the sum back out below.
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f " +
      '$_.ProcessId, $_.ParentProcessId, [int64]($_.WorkingSetSize/1024), ' +
      '($_.UserModeTime + $_.KernelModeTime) }';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    const summed = sumProcessTree(r.stdout, rootPid);
    if (!summed) return null;
    // sumProcessTree summed the 4th column (cumulative CPU ticks) into
    // `.cpuPercent`; it's ticks here, not a percent — see the docstring.
    return { rssKb: summed.rssKb, cpuTime100ns: summed.cpuPercent };
  } catch {
    return null;
  }
}

/**
 * Instantaneous subtree CPU% from two cumulative-CPU-time readings on the
 * Windows path. `cpuTime100ns` is UserModeTime+KernelModeTime in 100-ns
 * ticks summed across the process subtree; dividing the delta by the
 * wall-clock delta gives a per-core-equivalent percent that, like POSIX
 * `pcpu`, can exceed 100 on multi-core work (we deliberately do NOT divide
 * by core count, to match the POSIX sampler's semantics). Returns 0 for
 * the first sample (no prior baseline) and when the counter goes backwards
 * (a pid was reused, or the subtree shrank). Exported pure for tests.
 */
export function winCpuPercent(
  prev: { atMs: number; cpuTime100ns: number } | undefined,
  curr: { atMs: number; cpuTime100ns: number },
): number {
  if (!prev) return 0;
  const dtMs = curr.atMs - prev.atMs;
  const dCpuMs = (curr.cpuTime100ns - prev.cpuTime100ns) / 10_000; // 100-ns ticks → ms
  if (dtMs <= 0 || dCpuMs < 0) return 0;
  return Math.round((dCpuMs / dtMs) * 1000) / 10;
}

export interface LlamaCppTimings {
  /** Prompt (prefill) tokens summed across all requests. */
  promptTokens: number;
  /** Generated (decode) tokens summed across all requests. */
  genTokens: number;
  /** Prefill wall-clock summed (ms). */
  promptMs: number;
  /** Decode wall-clock summed (ms). */
  genMs: number;
  /** Aggregate decode throughput: genTokens / (genMs/1000); null if no decode time. */
  genTokensPerSec: number | null;
  /** Aggregate prefill throughput: promptTokens / (promptMs/1000); null if no prefill time. */
  promptTokensPerSec: number | null;
  /** Number of per-request timing blocks aggregated. */
  requestCount: number;
}

// llama.cpp server prints, per request:
//   prompt eval time = 89150.04 ms / 15210 tokens ( 5.86 ms per token, 170.61 tokens per second)
//          eval time = 13234.12 ms /   210 tokens (63.02 ms per token,  15.87 tokens per second)
// The prefill line ("prompt eval time") is matched first and skipped by
// the decode regex via the `(?<!prompt )` lookbehind, so the two phases
// never cross-contaminate.
const PROMPT_EVAL_RE = /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;
const DECODE_EVAL_RE = /(?<!prompt )\beval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;

/**
 * Aggregate llama.cpp's per-request timing summaries out of a daemon log.
 * Returns null when the log carries no such lines (non-llama-cpp trial,
 * or generation never completed a request). Exported pure for tests.
 */
export function parseLlamaCppTimings(logText: string): LlamaCppTimings | null {
  let promptTokens = 0;
  let genTokens = 0;
  let promptMs = 0;
  let genMs = 0;
  let requestCount = 0;
  for (const line of logText.split('\n')) {
    const p = PROMPT_EVAL_RE.exec(line);
    if (p) {
      promptMs += Number.parseFloat(p[1] ?? '0');
      promptTokens += Number.parseInt(p[2] ?? '0', 10);
      continue;
    }
    const d = DECODE_EVAL_RE.exec(line);
    if (d) {
      genMs += Number.parseFloat(d[1] ?? '0');
      genTokens += Number.parseInt(d[2] ?? '0', 10);
      requestCount += 1;
    }
  }
  if (requestCount === 0 && promptTokens === 0) return null;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    promptTokens,
    genTokens,
    promptMs,
    genMs,
    genTokensPerSec: genMs > 0 ? round2(genTokens / (genMs / 1000)) : null,
    promptTokensPerSec: promptMs > 0 ? round2(promptTokens / (promptMs / 1000)) : null,
    requestCount,
  };
}

// ds4-server (DwarfStar) prints PER-CHUNK progress lines instead of a single
// per-request summary, e.g. (daemon-wrapped, the relevant tail shown):
//   ds4-server: chat ctx=0..7509:7509 TOOLS prefill chunk 7509/7509 (100%) chunk=156 t/s avg=156.25 t/s 48.06s
//   ds4-server: chat ctx=8258..8308:50 gen=2044 TOOLS DSML_START decoding chunk=11 t/s avg=13.15 t/s 155.42s
// `gen=<N>` is the request's CUMULATIVE decode-token count and the trailing
// `<S>s` is its cumulative decode wall-clock (gen/S equals the printed `avg`).
// A new request begins at `prefill chunk 0/...`, so we bank each request's
// final prefill + decode numbers at the next request-start (and at EOF) and sum
// them into the same aggregate shape parseLlamaCppTimings returns. The prefill
// `chunk <P>/<M>` numerator P is the prompt tokens processed so far, so the last
// prefill line (P==M) carries the full prompt count + total prefill wall-clock.
const DS4_PREFILL_RE = /\bprefill chunk (\d+)\/\d+\s*\([\d.]+%\).*?\bavg=[\d.]+ t\/s\s+([\d.]+)s\b/;
const DS4_DECODE_RE = /\bgen=(\d+)\b.*?\bdecoding\b.*?\bavg=[\d.]+ t\/s\s+([\d.]+)s\b/;

/**
 * Aggregate ds4-server's per-chunk timing lines out of a daemon log, returning
 * the same {@link LlamaCppTimings} shape as {@link parseLlamaCppTimings} (or
 * null when the log carries no ds4 timing lines). Used as the fallback parser
 * for ds4 trials — ds4-server's log format differs entirely from llama.cpp's.
 * Exported pure for tests.
 */
export function parseDs4Timings(logText: string): LlamaCppTimings | null {
  let promptTokens = 0;
  let genTokens = 0;
  let promptMs = 0;
  let genMs = 0;
  let requestCount = 0;
  // Running finals for the request currently being read; each later chunk line
  // overwrites them, so at a request boundary they hold that request's totals.
  let curPromptTokens = 0;
  let curPromptSec = 0;
  let curGenTokens = 0;
  let curGenSec = 0;
  let sawAny = false;
  const flush = () => {
    if (!sawAny) return;
    promptTokens += curPromptTokens;
    promptMs += curPromptSec * 1000;
    genTokens += curGenTokens;
    genMs += curGenSec * 1000;
    requestCount += 1;
    curPromptTokens = 0;
    curPromptSec = 0;
    curGenTokens = 0;
    curGenSec = 0;
    sawAny = false;
  };
  for (const line of logText.split('\n')) {
    const p = DS4_PREFILL_RE.exec(line);
    if (p) {
      // A prefill line once this request has already produced decode tokens
      // marks the start of the NEXT request (prefill → decode → prefill); bank
      // the current one first. Within a single prefill phase curGenTokens is 0,
      // so the running numerator just advances toward the final count.
      if (curGenTokens > 0) flush();
      curPromptTokens = Number.parseInt(p[1] ?? '0', 10);
      curPromptSec = Number.parseFloat(p[2] ?? '0');
      sawAny = true;
      continue;
    }
    const d = DS4_DECODE_RE.exec(line);
    if (d) {
      const gen = Number.parseInt(d[1] ?? '0', 10);
      // `gen=` resets per request; a drop means a new request began with its
      // prompt fully cached (no prefill line emitted) — bank the prior one.
      if (gen < curGenTokens) flush();
      curGenTokens = gen;
      curGenSec = Number.parseFloat(d[2] ?? '0');
      sawAny = true;
    }
  }
  flush(); // bank the final request
  if (requestCount === 0) return null;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    promptTokens,
    genTokens,
    promptMs,
    genMs,
    genTokensPerSec: genMs > 0 ? round2(genTokens / (genMs / 1000)) : null,
    promptTokensPerSec: promptMs > 0 ? round2(promptTokens / (promptMs / 1000)) : null,
    requestCount,
  };
}

/**
 * One sample of GPU util + memory from `nvidia-smi`. Silently returns
 * null on hosts without an NVIDIA GPU (or without nvidia-smi on PATH).
 * The first GPU only — multi-GPU hosts would need a richer schema, not
 * worth designing until a multi-GPU use case shows up.
 *
 * Unified-memory platforms (DGX Spark, Jetson) report memory.used /
 * memory.total as `[N/A]` because there's no discrete VRAM to count —
 * the iGPU shares system RAM. We still want the utilization sample,
 * so memory unparseable → 0 instead of discarding the sample. Only a
 * missing utilization value disqualifies a row.
 */
function sampleNvidia(): { utilPercent: number; memUsedMb: number; memTotalMb: number } | null {
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (r.status !== 0) return null;
    const first = r.stdout.split('\n')[0]?.trim();
    if (!first) return null;
    const [u, used, total] = first.split(/,\s*/);
    const utilPercent = Number.parseFloat(u ?? '0');
    if (Number.isNaN(utilPercent)) return null;
    const usedParsed = Number.parseInt(used ?? '0', 10);
    const totalParsed = Number.parseInt(total ?? '0', 10);
    const memUsedMb = Number.isNaN(usedParsed) ? 0 : usedParsed;
    const memTotalMb = Number.isNaN(totalParsed) ? 0 : totalParsed;
    return { utilPercent, memUsedMb, memTotalMb };
  } catch {
    return null;
  }
}

// ── File output helpers ────────────────────────────────────────────

export async function writeHostInfo(runDir: string, host: HostInfo): Promise<void> {
  const { join } = await import('node:path');
  await writeFile(join(runDir, 'host.json'), `${JSON.stringify(host, null, 2)}\n`);
}

export async function writeMetrics(runDir: string, metrics: TrialMetrics): Promise<void> {
  const { join } = await import('node:path');
  await writeFile(join(runDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
}

// Keep `spawn` imported so we don't break tree-shaking later when we
// upgrade samplers to streaming variants (a long-running nvidia-smi -l
// pipeline avoids the per-poll fork cost). Today's spawnSync usage is
// fine at 5s cadence.
void spawn;
