import { useEffect, useState } from 'react';
import { api } from '../api.js';

interface MemoryProfile {
  platform: string;
  totalRamBytes: number;
  gpuVramBytes: number | null;
  gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
  source:
    | 'darwin-unified'
    | 'gpu-nvidia'
    | 'gpu-vulkan'
    | 'gpu-integrated'
    | 'system-ram-fallback';
  usableBytes: number;
  gpuVendor?: 'amd' | 'nvidia' | 'intel';
}

const VENDOR_LABEL: Record<'amd' | 'nvidia' | 'intel', string> = {
  amd: 'AMD',
  nvidia: 'Nvidia',
  intel: 'Intel',
};

/** ~25 GB usable fits a 14-30B model in 4-bit quant — best on-device experience. */
const LARGE_BUDGET_BYTES = 25_000_000_000;
/** ~13 GB usable fits a 7-8B model in 4-bit quant with comfortable context —
 *  the point where local AI starts feeling genuinely useful. */
const MEDIUM_BUDGET_BYTES = 13_000_000_000;
/** ~5 GB usable fits a 3-4B model in 4-bit quant with modest context. */
const SMALL_BUDGET_BYTES = 5_000_000_000;
const SMALL_GPU_VRAM_BYTES = 8 * 1024 ** 3;

function isLowAccelerationDevice(memory: MemoryProfile): boolean {
  if (memory.platform === 'darwin') return false;
  if (memory.gpuMemoryKind === 'unified') return false;
  if (
    memory.gpuMemoryKind === 'integrated' ||
    memory.gpuMemoryKind === 'none' ||
    memory.source === 'gpu-integrated' ||
    memory.source === 'system-ram-fallback'
  ) {
    return true;
  }
  return memory.gpuVramBytes == null || memory.gpuVramBytes < SMALL_GPU_VRAM_BYTES;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function describe(memory: MemoryProfile): string {
  const usable = formatBytes(memory.usableBytes);
  const total = formatBytes(memory.totalRamBytes);
  const vram = memory.gpuVramBytes ? formatBytes(memory.gpuVramBytes) : null;
  if (memory.source === 'darwin-unified') {
    return `Apple Silicon unified memory — ~${usable} usable for models (out of ${total} total).`;
  }
  if (memory.source === 'gpu-integrated') {
    const who = memory.gpuVendor
      ? `${VENDOR_LABEL[memory.gpuVendor]} integrated GPU`
      : 'Integrated GPU';
    const reported = vram
      ? ` It reports ${vram} of shared graphics memory, which is part of that RAM, not additional memory.`
      : '';
    return `${who} — ~${usable} usable for models (out of ${total} shared system RAM).${reported}`;
  }
  if (memory.source === 'gpu-nvidia' || memory.source === 'gpu-vulkan') {
    // The GPU backs the budget — name the vendor when we know it ("AMD GPU"),
    // else a generic "GPU". VRAM is always present on these two sources.
    const who = memory.gpuVendor ? `${VENDOR_LABEL[memory.gpuVendor]} GPU` : 'GPU';
    return `${who} detected — ~${usable} of ${vram} VRAM usable for models.`;
  }
  return `No dedicated GPU detected — inference runs on CPU at ~${usable} budget (out of ${total} total RAM). Models will work but run much more slowly than on a GPU.`;
}

/**
 * One-line summary of how much memory the local machine can dedicate to
 * Ollama. Rendered near the top of the Ollama onboarding so users set
 * expectations before they scroll to the model picker.
 */
export function DeviceSummary() {
  const [memory, setMemory] = useState<MemoryProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMemoryProfile()
      .then((p) => {
        if (!cancelled) setMemory(p);
      })
      .catch(() => {
        /* silently hide — the picker's own summary will still surface errors */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!memory) return null;
  const tierLabel = isLowAccelerationDevice(memory)
    ? 'Your device is best suited to small models'
    : memory.usableBytes >= LARGE_BUDGET_BYTES
      ? 'Your device can run large models'
      : memory.usableBytes >= MEDIUM_BUDGET_BYTES
        ? 'Your device can run some nice medium-size models'
        : memory.usableBytes >= SMALL_BUDGET_BYTES
          ? 'Your device can run usable small-size models'
          : 'Your device can run tiny models';
  return (
    <p className="muted small">
      <strong>Your device:</strong> {describe(memory)}
      <span className="home-status-pill home-status-ok" style={{ marginLeft: '0.5rem' }}>
        ✓ {tierLabel}
      </span>
    </p>
  );
}
