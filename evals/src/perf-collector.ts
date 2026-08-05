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
 *   3. GPU samples — polled from whichever vendor telemetry the host has:
 *      `nvidia-smi`, Windows GPU performance counters (any vendor), or
 *      Linux amdgpu sysfs. The sampler is resolved once at start and carries
 *      its own minimum interval, since their costs differ ~1000x. Skipped
 *      silently on hosts with no GPU telemetry at all.
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
import { existsSync, readFileSync } from 'node:fs';
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
  /**
   * GPU model. nvidia-smi first, then Win32_VideoController on Windows (any
   * vendor) and rocm-smi on Linux, then the Apple-Silicon chip brand. Null
   * only when no probe identified an adapter.
   */
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
  /** null on unified-memory hosts, where nvidia-smi reports `[N/A]`. */
  memUsedMb: number | null;
  memTotalMb: number | null;
}

export interface SystemMemorySample {
  atMs: number;
  usedMb: number;
  totalMb: number;
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
    /** null when {@link TrialMetrics.gpu.memoryModel} is `unified`. */
    peakMemUsedMb: number | null;
    memTotalMb: number | null;
    /**
     * `discrete` — nvidia-smi reported a real VRAM pool.
     * `unified` — it reported `[N/A]`; the GPU shares system RAM
     * (DGX Spark, Jetson). Read {@link TrialMetrics.systemMemory} for
     * headroom on those hosts.
     * `unknown` — no GPU samples at all.
     */
    memoryModel: 'discrete' | 'unified' | 'unknown';
  };
  /**
   * Host RAM, sampled alongside the process/GPU samplers. Always useful, but
   * it is *the* memory-headroom figure on unified-memory hosts, where the
   * model's weights live in this pool rather than in discrete VRAM.
   */
  systemMemory: {
    sampleCount: number;
    peakUsedMb: number;
    totalMb: number;
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
     * Where the token counts came from. `http` = the daemon's `/api/usage`
     * tracker, summed across providers. `engine-log` = reconstructed from the
     * engine's own lines in `daemon.log` — llama-server and ds4-server print
     * per-request timing blocks; MLX has none, so its figures come from
     * heartbeat + cache lines instead.
     *
     * Named `engine-log` rather than `llama-server-log` since three different
     * engines now feed it.
     */
    source?: 'http' | 'engine-log';
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
  // out and we fall through to the vendor-neutral probes below.
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
    /* fall through to the vendor-neutral probes */
  }
  // Windows: Win32_VideoController names ANY adapter (AMD, Intel, NVIDIA),
  // so an AMD/Vulkan eval host stops reporting `gpuModel: null`. Every trial
  // in the 2026-08-02 core-suite matrix ran on a Radeon AI PRO R9700 and
  // recorded a null model purely because the only probe was nvidia-smi.
  // Basic Display Adapter is the driverless fallback device — naming it
  // would be worse than null, so it's filtered out.
  if (process.platform === 'win32') {
    try {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch "Basic Display" } | Select-Object -First 1).Name',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const name = r.status === 0 ? r.stdout.trim() : '';
      if (name) return name;
    } catch {
      /* fall through */
    }
  }
  // Linux AMD: rocm-smi ships with ROCm. Absent on a plain Vulkan/Mesa box,
  // where the sysfs sampler still works but has no product-name file — null
  // is the honest answer there.
  if (process.platform === 'linux') {
    try {
      const r = spawnSync('rocm-smi', ['--showproductname', '--csv'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0) {
        const name = parseRocmProductName(r.stdout);
        if (name) return name;
      }
    } catch {
      /* fall through */
    }
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
  private readonly systemMemorySamples: SystemMemorySample[] = [];
  private readonly sampleIntervalMs: number;
  private readonly log: (line: string) => void;
  private readonly client: GezelClient;
  private readonly enableLocalSampling: boolean;
  private readonly daemonLogPath?: string;
  private stopped = false;
  private loop?: Promise<void>;
  /**
   * Chosen once at `start()` — see {@link resolveGpuSampler}. `undefined`
   * means "not resolved yet", `null` means "resolved: nothing available".
   */
  private gpuSampler?: GpuSampler | null;
  /** Wall-clock of the last GPU sample, for honoring `minIntervalMs`. */
  private lastGpuSampleAtMs = Number.NEGATIVE_INFINITY;
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
        if (this.gpuSampler === undefined) {
          this.gpuSampler = resolveGpuSampler();
          this.log(
            this.gpuSampler
              ? `[perf] gpu sampler=${this.gpuSampler.kind} interval=${Math.max(this.sampleIntervalMs, this.gpuSampler.minIntervalMs)}ms`
              : '[perf] gpu sampler=none (no GPU telemetry available on this host)',
          );
          if (this.gpuSampler) {
            this.gpuSamples.push({ atMs: at, ...this.gpuSampler.firstReading });
            this.lastGpuSampleAtMs = Date.now();
          }
        }
        if (this.gpuSampler) {
          const gpuIntervalMs = Math.max(this.sampleIntervalMs, this.gpuSampler.minIntervalMs);
          if (Date.now() - this.lastGpuSampleAtMs >= gpuIntervalMs) {
            const gpu = this.gpuSampler.sample();
            this.lastGpuSampleAtMs = Date.now();
            if (gpu) this.gpuSamples.push({ atMs: at, ...gpu });
          }
        }
        // Outside the GPU branch on purpose: host RAM is free to read and is
        // the ONLY memory-headroom signal on a unified-memory host, which is
        // exactly where the GPU sampler reports no memory (or none at all).
        // Nesting this under the sampler would zero it on the hosts that need
        // it most, and throttle it to the GPU interval everywhere else.
        this.systemMemorySamples.push({ atMs: at, ...sampleSystemMemory() });
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
      // Sum across `providers` — `UsageSummary` has NO top-level `total`
      // block. Reading `u.total.*` here was dead code: it silently yielded
      // no token totals for EVERY provider, which is why MLX (and every
      // cloud/CLI provider) reported `outputTokens: 0` while the same
      // numbers sat visibly in `rawProviders`. llama-cpp/ds4 were masked
      // because their log parsers below overwrite these fields anyway.
      const summed = sumProviderTokens(u?.providers);
      usage = {
        available: true,
        ...(summed.inputTokens !== null ? { totalInputTokens: summed.inputTokens } : {}),
        ...(summed.outputTokens !== null ? { totalOutputTokens: summed.outputTokens } : {}),
        ...(summed.costUsd !== null ? { totalCostUsd: summed.costUsd } : {}),
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
      let parsed: EngineTimingParse | null = null;
      try {
        const logText = await readFile(this.daemonLogPath, 'utf8');
        parsed = parseEngineTimings(logText);
      } catch {
        /* no log / unreadable — leave usage untouched */
      }
      if (parsed) {
        engineTimings = parsed.timings;
        usage = resolveUsageTotals(usage, parsed);
        const cached = engineTimings.cachedPromptTokens;
        this.log(
          `[perf] tokens from ${usage.source} (${parsed.engine}): ${usage.totalInputTokens} in / ${usage.totalOutputTokens} out · decode ${engineTimings.genTokensPerSec ?? 'n/a'} t/s · prefill ${engineTimings.promptTokensPerSec ?? 'n/a'} t/s · ${engineTimings.requestCount} requests${cached ? ` · ${cached} prompt tokens served from cache` : ''}`,
        );
      }
    }
    // Not an `else if`: a local engine whose log yields no parseable timings
    // still has usable HTTP totals, and gating the fallback behind the
    // local-sampling branch is what left MLX with no token data at all.
    if (
      usage.source === undefined &&
      (usage.totalInputTokens !== undefined || usage.totalOutputTokens !== undefined)
    ) {
      usage = { ...usage, source: 'http' };
    }

    const peakRssKb = this.processSamples.reduce((m, s) => Math.max(m, s.rssKb), 0);
    const peakCpu = this.processSamples.reduce((m, s) => Math.max(m, s.cpuPercent), 0);
    const peakGpu = this.gpuSamples.reduce((m, s) => Math.max(m, s.utilPercent), 0);
    // A unified-memory host reports `[N/A]` for both fields on every sample,
    // so "no sample carried a number" is the discriminator. Collapsing that to
    // 0 would be indistinguishable from a GPU that genuinely used no memory.
    const gpuMemSamples = this.gpuSamples.filter(
      (s): s is GpuSample & { memUsedMb: number } => s.memUsedMb !== null,
    );
    const peakGpuMem =
      gpuMemSamples.length > 0 ? gpuMemSamples.reduce((m, s) => Math.max(m, s.memUsedMb), 0) : null;
    const gpuMemTotal = this.gpuSamples.find((s) => s.memTotalMb !== null)?.memTotalMb ?? null;
    const memoryModel: 'discrete' | 'unified' | 'unknown' =
      this.gpuSamples.length === 0 ? 'unknown' : peakGpuMem === null ? 'unified' : 'discrete';
    const peakSystemMemUsed = this.systemMemorySamples.reduce((m, s) => Math.max(m, s.usedMb), 0);
    const systemMemTotal = this.systemMemorySamples[0]?.totalMb ?? 0;
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
        memoryModel,
      },
      systemMemory: {
        sampleCount: this.systemMemorySamples.length,
        peakUsedMb: peakSystemMemUsed,
        totalMb: systemMemTotal,
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
/**
 * Sum token/cost totals across every provider in a `/api/usage` snapshot.
 *
 * `UsageSummary` is `{ providers: { <name>: { totalTokensIn, totalTokensOut,
 * totalCost, … } } }` with no aggregate block, so a reader wanting totals has
 * to fold the providers itself. Returns `null` per field when nothing reported
 * it, so "didn't measure" stays distinguishable from a measured zero.
 */
export function sumProviderTokens(rawProviders: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
} {
  if (!rawProviders || typeof rawProviders !== 'object') {
    return { inputTokens: null, outputTokens: null, costUsd: null };
  }
  // biome-ignore lint/suspicious/noExplicitAny: provider shapes are intentionally open
  const map = rawProviders as Record<string, any>;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  for (const data of Object.values(map)) {
    if (!data || typeof data !== 'object') continue;
    if (typeof data.totalTokensIn === 'number')
      inputTokens = (inputTokens ?? 0) + data.totalTokensIn;
    if (typeof data.totalTokensOut === 'number') {
      outputTokens = (outputTokens ?? 0) + data.totalTokensOut;
    }
    if (typeof data.totalCost === 'number') costUsd = (costUsd ?? 0) + data.totalCost;
  }
  return { inputTokens, outputTokens, costUsd };
}

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

/** Which engine's log format produced a {@link LlamaCppTimings}. */
export type EngineLogKind = 'llama-cpp' | 'ds4' | 'mlx';

export interface EngineTimingParse {
  engine: EngineLogKind;
  timings: LlamaCppTimings;
}

/**
 * Parse whichever engine's per-request timing format the daemon log carries,
 * keeping WHICH engine matched — the caller needs it to decide whether the log
 * or the HTTP usage tracker is authoritative (see {@link resolveUsageTotals}).
 * A trial is single-engine, so at most one parser matches.
 */
export function parseEngineTimings(logText: string): EngineTimingParse | null {
  const llama = parseLlamaCppTimings(logText);
  if (llama) return { engine: 'llama-cpp', timings: llama };
  const ds4 = parseDs4Timings(logText);
  if (ds4) return { engine: 'ds4', timings: ds4 };
  const mlx = parseMlxTimings(logText);
  if (mlx) return { engine: 'mlx', timings: mlx };
  return null;
}

/**
 * Decide the final token totals from the HTTP usage tracker and the parsed
 * engine log, and report honestly which one won via `source`.
 *
 * llama-server and ds4-server print EXACT per-request token counts, so their
 * logs replace the tracker's totals outright. The tracker undercounts them
 * badly and silently: in the 2026-08-02 core-suite matrix, 10 of 11 trials
 * disagreed with their own engine log — `tankcombat` reported 54 output tokens
 * for a run that generated 10,823, and `petshop` 271 against 34,401. The old
 * code used `usage.totalOutputTokens ?? timings.genTokens`, so any non-nullish
 * tracker value — including an absurd one — beat the engine log, while
 * `source` was still stamped `engine-log`. Only trials whose tracker happened
 * to be empty (`symptom-debug`) fell through to the correct numbers, which is
 * exactly why the defect stayed invisible.
 *
 * MLX is the deliberate exception: it prints no per-request block, so its
 * figures are reconstructed from heartbeat + cache lines and are the weaker
 * signal. There the tracker wins and the parse only fills gaps.
 *
 * Exported pure for tests.
 */
export function resolveUsageTotals(
  httpUsage: TrialMetrics['usage'],
  parsed: EngineTimingParse,
): TrialMetrics['usage'] {
  // Engine logs are authoritative for EVERY local engine, MLX included.
  // The MLX exception here dated from when its stream-pulse parse was new;
  // in practice the HTTP tracker undercounts MLX ~27× (wild-caught
  // 2026-08-05: `tokens from http (mlx): 429 out` vs 11,887 in the same
  // trial's engine log — the tracker misses in-turn iterations and
  // reasoning), which silently poisoned every long-trial MLX token stat.
  const engineIsAuthoritative = true;
  const inputFromEngine = engineIsAuthoritative || httpUsage.totalInputTokens === undefined;
  const outputFromEngine = engineIsAuthoritative || httpUsage.totalOutputTokens === undefined;
  return {
    ...httpUsage,
    available: true,
    source: inputFromEngine || outputFromEngine ? 'engine-log' : 'http',
    totalInputTokens: inputFromEngine ? parsed.timings.promptTokens : httpUsage.totalInputTokens,
    totalOutputTokens: outputFromEngine ? parsed.timings.genTokens : httpUsage.totalOutputTokens,
  };
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
  /**
   * Prompt tokens served from a warm prefix cache instead of prefilled, when
   * the engine reports the split (MLX does; llama-server does not surface it
   * per-request). Useful for reading prefill cost: a high ratio here against
   * `promptTokens` means reuse is working and prefill is not the bottleneck.
   */
  cachedPromptTokens?: number;
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

// The MLX server reports no per-request timing block, so its throughput has to
// be reconstructed from two other lines the provider already logs:
//   [mlx] stream-active tokens=872 · 85 tok/s
//   [mlx] [cache] reuse cache_id=… cached_tokens=6976 prefilled_tokens=44
// `tokens=` is cumulative WITHIN a turn and resets per turn, so summing every
// pulse would multiply-count; the decode rate is the reliable field.
const MLX_STREAM_RE = /\[mlx\] stream-active tokens=(\d+)(?:\s*·\s*([\d.]+) tok\/s)?/;
const MLX_CACHE_RE = /\[mlx\] \[cache\].*?\bcached_tokens=(\d+)\s+prefilled_tokens=(\d+)/;

/**
 * Reconstruct MLX throughput from the provider's own log lines, in the same
 * {@link LlamaCppTimings} shape as the llama.cpp / ds4 parsers (null when the
 * log carries no MLX signal).
 *
 * Why this exists: MLX was the one local engine with no timing parser, and the
 * HTTP usage path it should have fallen back to was reading a `total` block
 * that `UsageSummary` doesn't have — so every MLX trial reported
 * `decode t/s: n/a` and `outputTokens: 0`, making an engine-vs-engine
 * throughput comparison impossible (2026-07-31 sweep).
 *
 * Two deliberate differences from the other parsers:
 *  - `genTokensPerSec` is the MEDIAN of the per-pulse rates, not
 *    tokens/elapsed. The pulses are a 5 s heartbeat sampled during active
 *    decode only, so they already exclude idle and tool-call time; a median
 *    resists the low first-pulse reading on each turn.
 *  - `promptTokensPerSec` stays null — MLX logs prefill token COUNTS but no
 *    prefill duration, and inventing a rate from turn wall-clock would be
 *    worse than an honest "n/a".
 */
export function parseMlxTimings(logText: string): LlamaCppTimings | null {
  const rates: number[] = [];
  let genTokens = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let requestCount = 0;
  let turnPeakTokens = 0;
  let lastTokens = -1;
  for (const line of logText.split('\n')) {
    const s = MLX_STREAM_RE.exec(line);
    if (s) {
      const tokens = Number(s[1]);
      if (s[2]) {
        const r = Number(s[2]);
        if (Number.isFinite(r) && r > 0) rates.push(r);
      }
      // A non-increasing count means a new turn started: bank the previous
      // turn's peak before tracking the new one.
      if (tokens <= lastTokens) {
        genTokens += turnPeakTokens;
        requestCount += 1;
        turnPeakTokens = tokens;
      } else {
        turnPeakTokens = Math.max(turnPeakTokens, tokens);
      }
      lastTokens = tokens;
      continue;
    }
    const c = MLX_CACHE_RE.exec(line);
    if (c) {
      cachedTokens += Number(c[1]);
      promptTokens += Number(c[2]);
    }
  }
  if (rates.length === 0 && genTokens === 0 && turnPeakTokens === 0 && promptTokens === 0) {
    return null;
  }
  // Bank the final in-flight turn.
  if (turnPeakTokens > 0) {
    genTokens += turnPeakTokens;
    requestCount += 1;
  }
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null;
  return {
    promptTokens,
    genTokens,
    // No per-phase durations available from MLX — see the doc comment.
    promptMs: 0,
    genMs: 0,
    genTokensPerSec: median === null ? null : Math.round(median * 100) / 100,
    promptTokensPerSec: null,
    requestCount,
    ...(cachedTokens > 0 ? { cachedPromptTokens: cachedTokens } : {}),
  };
}

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
 * the iGPU shares system RAM. We still want the utilization sample, so
 * unparseable memory yields `null` and only a missing utilization value
 * disqualifies a row.
 *
 * `null` rather than 0 is load-bearing: these fields previously collapsed
 * to 0, which reads as "the GPU used no memory" and is indistinguishable
 * from a real zero. On the DGX Spark — the one host where 100B-class
 * models get validated — every trial reported `peakMemUsedMb: 0` beside a
 * correct `peakUtilPercent: 96`, silently losing the headroom signal. The
 * substitute on those hosts is {@link TrialMetrics.systemMemory}, since
 * unified memory means system RAM *is* the GPU's memory budget.
 */
/**
 * Host RAM at this instant. Cheap (no subprocess) and always available, which
 * is why it is sampled unconditionally rather than only on unified-memory
 * hosts — it is the memory-headroom signal there, and useful context
 * everywhere else.
 */
function sampleSystemMemory(): { usedMb: number; totalMb: number } {
  const total = totalmem();
  const free = freemem();
  return {
    usedMb: Math.round((total - free) / (1024 * 1024)),
    totalMb: Math.round(total / (1024 * 1024)),
  };
}

/**
 * Parse one `utilization.gpu,memory.used,memory.total` CSV row. Split out from
 * the subprocess call so the `[N/A]` handling is unit-testable without a GPU.
 */
export function parseNvidiaSmiRow(
  row: string,
): { utilPercent: number; memUsedMb: number | null; memTotalMb: number | null } | null {
  const first = row.split('\n')[0]?.trim();
  if (!first) return null;
  const [u, used, total] = first.split(/,\s*/);
  const utilPercent = Number.parseFloat(u ?? '');
  if (Number.isNaN(utilPercent)) return null;
  const usedParsed = Number.parseInt(used ?? '', 10);
  const totalParsed = Number.parseInt(total ?? '', 10);
  return {
    utilPercent,
    memUsedMb: Number.isNaN(usedParsed) ? null : usedParsed,
    memTotalMb: Number.isNaN(totalParsed) ? null : totalParsed,
  };
}

function sampleNvidia(): {
  utilPercent: number;
  memUsedMb: number | null;
  memTotalMb: number | null;
} | null {
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (r.status !== 0) return null;
    return parseNvidiaSmiRow(r.stdout);
  } catch {
    return null;
  }
}

/** One GPU reading, vendor-agnostic. */
export interface GpuReading {
  utilPercent: number;
  /** null when the vendor reports no readable memory pool (see {@link parseNvidiaSmiRow}). */
  memUsedMb: number | null;
  memTotalMb: number | null;
}

/**
 * A selected GPU sampler plus the minimum interval it may be polled at.
 *
 * The interval is per-sampler because their costs differ by more than an
 * order of magnitude: `nvidia-smi` returns in ~50 ms, Linux amdgpu sysfs is
 * three file reads (~1 ms), but Windows `Get-Counter` costs ~1.35 s on this
 * class of host — it enumerates every GPU-engine instance on the box (325 on
 * the 2026-08-02 eval host) and pays PDH init each call. Polling that every
 * 5 s alongside the process sampler would spend ~30% of the trial measuring
 * the trial. Peak-over-trial is a coarse axis, so a slower cadence costs
 * almost nothing in signal.
 */
interface GpuSampler {
  kind: string;
  minIntervalMs: number;
  sample(): GpuReading | null;
  /**
   * The reading taken while probing whether this sampler works. Handed back
   * so the caller can bank it instead of immediately sampling again — on the
   * Windows counter path a discarded probe costs a redundant ~1.4 s.
   */
  firstReading: GpuReading;
}

/** `rocm-smi --showproductname --csv` → the first non-header product name. */
export function parseRocmProductName(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t || /^device/i.test(t)) continue;
    // `card0,Instinct MI210` — the name is the last non-empty CSV cell.
    const cells = t
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const name = cells[cells.length - 1];
    if (name && !/^card\d+$/i.test(name)) return name;
  }
  return null;
}

/**
 * Parse the `GPU <utilPercent> <memUsedBytes>` line emitted by the Windows
 * counter script. Returns null when the script printed nothing (no GPU
 * counters registered, or the PDH query failed and the script swallowed it).
 */
export function parseWindowsGpuCounters(stdout: string, memTotalMb: number): GpuReading | null {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('GPU '));
  if (!line) return null;
  const [, u, mem] = line.trim().split(/\s+/);
  const utilPercent = Number.parseFloat(u ?? '');
  if (!Number.isFinite(utilPercent)) return null;
  const memBytes = Number.parseFloat(mem ?? '0');
  return {
    // Per-process engine utilization can sum fractionally past 100 under
    // rounding; clamp so a postmortem never shows "104% GPU".
    utilPercent: Math.min(100, Math.round(utilPercent * 10) / 10),
    memUsedMb: Number.isFinite(memBytes) ? Math.round(memBytes / 1024 ** 2) : 0,
    memTotalMb,
  };
}

// Sums per-process GPU-engine utilization within each engine type, then takes
// the largest type — the same aggregation Task Manager's "GPU %" column uses.
// Summing across ALL instances instead would multiply-count a GPU running 3D
// and copy engines concurrently and routinely exceed 100%.
const WIN_GPU_SCRIPT = [
  '$u=@{}; $m=0.0',
  "foreach ($s in (Get-Counter -Counter @('\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage') -ErrorAction Stop).CounterSamples) {",
  "  if ($s.Path -like '*dedicated usage*') { if ($s.CookedValue -gt $m) { $m = $s.CookedValue } }",
  "  elseif ($s.InstanceName -match 'engtype_(\\w+)') { $k = $Matches[1]; $u[$k] = [double]$u[$k] + $s.CookedValue }",
  '}',
  '$peak = 0.0; foreach ($v in $u.Values) { if ($v -gt $peak) { $peak = $v } }',
  "'GPU {0} {1}' -f [math]::Round($peak,2), [int64]$m",
].join('\n');

/**
 * Total dedicated VRAM in MB, read once. `Win32_VideoController.AdapterRAM` is
 * a 32-bit field that saturates at 4 GB — it reported "4 GB" for the 32 GB
 * R9700 — so read the driver's `qwMemorySize` QWORD instead, which is exact.
 */
function readWindowsGpuMemTotalMb(): number {
  try {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue | Measure-Object -Property 'HardwareInformation.qwMemorySize' -Maximum).Maximum",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const bytes = Number.parseFloat(r.stdout.trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 ** 2) : 0;
  } catch {
    return 0;
  }
}

/** amdgpu exposes busy% and VRAM as plain sysfs files — no binary needed. */
export function parseAmdSysfsGpu(
  busy: string,
  vramUsed: string,
  vramTotal: string,
): GpuReading | null {
  const utilPercent = Number.parseFloat(busy.trim());
  if (!Number.isFinite(utilPercent)) return null;
  const used = Number.parseFloat(vramUsed.trim());
  const total = Number.parseFloat(vramTotal.trim());
  return {
    utilPercent: Math.min(100, utilPercent),
    memUsedMb: Number.isFinite(used) ? Math.round(used / 1024 ** 2) : 0,
    memTotalMb: Number.isFinite(total) ? Math.round(total / 1024 ** 2) : 0,
  };
}

/** First `/sys/class/drm/card<N>/device` exposing `gpu_busy_percent`. */
function findAmdSysfsDir(): string | null {
  for (let card = 0; card < 8; card += 1) {
    const dir = `/sys/class/drm/card${card}/device`;
    if (existsSync(`${dir}/gpu_busy_percent`)) return dir;
  }
  return null;
}

/**
 * Pick the GPU sampler for this host, once, at collector start. Probing per
 * sample would pay the miss cost forever on hosts with no GPU telemetry.
 * Returns null when nothing is available, which keeps `gpu.available: false`
 * meaning "we could not measure" rather than "the GPU was idle".
 */
export function resolveGpuSampler(): GpuSampler | null {
  const nvidia = sampleNvidia();
  if (nvidia) {
    return {
      kind: 'nvidia-smi',
      minIntervalMs: 0,
      sample: sampleNvidia,
      firstReading: nvidia,
    };
  }
  if (process.platform === 'win32') {
    const memTotalMb = readWindowsGpuMemTotalMb();
    const sample = (): GpuReading | null => {
      try {
        const r = spawnSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', WIN_GPU_SCRIPT],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 },
        );
        if (r.status !== 0) return null;
        return parseWindowsGpuCounters(r.stdout, memTotalMb);
      } catch {
        return null;
      }
    };
    const probe = sample();
    if (probe) {
      return { kind: 'windows-gpu-counters', minIntervalMs: 15_000, sample, firstReading: probe };
    }
    return null;
  }
  if (process.platform === 'linux') {
    const dir = findAmdSysfsDir();
    if (dir) {
      const sample = (): GpuReading | null => {
        try {
          return parseAmdSysfsGpu(
            readFileSync(`${dir}/gpu_busy_percent`, 'utf8'),
            readFileSync(`${dir}/mem_info_vram_used`, 'utf8'),
            readFileSync(`${dir}/mem_info_vram_total`, 'utf8'),
          );
        } catch {
          return null;
        }
      };
      const probe = sample();
      if (probe) return { kind: 'amdgpu-sysfs', minIntervalMs: 0, sample, firstReading: probe };
    }
    return null;
  }
  return null;
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
