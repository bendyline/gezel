import { execFile } from 'node:child_process';
import { freemem, platform as osPlatform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { MachineMemoryUsage } from '@bendyline/gezel';
import type { DeviceHealthStatusSnapshot } from '@bendyline/gezel/native';
import { detectLlamaGpuVram } from '../providers/llama-cpp/devices.js';
import { autoDetectBudgetBytes } from '../providers/native/capacity-budget.js';
import type { GezelProcessMemorySnapshot } from './gezel-process-memory.js';

const exec = promisify(execFile);

export type MemorySource = 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'system-ram-fallback';
export type GpuVendor = 'amd' | 'nvidia' | 'intel';

export interface MemoryProfile {
  platform: 'darwin' | 'win32' | 'linux' | string;
  /** Total system RAM in bytes. Always populated. */
  totalRamBytes: number;
  /** Dedicated GPU VRAM in bytes, when detected. Null on macOS (unified) and when no GPU tool responds. */
  gpuVramBytes: number | null;
  /** Where `usableBytes` comes from. Drives the UI's wording. */
  source: MemorySource;
  /**
   * The conservative resident-memory budget available to local engines.
   * Leaves room for the OS, foreground apps, and other engine processes.
   */
  usableBytes: number;
  /** GPU vendor when a GPU backs the budget — lets the UI say "AMD GPU". */
  gpuVendor?: GpuVendor;
}

interface CachedMemoryProfile {
  at: number;
  value: MemoryProfile;
}

let cachedMemoryProfile: CachedMemoryProfile | null = null;
let pendingMemoryProfile: Promise<MemoryProfile> | null = null;

/**
 * Detect the memory available for local LLM inference. Platform-aware:
 *
 *   • macOS: unified memory — GPU and CPU share one pool. Use the same
 *     capacity budget enforced by the native-engine broker: 60% on
 *     ordinary machines, 80% on 96 GB+ machines, capped at 96 GiB.
 *
 *   • Linux / Windows: probe `nvidia-smi` for VRAM. If present, that's
 *     the primary budget (dedicated GPU inference). If absent, probe the
 *     bundled `llama-server --list-devices` for a non-NVIDIA GPU (AMD /
 *     Intel / any Vulkan device) and use ITS VRAM as the budget. Only when
 *     neither reports a GPU do we fall back to ~50% of system RAM (CPU
 *     inference — works, but slower, with headroom left for the OS).
 */
export async function detectMemoryProfile(): Promise<MemoryProfile> {
  const plat = osPlatform();
  const totalRam = totalmem();

  if (plat === 'darwin') {
    return {
      platform: 'darwin',
      totalRamBytes: totalRam,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: autoDetectBudgetBytes(totalRam),
    };
  }

  // Don't dock a dedicated card — the whole VRAM pool is available in
  // practice. A small 5% safety margin covers the display framebuffer and
  // driver overhead. Same budget rule for NVIDIA and non-NVIDIA cards.
  const vramBudget = (vram: number) => Math.floor(vram * 0.95);

  const nvidiaVram = await probeNvidiaVram();
  if (nvidiaVram !== null) {
    return {
      platform: plat,
      totalRamBytes: totalRam,
      gpuVramBytes: nvidiaVram,
      source: 'gpu-nvidia',
      usableBytes: vramBudget(nvidiaVram),
      gpuVendor: 'nvidia',
    };
  }

  // Non-NVIDIA GPU (AMD Radeon, Intel Arc, any Vulkan device). nvidia-smi
  // is blind to these, but the bundled llama-server reports their VRAM via
  // `--list-devices` — the same number the MoE offload planner uses. Use it
  // so a Radeon box gets a real GPU budget (and the "runs on CPU" copy stops
  // lying) instead of the 50%-of-RAM CPU fallback below.
  const gpu = await detectLlamaGpuVram();
  if (gpu !== null) {
    // Vendor comes from the device name in the SAME probe (e.g. "AMD Radeon
    // …" / "Intel Arc …"), so the label always matches the card we sized —
    // never "AMD" for an Intel GPU. Undefined for unrecognized names → the
    // UI shows a generic "GPU".
    return {
      platform: plat,
      totalRamBytes: totalRam,
      gpuVramBytes: gpu.vramBytes,
      source: 'gpu-vulkan',
      usableBytes: vramBudget(gpu.vramBytes),
      ...(gpu.vendor ? { gpuVendor: gpu.vendor } : {}),
    };
  }

  return {
    platform: plat,
    totalRamBytes: totalRam,
    gpuVramBytes: null,
    source: 'system-ram-fallback',
    // CPU inference needs the OS + your apps + inference buffers. Be
    // conservative — 50% of system RAM is a safer ceiling than 60%.
    usableBytes: Math.floor(totalRam * 0.5),
  };
}

/**
 * Capacity changes only on GPU hot-plug / VM reconfiguration, while the live
 * strip may poll once a second. Keep the expensive nvidia-smi / llama device
 * discovery out of that hot path and refresh the profile occasionally.
 */
export async function detectMemoryProfileCached(maxAgeMs = 60_000): Promise<MemoryProfile> {
  const now = Date.now();
  if (cachedMemoryProfile && now - cachedMemoryProfile.at <= maxAgeMs) {
    return cachedMemoryProfile.value;
  }
  if (pendingMemoryProfile) return pendingMemoryProfile;
  pendingMemoryProfile = detectMemoryProfile()
    .then((value) => {
      cachedMemoryProfile = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pendingMemoryProfile = null;
    });
  return pendingMemoryProfile;
}

export interface SampleMachineMemoryUsageOptions {
  profile: MemoryProfile;
  deviceHealth?: DeviceHealthStatusSnapshot;
  /** Capacity broker reservation across resident Gezel local-engine replicas. */
  engineCommittedBytes?: number;
  /** Installed parameter payloads for the resident replicas, when known. */
  engineModelWeightsBytes?: number;
  /** macOS physical footprint for gezeld + same-home engine processes. */
  gezelProcessMemory?: GezelProcessMemorySnapshot | null;
  /**
   * CPU inference deliberately uses main RAM even when a discrete GPU exists.
   * The UI should describe the pool actually backing the selected backend.
   */
  forceMainMemory?: boolean;
  /** Test seams; production defaults come from node:os / process.memoryUsage. */
  freeRamBytes?: number;
  serviceRssBytes?: number;
  sampledAt?: string;
}

/**
 * Combine stable capacity detection, cached accelerator health, and cheap OS
 * RAM counters into the live memory strip's portable wire shape.
 *
 * Driver telemetry reliably gives aggregate GPU use but not portable
 * per-process VRAM. On macOS, physical-footprint sampling observes gezeld and
 * same-home engine processes directly, including Metal allocations. UMA/CPU
 * hosts without that sample fall back to the broker reservation + daemon RSS;
 * discrete GPUs retain the reservation estimate. The remainder is labelled
 * "Other", never as an exact process audit.
 */
export function sampleMachineMemoryUsage(
  opts: SampleMachineMemoryUsageOptions,
): MachineMemoryUsage {
  const profile = opts.profile;
  const totalRamBytes = profile.totalRamBytes;
  const unified =
    profile.source === 'darwin-unified' ||
    (profile.gpuVramBytes !== null && profile.gpuVramBytes >= totalRamBytes * 0.75);
  const mainMemory =
    opts.forceMainMemory === true || profile.source === 'system-ram-fallback' || unified;
  const engineBytes = finiteNonNegative(opts.engineCommittedBytes);
  const engineModelWeightsBytes = finiteNonNegative(opts.engineModelWeightsBytes);
  const sampledAt = opts.sampledAt ?? new Date().toISOString();

  if (mainMemory) {
    const freeRamBytes = clamp(finiteNonNegative(opts.freeRamBytes ?? freemem()), 0, totalRamBytes);
    const usedBytes = Math.max(0, totalRamBytes - freeRamBytes);
    const serviceRssBytes = finiteNonNegative(opts.serviceRssBytes ?? process.memoryUsage().rss);
    const observedBytes =
      opts.gezelProcessMemory &&
      Number.isFinite(opts.gezelProcessMemory.bytes) &&
      opts.gezelProcessMemory.bytes >= 0
        ? clamp(opts.gezelProcessMemory.bytes, 0, usedBytes)
        : null;
    const gezelBytesEstimated = clamp(engineBytes + serviceRssBytes, 0, usedBytes);
    const gezelBytesAttributed = observedBytes ?? gezelBytesEstimated;
    const breakdown = splitGezelMemory({
      attributedBytes: gezelBytesAttributed,
      engineReservedBytes: engineBytes,
      modelWeightsBytes: engineModelWeightsBytes,
      coreFloorBytes: serviceRssBytes,
    });
    return {
      kind: opts.forceMainMemory === true && !unified ? 'ram' : 'unified',
      totalBytes: totalRamBytes,
      usedBytes,
      gezelBytesEstimated,
      gezelBytesObserved: observedBytes,
      ...breakdown,
      engineReservedBytes: engineBytes,
      gezelEngineProcessCount: opts.gezelProcessMemory?.engineProcessCount ?? 0,
      orphanedGezelEngineProcessCount: opts.gezelProcessMemory?.orphanedEngineProcessCount ?? 0,
      otherBytes: Math.max(0, usedBytes - gezelBytesAttributed),
      freeBytes: Math.max(0, totalRamBytes - usedBytes),
      sampledAt,
      source: 'system-memory',
      deviceNames: [],
    };
  }

  const memoryReadings = (opts.deviceHealth?.readings ?? []).filter(
    (reading) =>
      typeof reading.memoryTotalMb === 'number' &&
      Number.isFinite(reading.memoryTotalMb) &&
      reading.memoryTotalMb > 0,
  );
  const measuredTotalBytes =
    memoryReadings.length > 0
      ? memoryReadings.reduce((sum, reading) => sum + (reading.memoryTotalMb ?? 0), 0) * 1024 ** 2
      : null;
  const totalBytes = measuredTotalBytes ?? profile.gpuVramBytes ?? 0;
  const hasCompleteUsedReading =
    memoryReadings.length > 0 &&
    memoryReadings.every(
      (reading) =>
        typeof reading.memoryUsedMb === 'number' &&
        Number.isFinite(reading.memoryUsedMb) &&
        reading.memoryUsedMb >= 0,
    );
  const usedBytes = hasCompleteUsedReading
    ? clamp(
        memoryReadings.reduce((sum, reading) => sum + (reading.memoryUsedMb ?? 0), 0) * 1024 ** 2,
        0,
        totalBytes,
      )
    : null;
  const gezelBytesEstimated = clamp(engineBytes, 0, usedBytes ?? totalBytes);
  const breakdown = splitGezelMemory({
    attributedBytes: gezelBytesEstimated,
    engineReservedBytes: engineBytes,
    modelWeightsBytes: engineModelWeightsBytes,
    coreFloorBytes: 0,
  });
  const deviceNames = [
    ...new Set(
      memoryReadings
        .map((reading) => reading.name?.trim())
        .filter((name): name is string => !!name),
    ),
  ];

  return {
    kind: 'vram',
    totalBytes,
    usedBytes,
    gezelBytesEstimated,
    gezelBytesObserved: null,
    ...breakdown,
    engineReservedBytes: engineBytes,
    gezelEngineProcessCount: 0,
    orphanedGezelEngineProcessCount: 0,
    otherBytes: usedBytes === null ? null : Math.max(0, usedBytes - gezelBytesEstimated),
    freeBytes: usedBytes === null ? null : Math.max(0, totalBytes - usedBytes),
    sampledAt,
    source: memoryReadings.length > 0 ? 'device-health' : 'capacity-only',
    deviceNames,
  };
}

/**
 * Split the Gezel-attributed total without claiming unavailable precision.
 * Installed payload size is our weights estimate; the capacity reservation's
 * remainder covers KV + compute buffers. On UMA/RAM, daemon RSS is protected
 * first and any observed footprint beyond the reservation remains core/runtime
 * overhead. Every output is clamped so the three pieces always sum to the
 * attributed total, even when an observed sample is below the reservation.
 */
function splitGezelMemory(opts: {
  attributedBytes: number;
  engineReservedBytes: number;
  modelWeightsBytes: number;
  coreFloorBytes: number;
}): {
  gezelInfraBytes: number;
  gezelModelWeightsBytes: number;
  gezelModelCacheBytes: number;
} {
  const attributedBytes = finiteNonNegative(opts.attributedBytes);
  const coreFloorBytes = clamp(finiteNonNegative(opts.coreFloorBytes), 0, attributedBytes);
  const modelBudget = Math.max(0, attributedBytes - coreFloorBytes);
  const engineBytes = clamp(finiteNonNegative(opts.engineReservedBytes), 0, modelBudget);
  // If installed metadata is unavailable, count the reservation as weights.
  // This avoids inventing a cache split and still keeps the total truthful.
  const weightEstimate =
    opts.modelWeightsBytes > 0 ? finiteNonNegative(opts.modelWeightsBytes) : engineBytes;
  const gezelModelWeightsBytes = clamp(weightEstimate, 0, engineBytes);
  const gezelModelCacheBytes = Math.max(0, engineBytes - gezelModelWeightsBytes);
  const gezelInfraBytes = Math.max(
    0,
    attributedBytes - gezelModelWeightsBytes - gezelModelCacheBytes,
  );
  return { gezelInfraBytes, gezelModelWeightsBytes, gezelModelCacheBytes };
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function probeNvidiaVram(): Promise<number | null> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000 },
    );
    // `nvidia-smi` reports MiB per GPU, one per line. Sum across GPUs —
    // Ollama can split a model across GPUs when wired up correctly.
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const mib = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(mib) && mib > 0) total += mib;
    }
    if (total === 0) return null;
    return total * 1024 * 1024;
  } catch {
    return null;
  }
}
