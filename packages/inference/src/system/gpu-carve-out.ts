/**
 * How much memory firmware set aside for an integrated GPU, if any.
 *
 * Two kinds of integrated GPU report "VRAM" through Vulkan, and they mean
 * opposite things:
 *
 * - A **shared view** (Intel, Snapdragon, most iGPUs): the number is a slice
 *   of the same RAM the OS already counts. Adding it double-counts, which is
 *   why integrated hosts budget from system RAM alone.
 * - A **carve-out** (an AMD APU's "UMA frame buffer", set in firmware or by
 *   AMD's Variable Graphics Memory): memory removed before the OS ever counts
 *   RAM. It sits in neither `os.totalmem()` nor any free-RAM reading, and only
 *   the GPU can use it. Budgeting from system RAM alone loses it entirely, so
 *   on a 16 GB laptop raising the carve-out from 3 GB to 8 GB cut the budget
 *   from ~9 GB to ~4 GB.
 *
 * Windows answers directly when the device-health helper can list adapters
 * (DXCore): an integrated adapter's dedicated memory IS its carve-out. Where
 * installed RAM is known too, the two must agree — the carve-out has to fit
 * in the memory that is installed but missing from the OS's count — so one
 * odd driver figure cannot inflate the budget.
 *
 * Without an adapter listing, the GPU's Vulkan-reported memory stands in: a
 * carve-out fits inside that same gap, a shared view is far larger than it
 * (a few hundred MB of firmware reservations is the usual gap without one).
 *
 * Linux answers through the amdgpu driver instead (see
 * {@link linuxGpuCarveOutBytes}). Installed RAM is not readable there without
 * root, and the Vulkan figure cannot stand in: llama.cpp sums every heap of an
 * integrated GPU, and RADV reports an APU's GTT — borrowed system RAM — beside
 * the carve-out.
 *
 * Anything uncertain answers null — integrated GPUs budgeted from system RAM
 * alone, as before.
 */

/** Rounding slack between the installed figure, the OS's count, and the device report. */
const MATCH_TOLERANCE_BYTES = 64 * 1024 ** 2;

export function gpuCarveOutBytes(input: {
  /** Physically installed RAM, or null when it could not be read. */
  installedRamBytes: number | null;
  /** RAM the OS reports (`os.totalmem()`). */
  visibleRamBytes: number;
  /** Memory the integrated GPU reports for itself through Vulkan. */
  deviceBytes: number;
  /** Windows' figure for the integrated adapter's own memory, when listed. */
  adapterDedicatedBytes?: number | null;
}): number | null {
  const { installedRamBytes, visibleRamBytes, deviceBytes } = input;
  const missing = installedRamBytes === null ? null : installedRamBytes - visibleRamBytes;
  const fits = (bytes: number) =>
    missing === null || bytes <= missing + MATCH_TOLERANCE_BYTES ? bytes : null;
  const adapter = input.adapterDedicatedBytes;
  if (adapter !== undefined && adapter !== null) {
    if (!(adapter > 0)) return null;
    const agreed = fits(adapter);
    return agreed === null ? null : missing === null ? agreed : Math.min(agreed, missing);
  }
  if (missing === null || !(missing > 0) || !(deviceBytes > 0)) return null;
  return fits(deviceBytes) === null ? null : Math.min(deviceBytes, missing);
}

/**
 * An AMD APU's carve-out on Linux: amdgpu's `mem_info_vram_total`, which on an
 * APU is the frame buffer firmware reserved before the kernel counted RAM, so
 * it is absent from MemTotal. Read only for the one amdgpu device there is —
 * sysfs does not say which of two is integrated — and only when it fits in
 * what Vulkan reports, which for an integrated GPU is the carve-out plus GTT.
 * The caller has already decided the GPU llama.cpp picked is integrated.
 */
export function linuxGpuCarveOutBytes(input: {
  /** amdgpu devices from sysfs (`readAmdgpuAdapters`). */
  adapters: readonly GpuAdapterFacts[];
  visibleRamBytes: number;
  /** Memory the integrated GPU reports for itself through Vulkan. */
  deviceBytes: number;
}): number | null {
  const carveOut = soleAmdgpuAdapter(input.adapters)?.dedicatedBytes;
  if (carveOut === undefined || carveOut > input.deviceBytes + MATCH_TOLERANCE_BYTES) return null;
  return gpuCarveOutBytes({
    installedRamBytes: null,
    visibleRamBytes: input.visibleRamBytes,
    deviceBytes: input.deviceBytes,
    adapterDedicatedBytes: carveOut,
  });
}

/**
 * Everything an AMD APU can reach on Linux: its carve-out plus GTT, the
 * window of system RAM amdgpu lets it map (half of RAM on recent kernels
 * unless `ttm.pages_limit` raises it). Past that, allocations fail however
 * much RAM is free. Null without both figures for the one amdgpu device.
 */
export function linuxGpuAddressableBytes(adapters: readonly GpuAdapterFacts[]): number | null {
  const adapter = soleAmdgpuAdapter(adapters);
  const gtt = adapter?.sharedSystemBytes;
  if (adapter?.dedicatedBytes === undefined || gtt === undefined || !(gtt > 0)) return null;
  return adapter.dedicatedBytes + gtt;
}

/** The one amdgpu device, or null when there are none or several. */
function soleAmdgpuAdapter(adapters: readonly GpuAdapterFacts[]): GpuAdapterFacts | null {
  const amd = adapters.filter(
    (adapter) =>
      gpuVendorFromPciId(adapter.vendorId) === 'amd' && adapter.dedicatedBytes !== undefined,
  );
  return amd.length === 1 ? (amd[0] ?? null) : null;
}

/** The part of a helper adapter record (`DeviceGpuAdapter`) this module reads. */
export interface GpuAdapterFacts {
  name?: string;
  vendorId: number;
  integrated?: boolean;
  dedicatedBytes?: number;
  /** System RAM the adapter may borrow on top of its own (Linux: GTT). */
  sharedSystemBytes?: number;
}

const nameKey = (name: string) =>
  name.toLowerCase().replaceAll('(tm)', '').replaceAll('(r)', '').replace(/\s+/g, ' ').trim();

/**
 * The adapter Windows lists for the GPU llama.cpp picked: the one with the
 * same name, else the only adapter there is. Null when that is ambiguous —
 * the name-based guesses then stand.
 */
export function matchGpuAdapter<T extends GpuAdapterFacts>(
  adapters: readonly T[],
  deviceName: string,
): T | null {
  const named = adapters.filter(
    (adapter) => adapter.name !== undefined && nameKey(adapter.name) === nameKey(deviceName),
  );
  if (named.length === 1) return named[0] ?? null;
  return adapters.length === 1 ? (adapters[0] ?? null) : null;
}

/** GPU maker from its PCI vendor id. */
export function gpuVendorFromPciId(vendorId: number): 'amd' | 'intel' | 'nvidia' | undefined {
  if (vendorId === 0x1002 || vendorId === 0x1022) return 'amd';
  if (vendorId === 0x8086) return 'intel';
  if (vendorId === 0x10de) return 'nvidia';
  return undefined;
}
