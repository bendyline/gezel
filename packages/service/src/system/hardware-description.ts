/**
 * Prose + tier description of the machine's memory capacity.
 *
 * Lives here rather than beside its original caller in `handboek/` because
 * two unrelated surfaces need it — the handboek's device page and the
 * system-diagnostics payload — and `handboek/daemon-device.ts` is
 * deliberately restricted to `service.ts` importers so the `./handboek`
 * subpath stays importable without the daemon graph.
 *
 * Everything here is derived from capacity numbers alone. No paths, no
 * device identifiers, nothing that names the user — the output is safe to
 * paste into a public bug report.
 */

export type HardwareTier = 'tiny' | 'small' | 'medium' | 'large';

export interface HardwareDescription {
  description: string;
  tier: HardwareTier;
}

// Keep these aligned with the device-capacity labels shown during local-model
// onboarding. The budget is the memory the engine may actually use, not total
// host RAM, so a tier never promises a model the runtime cannot safely load.
const LARGE_BUDGET_BYTES = 25_000_000_000;
const MEDIUM_BUDGET_BYTES = 13_000_000_000;
const SMALL_BUDGET_BYTES = 5_000_000_000;

export function classifyHardwareTier(usableBytes: number): HardwareTier {
  if (usableBytes >= LARGE_BUDGET_BYTES) return 'large';
  if (usableBytes >= MEDIUM_BUDGET_BYTES) return 'medium';
  if (usableBytes >= SMALL_BUDGET_BYTES) return 'small';
  return 'tiny';
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

const GPU_VENDOR_LABEL = {
  amd: 'AMD',
  nvidia: 'NVIDIA',
  intel: 'Intel',
} as const;

export function describeCurrentHardware(profile: {
  totalRamBytes: number;
  gpuVramBytes: number | null;
  gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
  usableBytes: number;
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'gpu-integrated' | 'system-ram-fallback';
  gpuVendor?: keyof typeof GPU_VENDOR_LABEL;
}): HardwareDescription {
  const total = formatBytes(profile.totalRamBytes);
  const usable = formatBytes(profile.usableBytes);
  let description: string;
  if (profile.source === 'darwin-unified') {
    description = `Apple Silicon unified memory: ${total} total, with about ${usable} available for local models.`;
  } else if (profile.source === 'gpu-integrated') {
    const vendor = profile.gpuVendor ? `${GPU_VENDOR_LABEL[profile.gpuVendor]} ` : '';
    const shared =
      profile.gpuVramBytes == null
        ? ''
        : ` (the GPU reports ${formatBytes(profile.gpuVramBytes)} shared)`;
    description = `${vendor}integrated GPU: ${total} unified system memory${shared}, with about ${usable} available for local models; shared GPU memory is not additional RAM.`;
  } else if (profile.gpuVramBytes != null) {
    const vendor = profile.gpuVendor ? `${GPU_VENDOR_LABEL[profile.gpuVendor]} ` : '';
    description = `${vendor}GPU: ${formatBytes(profile.gpuVramBytes)} VRAM (about ${usable} available for local models), with ${total} system RAM.`;
  } else {
    description = `No dedicated GPU detected: ${total} system RAM, with about ${usable} available for CPU-based local models.`;
  }
  return { description, tier: classifyHardwareTier(profile.usableBytes) };
}
