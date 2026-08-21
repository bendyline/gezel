import { execFile } from 'node:child_process';
import { freemem, platform as osPlatform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type {
  GpuProcessMemory,
  LocalEngineLifecycle,
  MachineMemoryUsage,
  ResidentEngineModel,
} from '@bendyline/gezel';
import {
  type DeviceHealthStatusSnapshot,
  windowsHeadlessSpawnOptions,
} from '@bendyline/gezel/native';
import {
  type LlamaGpuMemoryKind,
  type GpuVendor as LlamaGpuVendor,
  detectLlamaGpuVram,
} from '../providers/llama-cpp/devices.js';
import {
  autoDetectBudgetBytes,
  computeCapacityBudget,
  setDetectedGpuVramBytes,
} from '../providers/native/capacity-budget.js';
import type { DarwinSystemMemorySnapshot } from './darwin-memory.js';
import type { GezelProcessMemorySnapshot } from './gezel-process-memory.js';

const exec = promisify(execFile);

export type MemorySource =
  | 'darwin-unified'
  | 'gpu-nvidia'
  | 'gpu-vulkan'
  | 'gpu-integrated'
  | 'system-ram-fallback';
export type GpuVendor = 'amd' | 'nvidia' | 'intel';
export type GpuMemoryKind = 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';

export interface MemoryProfile {
  platform: 'darwin' | 'win32' | 'linux' | string;
  /** Total system RAM in bytes. Always populated. */
  totalRamBytes: number;
  /**
   * GPU-addressable memory in bytes, when detected. For `gpu-integrated` this
   * is a reported shared allocation inside `totalRamBytes`, not extra memory.
   * Null on macOS and when no GPU tool responds.
   */
  gpuVramBytes: number | null;
  /** Whether the reported GPU pool is separate from or shared with system RAM. */
  gpuMemoryKind: GpuMemoryKind;
  /** Where `usableBytes` comes from. Drives the UI's wording. */
  source: MemorySource;
  /**
   * The conservative FAST-memory budget available to local engines: VRAM on
   * a discrete card, a RAM fraction on unified / CPU-only hosts. A model
   * within this runs entirely where the compute happens.
   */
  usableBytes: number;
  /**
   * What the capacity broker will actually admit — the same auto-derived
   * ceiling {@link autoDetectBudgetBytes} gives it, summed across every pool
   * a resident engine can use. On a discrete card that is VRAM PLUS a system-
   * RAM share, because a MoE model streams its experts from RAM.
   *
   * Larger than {@link usableBytes} on a discrete card and equal to it on a
   * Mac. Fit checks gate on this: anything above it is a model the broker
   * refuses to load, so offering it as a download is a promise we break.
   */
  budgetBytes: number;
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
    setDetectedGpuVramBytes(null);
    return {
      platform: 'darwin',
      totalRamBytes: totalRam,
      gpuVramBytes: null,
      gpuMemoryKind: 'unified',
      source: 'darwin-unified',
      usableBytes: autoDetectBudgetBytes(totalRam),
      budgetBytes: autoDetectBudgetBytes(totalRam),
    };
  }

  // Don't dock a dedicated card — the whole VRAM pool is available in
  // practice. A small 5% safety margin covers the display framebuffer and
  // driver overhead. Same budget rule for NVIDIA and non-NVIDIA cards.
  // `computeCapacityBudget` owns the same 5%, so read both from it rather
  // than keeping a second copy of the constant here.
  const gpuBudget = (vram: number, unifiedMemory: boolean) => {
    const budget = computeCapacityBudget({
      systemRamBytes: totalRam,
      gpuVramBytes: vram,
      unifiedMemory,
    });
    return { usableBytes: budget.fastBytes, budgetBytes: budget.budgetBytes };
  };

  const nvidia = await probeNvidiaMemory();
  if (nvidia !== null) {
    const unified = nvidia.memoryKind === 'unified';
    setDetectedGpuVramBytes(nvidia.vramBytes, unified);
    return {
      platform: plat,
      totalRamBytes: totalRam,
      gpuVramBytes: nvidia.vramBytes,
      // GB10 / DGX Spark reports nearly the whole unified pool through CUDA.
      // It is shared memory, but it remains a high-performance accelerator and
      // must not be routed to the consumer-iGPU small-model policy.
      gpuMemoryKind: nvidia.memoryKind,
      source: 'gpu-nvidia',
      ...gpuBudget(nvidia.vramBytes, unified),
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
    const profile = memoryProfileForLlamaGpu(plat, totalRam, gpu);
    // The ambient capacity broker accepts only a VRAM byte count. Publishing
    // an integrated adapter's shared allocation there would add it to RAM a
    // second time, so publish null for that host class.
    setDetectedGpuVramBytes(
      profile.gpuMemoryKind === 'integrated' ? null : gpu.vramBytes,
      profile.gpuMemoryKind === 'integrated' || profile.gpuMemoryKind === 'unified',
    );
    // Vendor comes from the device name in the SAME probe (e.g. "AMD Radeon
    // …" / "Intel Arc …"), so the label always matches the card we sized —
    // never "AMD" for an Intel GPU. Undefined for unrecognized names → the
    // UI shows a generic "GPU".
    return profile;
  }

  setDetectedGpuVramBytes(null);
  return {
    platform: plat,
    totalRamBytes: totalRam,
    gpuVramBytes: null,
    gpuMemoryKind: 'none',
    source: 'system-ram-fallback',
    // CPU inference needs the OS + your apps + inference buffers. Be
    // conservative — 50% of system RAM is a safer ceiling than 60%.
    usableBytes: Math.floor(totalRam * 0.5),
    // The broker will still admit up to its 60% share; a model between the
    // two runs, just without comfortable headroom ("may run slowly").
    budgetBytes: autoDetectBudgetBytes(totalRam, { gpuVramBytes: null }),
  };
}

/**
 * Convert a llama.cpp Vulkan device into the service memory profile without
 * double-counting an integrated adapter's shared allocation. Exported as the
 * pure policy seam for regression tests and diagnostics tooling.
 */
export function memoryProfileForLlamaGpu(
  platform: string,
  totalRamBytes: number,
  gpu: {
    vramBytes: number;
    name: string;
    vendor?: LlamaGpuVendor;
    memoryKind: LlamaGpuMemoryKind;
  },
): MemoryProfile {
  const ratioLooksUnified = gpu.vramBytes >= totalRamBytes * 0.75;
  const gpuMemoryKind: GpuMemoryKind =
    gpu.memoryKind === 'integrated'
      ? 'integrated'
      : gpu.memoryKind === 'discrete'
        ? 'discrete'
        : ratioLooksUnified
          ? 'unified'
          : 'unknown';
  const shared = gpuMemoryKind === 'integrated' || gpuMemoryKind === 'unified';
  const budget = computeCapacityBudget({
    systemRamBytes: totalRamBytes,
    gpuVramBytes: gpu.vramBytes,
    unifiedMemory: shared,
  });
  return {
    platform,
    totalRamBytes,
    gpuVramBytes: gpu.vramBytes,
    gpuMemoryKind,
    source: gpuMemoryKind === 'integrated' ? 'gpu-integrated' : 'gpu-vulkan',
    // A consumer iGPU is effectively system-memory-paced. Keep the same
    // conservative fast-fit ceiling as CPU fallback while the broker may
    // admit up to its single-pool unified ceiling.
    usableBytes:
      gpuMemoryKind === 'integrated' ? Math.floor(totalRamBytes * 0.5) : budget.fastBytes,
    budgetBytes: budget.budgetBytes,
    ...(gpu.vendor ? { gpuVendor: gpu.vendor } : {}),
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
  /** The broker budget that reservation is measured against; spans pools. */
  engineBudgetBytes?: number | null;
  /** Resident replicas behind the reservation, aggregated per model. */
  residentModels?: ResidentEngineModel[];
  /** Running replicas and their idle/pressure release deadlines. */
  engineLifecycles?: LocalEngineLifecycle[];
  /** Installed parameter payloads for the resident replicas, when known. */
  engineModelWeightsBytes?: number;
  /** macOS physical footprint for gezeld + same-home engine processes. */
  gezelProcessMemory?: GezelProcessMemorySnapshot | null;
  /** macOS Activity Monitor-style used/cache/free counters. */
  darwinSystemMemory?: DarwinSystemMemorySnapshot | null;
  /**
   * CPU inference deliberately uses main RAM even when a discrete GPU exists.
   * The UI should describe the pool actually backing the selected backend.
   */
  forceMainMemory?: boolean;
  /** Portable fallback test seams; macOS production uses darwinSystemMemory. */
  freeRamBytes?: number;
  serviceRssBytes?: number;
  sampledAt?: string;
}

/**
 * Combine stable capacity detection, cached accelerator health, and cheap OS
 * RAM counters into the live memory strip's portable wire shape.
 *
 * Driver telemetry reliably gives aggregate GPU use. On Windows, the bundled
 * helper also reads process memory (the OS GPU Process Memory counter on
 * Windows, NVML on NVIDIA Linux) and classifies Gezel's supervised engine
 * processes; on macOS, physical-footprint sampling observes gezeld and
 * same-home engines, including Metal allocations. Other hosts fall back to
 * the broker reservation + daemon RSS.
 *
 * A discrete card uses process accounting when available and otherwise keeps
 * the older reservation estimate clearly approximate. The reservation itself
 * still travels separately as `engineReservedBytes`: it spans VRAM and a
 * system-RAM share and must never be presented as measured placement.
 */
export function sampleMachineMemoryUsage(
  opts: SampleMachineMemoryUsageOptions,
): MachineMemoryUsage {
  const profile = opts.profile;
  const totalRamBytes = profile.totalRamBytes;
  const unified =
    profile.source === 'darwin-unified' ||
    profile.source === 'gpu-integrated' ||
    profile.gpuMemoryKind === 'unified';
  const mainMemory =
    opts.forceMainMemory === true || profile.source === 'system-ram-fallback' || unified;
  const engineBytes = finiteNonNegative(opts.engineCommittedBytes);
  const engineModelWeightsBytes = finiteNonNegative(opts.engineModelWeightsBytes);
  const engineBudgetBytes =
    typeof opts.engineBudgetBytes === 'number' && Number.isFinite(opts.engineBudgetBytes)
      ? Math.max(0, opts.engineBudgetBytes)
      : null;
  const residentModels = opts.residentModels ?? [];
  const sampledAt = opts.sampledAt ?? new Date().toISOString();

  if (mainMemory) {
    const freeRamBytes = clamp(
      finiteNonNegative(opts.darwinSystemMemory?.freeBytes ?? opts.freeRamBytes ?? freemem()),
      0,
      totalRamBytes,
    );
    const cachedBytes = opts.darwinSystemMemory
      ? clamp(
          finiteNonNegative(opts.darwinSystemMemory.cachedBytes),
          0,
          totalRamBytes - freeRamBytes,
        )
      : null;
    const usedBytes = Math.max(0, totalRamBytes - freeRamBytes - (cachedBytes ?? 0));
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
      engineBudgetBytes,
      residentModels,
      ...(opts.engineLifecycles ? { engineLifecycles: opts.engineLifecycles } : {}),
      gezelEngineProcessCount: opts.gezelProcessMemory?.engineProcessCount ?? 0,
      orphanedGezelEngineProcessCount: opts.gezelProcessMemory?.orphanedEngineProcessCount ?? 0,
      otherBytes: Math.max(0, usedBytes - gezelBytesAttributed),
      cachedBytes,
      freeBytes: freeRamBytes,
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
  // Only a measured pool figure can bound what we attribute to Gezel here.
  // Without one there is nothing to clamp against but the card's own
  // capacity, and the reservation exceeds that as soon as a second model
  // loads — which drew a full bar and a "Gezel ~31.9 GiB" legend on a card
  // holding a single 5.5 GiB model. Report nothing rather than the total.
  // A broker reservation spans VRAM and a system-RAM share, so it is not a
  // fallback measurement of this card. Without OS process accounting, leave
  // attribution unknown (zero here, with the reservation shown separately).
  const gezelBytesEstimated = 0;
  const supervisedEnginePids = new Set(
    (opts.engineLifecycles ?? [])
      .filter(
        (lifecycle) =>
          lifecycle.running &&
          typeof lifecycle.pid === 'number' &&
          Number.isInteger(lifecycle.pid) &&
          lifecycle.pid > 0,
      )
      .map((lifecycle) => lifecycle.pid as number),
  );
  const gpuProcesses: GpuProcessMemory[] = (opts.deviceHealth?.processes ?? [])
    .filter(
      (process) =>
        Number.isInteger(process.pid) &&
        process.pid > 0 &&
        Number.isFinite(process.dedicatedBytes) &&
        process.dedicatedBytes >= 0,
    )
    .map((process) =>
      process.owner === 'external' && supervisedEnginePids.has(process.pid)
        ? { ...process, owner: 'gezel-engine' as const }
        : { ...process },
    );
  const processAccountingAvailable =
    gpuProcesses.length > 0 ||
    (opts.deviceHealth?.sources ?? []).some(
      (source) => source === 'windows-gpu-process-memory' || source === 'nvml-process-memory',
    );
  const observedGezelBytes =
    usedBytes !== null && processAccountingAvailable
      ? clamp(
          gpuProcesses
            .filter((process) => process.owner !== 'external')
            .reduce((sum, process) => sum + process.dedicatedBytes, 0),
          0,
          usedBytes,
        )
      : null;
  const gezelBytesAttributed = observedGezelBytes ?? gezelBytesEstimated;
  const breakdown = splitGezelMemory({
    attributedBytes: gezelBytesAttributed,
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
    gezelBytesObserved: observedGezelBytes,
    ...breakdown,
    engineReservedBytes: engineBytes,
    engineBudgetBytes,
    residentModels,
    ...(opts.engineLifecycles ? { engineLifecycles: opts.engineLifecycles } : {}),
    ...(gpuProcesses.length > 0 ? { gpuProcesses } : {}),
    gezelEngineProcessCount: gpuProcesses.filter((process) => process.owner !== 'external').length,
    orphanedGezelEngineProcessCount: 0,
    otherBytes: usedBytes === null ? null : Math.max(0, usedBytes - gezelBytesAttributed),
    cachedBytes: null,
    freeBytes: usedBytes === null ? null : Math.max(0, totalBytes - usedBytes),
    sampledAt,
    source: memoryReadings.length > 0 ? 'device-health' : 'capacity-only',
    deviceNames,
  };
}

/**
 * Collapse the engine pool's per-replica entries into one row per model,
 * heaviest first. Clones of the same model share a row because a reader
 * looking for "what is holding my memory" wants the model named once with
 * its whole reservation, not N lines that differ only by replica index.
 */
export function summarizeResidentModels(
  entries: ReadonlyArray<{ provider: string; modelId: string; residentBytes: number }>,
): ResidentEngineModel[] {
  const byModel = new Map<string, ResidentEngineModel>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.modelId}`;
    const existing = byModel.get(key);
    const bytes = finiteNonNegative(entry.residentBytes);
    if (existing) {
      existing.reservedBytes += bytes;
      existing.replicaCount += 1;
      continue;
    }
    byModel.set(key, {
      provider: entry.provider,
      modelId: entry.modelId,
      reservedBytes: bytes,
      replicaCount: 1,
    });
  }
  return [...byModel.values()].sort(
    (a, b) => b.reservedBytes - a.reservedBytes || a.modelId.localeCompare(b.modelId),
  );
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

export interface NvidiaMemoryProbe {
  vramBytes: number;
  memoryKind: 'discrete' | 'unified';
  deviceNames: string[];
}

/** Parse the stable `name,memory.total` CSV emitted by nvidia-smi. */
export function parseNvidiaMemoryProbe(stdout: string): NvidiaMemoryProbe | null {
  const devices: Array<{ name: string; memoryMiB: number }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    // GPU names can theoretically contain commas. Split on the final field,
    // whose nounits form is always an integer MiB value.
    const match = /^(.*),\s*(\d+)\s*$/.exec(rawLine.trim());
    if (!match) continue;
    const name = match[1]?.trim() ?? '';
    const memoryMiB = Number.parseInt(match[2] ?? '', 10);
    if (!name || !Number.isFinite(memoryMiB) || memoryMiB <= 0) continue;
    devices.push({ name, memoryMiB });
  }
  if (devices.length === 0) return null;
  const unified = devices.every((device) => isKnownUnifiedNvidiaDevice(device.name));
  return {
    vramBytes: devices.reduce((sum, device) => sum + device.memoryMiB, 0) * 1024 * 1024,
    memoryKind: unified ? 'unified' : 'discrete',
    deviceNames: devices.map((device) => device.name),
  };
}

function isKnownUnifiedNvidiaDevice(name: string): boolean {
  const normalized = name.toLowerCase();
  return /\bgb10\b/.test(normalized) || normalized.includes('dgx spark');
}

async function probeNvidiaMemory(): Promise<NvidiaMemoryProbe | null> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      // Keep this short-lived console probe invisible without detaching it
      // from the daemon that owns and awaits it.
      { timeout: 2000, ...windowsHeadlessSpawnOptions() },
    );
    return parseNvidiaMemoryProbe(stdout);
  } catch {
    return null;
  }
}
