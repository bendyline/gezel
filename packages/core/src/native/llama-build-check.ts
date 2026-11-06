/**
 * The veto discovery hands `resolveAvailableLlamaBinary`: a build that
 * crashed here before it was ever ready (llama-quarantine.ts), on Linux a
 * CUDA build the NVIDIA driver cannot run (nvidia-driver.ts), and a ROCm
 * build with no code for any GPU on this machine (rocm-devices.ts). Both
 * discovery paths — the daemon's and the Electron supervisor's — use this one
 * check, so they cannot disagree about which build launches.
 *
 * The reasons are published separately because they mean different things
 * to the person: a quarantine is undone from Settings, a driver blocker by a
 * restart or a driver update, after which the next launch picks CUDA again by
 * itself, and a ROCm blocker is usually just a GPU the ROCm build was never
 * meant for — Vulkan serves it, as it always did.
 */

import type { LlamaBackend } from './llama-backend.js';
import { type LlamaQuarantineEntry, isBinaryQuarantined } from './llama-quarantine.js';
import { type NvidiaCudaBlocker, linuxCudaBuildBlocker } from './nvidia-driver.js';
import type { RocmCheck } from './rocm-devices.js';

/** JSON `NvidiaCudaBlocker`, set by discovery when the CUDA build was passed over. */
export const LLAMA_CUDA_BLOCKER_ENV = 'GEZEL_LLAMA_CUDA_BLOCKER';

export interface LlamaBuildCheck {
  isUsable: (backend: LlamaBackend, path: string) => boolean;
  /** Why the CUDA build was passed over, once `isUsable` has been asked about it. */
  cudaBlocker: () => NvidiaCudaBlocker | null;
  /** What the ROCm build said about this machine, once `isUsable` has been asked about it. */
  rocmCheck: () => RocmCheck | null;
  /** The skipped backends that were skipped for a quarantine, not a driver. */
  quarantinedOf: (skipped: readonly LlamaBackend[]) => LlamaBackend[];
}

export function createLlamaBuildCheck(input: {
  quarantine: readonly LlamaQuarantineEntry[];
  platform: NodeJS.Platform;
  /** Test seam; defaults to reading this host's driver. */
  cudaBlockerFor?: (binaryPath: string) => NvidiaCudaBlocker | null;
  /**
   * Asks the ROCm build which GPUs it can drive (`checkRocmBuild`). Without
   * it a ROCm build is never vetoed for its devices — the caller has no home
   * to cache the answer in.
   */
  rocmCheckFor?: (binaryPath: string) => RocmCheck;
}): LlamaBuildCheck {
  const blockerFor = input.cudaBlockerFor ?? linuxCudaBuildBlocker;
  const quarantined = new Set<LlamaBackend>();
  let blocker: NvidiaCudaBlocker | null = null;
  let rocm: RocmCheck | null = null;
  return {
    isUsable: (backend, path) => {
      if (input.quarantine.length > 0 && isBinaryQuarantined(input.quarantine, backend, path)) {
        quarantined.add(backend);
        return false;
      }
      if (backend === 'cuda' && input.platform === 'linux') {
        blocker = blockerFor(path);
        if (blocker) return false;
      }
      if (backend === 'rocm' && input.rocmCheckFor) {
        rocm = input.rocmCheckFor(path);
        if (rocm.blocker) return false;
      }
      return true;
    },
    cudaBlocker: () => blocker,
    rocmCheck: () => rocm,
    quarantinedOf: (skipped) => skipped.filter((backend) => quarantined.has(backend)),
  };
}

/** Stamp (or clear) the blocker for the engine process to report. */
export function publishLlamaCudaBlocker(
  blocker: NvidiaCudaBlocker | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (blocker) env[LLAMA_CUDA_BLOCKER_ENV] = JSON.stringify(blocker);
  else delete env[LLAMA_CUDA_BLOCKER_ENV];
}

const BLOCKER_KINDS = new Set(['module-not-loaded', 'restart-required', 'driver-too-old']);

/** The blocker discovery published, or null for none or a malformed value. */
export function readLlamaCudaBlocker(
  env: NodeJS.ProcessEnv = process.env,
): NvidiaCudaBlocker | null {
  const raw = env[LLAMA_CUDA_BLOCKER_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NvidiaCudaBlocker>;
    if (typeof parsed.kind !== 'string' || !BLOCKER_KINDS.has(parsed.kind)) return null;
    if (typeof parsed.detail !== 'string') return null;
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    const installed = text(parsed.installed);
    const loaded = text(parsed.loaded);
    const required = text(parsed.required);
    const cudaToolkit = text(parsed.cudaToolkit);
    return {
      kind: parsed.kind as NvidiaCudaBlocker['kind'],
      detail: parsed.detail,
      ...(installed ? { installed } : {}),
      ...(loaded ? { loaded } : {}),
      ...(required ? { required } : {}),
      ...(cudaToolkit ? { cudaToolkit } : {}),
    };
  } catch {
    return null;
  }
}
