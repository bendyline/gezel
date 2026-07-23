import { execFile } from 'node:child_process';
import { platform as osPlatform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { detectLlamaGpuVram } from '../providers/llama-cpp/devices.js';
import { autoDetectBudgetBytes } from '../providers/native/capacity-budget.js';

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
