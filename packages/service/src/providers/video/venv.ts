/**
 * Single source of truth for the video-engine Python venv spec — the
 * venv name and the per-accelerator package list `UvRuntime.ensureVenv`
 * provisions. The video sibling of `providers/mlx/venv.ts`.
 *
 * The one genuinely new cross-platform concern (vs the Apple-Silicon-only
 * MLX engine) is the **PyTorch wheel**: the right build depends on the
 * accelerator, and on Linux/Windows that means pulling from PyTorch's own
 * package index rather than PyPI.
 *
 *   - `mps`  (Apple Silicon) — PyPI's default `torch` wheel is
 *     Metal/MPS-capable. No extra index needed.
 *   - `cuda` (Win/Linux + NVIDIA) — pin the `+cuXXX` local-version wheel
 *     and add PyTorch's CUDA index as an *extra* index, so torch resolves
 *     from there while `diffusers`/`transformers`/etc. still come from
 *     PyPI. The `+cuXXX` local tag only exists on the PyTorch index, which
 *     forces the resolver to take the GPU build instead of PyPI's default.
 *   - `cpu`  (everywhere, fallback) — the `+cpu` wheel from PyTorch's CPU
 *     index, avoiding the multi-GB CUDA libraries on a host that can't use
 *     them. Generation is very slow on CPU; the engine status surfaces a
 *     warning.
 *
 * `UvRuntime.ensureVenv` folds the index config into its manifest
 * fast-path key, so switching accelerators (e.g. a `cpu` test box → a
 * `cuda` box, or a torch-version bump) reinstalls instead of silently
 * reusing the wrong build.
 */

import { exec as nodeExec } from 'node:child_process';
import { promisify } from 'node:util';
import type { VideoAccelerator } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';

const log = createLogger('video');
const execAsync = promisify(nodeExec);

/** Venv name passed to `UvRuntime.ensureVenv` (and its dir basename). */
export const VIDEO_VENV_NAME = 'video';

/**
 * Pinned torch / torchvision pair. A matched pair is required — torchvision
 * hard-pins the torch version it was built against. Advanced users can
 * override via `config.videoTorchSpec` (future Settings field); the pin
 * keeps the default reproducible. Bump both together.
 */
const TORCH_VERSION = '2.5.1';
const TORCHVISION_VERSION = '0.20.1';

/**
 * Windows on ARM has its own pair. PyTorch publishes CPU wheels only there
 * (from torch 2.7.0; no CUDA index carries a win_arm64 wheel), and the
 * 2.5.1 pair above has none at all. torchvision's win_arm64 wheels carry
 * git-hash local versions (`0.28.0+8fb8771`) rather than `+cpu`, so it is
 * pinned by public version, which matches them. The newest matched stable
 * pair as of 2026-10; the oldest is 2.9.0 / 0.24.0.
 */
const WINDOWS_ARM64_TORCH_VERSION = '2.13.0';
const WINDOWS_ARM64_TORCHVISION_VERSION = '0.28.0';

/** PyTorch package indexes for the non-default (Win/Linux) wheels. */
const PYTORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu124';
const PYTORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

interface VideoHost {
  platform: NodeJS.Platform;
  arch: string;
}

const THIS_HOST: VideoHost = { platform: process.platform, arch: process.arch };

function isWindowsOnArm(host: VideoHost): boolean {
  return host.platform === 'win32' && host.arch === 'arm64';
}

/** Why this host's video engine is on the CPU when the platform decides it. */
export function videoCpuReason(host: VideoHost = THIS_HOST): 'no-gpu-build' | undefined {
  return isWindowsOnArm(host) ? 'no-gpu-build' : undefined;
}

/**
 * The interpreter uv provisions the venv with. On Windows on ARM it is named
 * down to the architecture: uv there otherwise downloads an x86_64 CPython,
 * whose venv then needs x86_64 wheels and runs under emulation.
 */
export function videoPythonRequest(host: VideoHost = THIS_HOST): string {
  return isWindowsOnArm(host) ? 'cpython-3.12-windows-aarch64-none' : '3.12';
}

/**
 * Packages every accelerator needs on top of torch: the diffusers stack
 * plus the mp4 encoder (`imageio-ffmpeg` bundles a static ffmpeg so we
 * don't depend on a system one) and the T5 text-encoder tokenizer deps
 * (`sentencepiece` + `protobuf`).
 */
const COMMON_PACKAGES = [
  // The floor is set by the newest family: LTX-2 pipelines arrived in
  // 0.37, LTX-2.3 (its VAE layout and 48 kHz vocoder) in 0.38, and 0.39
  // fixed a connector regression that reversed the text-token order LTX-2.x
  // was trained on. WAN (0.35) and LTX 0.9.x (0.32) are older still. A
  // floor bump re-provisions existing venvs through `ensureVenv`'s spec key.
  'diffusers>=0.39.0',
  // Gemma 3 (`Gemma3ForConditionalGeneration`, the LTX-2.x text encoder).
  'transformers>=4.50.0',
  'accelerate>=1.2.0',
  'safetensors>=0.4.5',
  'sentencepiece>=0.2.0',
  'protobuf>=4.25.0',
  'imageio>=2.36.0',
  'imageio-ffmpeg>=0.5.1',
  // PyAV — diffusers' LTX-2 export muxes the generated audio track into the
  // MP4 via `encode_video`, which imports `av`. Silent-video families never
  // hit this path, but LTX-2/2.3 do, so it's part of the shared floor.
  'av>=12.0.0',
  'numpy>=1.26.0',
];

export interface VideoVenvSpec {
  packages: string[];
  extraIndexUrls?: string[];
}

/**
 * The package list + index config to install into the video venv for a
 * given accelerator. Funnel both the lazy first-generate path and any
 * install-time warm through here so they request the identical spec
 * (otherwise the second caller misses the manifest fast-path; see
 * `providers/mlx/venv.ts` for the same hazard).
 */
export function videoVenvSpec(accel: VideoAccelerator, host: VideoHost = THIS_HOST): VideoVenvSpec {
  if (isWindowsOnArm(host)) {
    return {
      packages: [
        `torch==${WINDOWS_ARM64_TORCH_VERSION}+cpu`,
        `torchvision==${WINDOWS_ARM64_TORCHVISION_VERSION}`,
        ...COMMON_PACKAGES,
      ],
      extraIndexUrls: [PYTORCH_CPU_INDEX],
    };
  }
  if (accel === 'cuda') {
    return {
      packages: [
        `torch==${TORCH_VERSION}+cu124`,
        `torchvision==${TORCHVISION_VERSION}+cu124`,
        ...COMMON_PACKAGES,
      ],
      extraIndexUrls: [PYTORCH_CUDA_INDEX],
    };
  }
  if (accel === 'cpu') {
    return {
      packages: [
        `torch==${TORCH_VERSION}+cpu`,
        `torchvision==${TORCHVISION_VERSION}+cpu`,
        ...COMMON_PACKAGES,
      ],
      extraIndexUrls: [PYTORCH_CPU_INDEX],
    };
  }
  // mps — PyPI's default wheel is MPS-capable on Apple Silicon. Pin a
  // FLOOR rather than an exact version: the exact `torch==2.5.1` build
  // has wheels only for a fixed set of Python versions, so on a newer
  // (or older) interpreter `pip install` can't find it and the whole
  // install fails with exit code 1. A floor lets pip resolve the newest
  // torch/torchvision pair that actually has a wheel for the venv's
  // Python. (cuda/cpu must keep exact `+local` pins — those builds live
  // only on the PyTorch index, where a floor can't address a
  // local-version wheel.)
  return {
    packages: [
      `torch>=${TORCH_VERSION}`,
      `torchvision>=${TORCHVISION_VERSION}`,
      ...COMMON_PACKAGES,
    ],
  };
}

let cachedAccelerator: VideoAccelerator | undefined;

/**
 * Detect the accelerator the video engine should target on this host.
 *
 *   - Apple Silicon → `mps`.
 *   - Windows on ARM → `cpu`, even with an NVIDIA GPU (see below).
 *   - Win/Linux with an NVIDIA GPU (detected via `nvidia-smi` on PATH) →
 *     `cuda`.
 *   - Everything else (Intel Mac, NVIDIA-less Win/Linux) → `cpu`.
 *
 * The `nvidia-smi` probe is cheap (no torch import) and the result is
 * cached for the process — accelerators don't change under a running
 * service. Tests can reset via {@link resetAcceleratorCache}.
 */
export async function detectVideoAccelerator(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<VideoAccelerator> {
  if (cachedAccelerator) return cachedAccelerator;
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;

  if (platform === 'darwin') {
    // Apple Silicon → MPS; Intel Macs have no usable GPU path → CPU.
    cachedAccelerator = arch === 'arm64' ? 'mps' : 'cpu';
    return cachedAccelerator;
  }

  // An RTX Spark answers nvidia-smi, but PyTorch builds no CUDA wheel for
  // Windows on ARM, so asking for one would fail the whole install.
  if (isWindowsOnArm({ platform, arch })) {
    cachedAccelerator = 'cpu';
    return cachedAccelerator;
  }

  if (platform === 'win32' || platform === 'linux') {
    if (await hasNvidiaGpu()) {
      cachedAccelerator = 'cuda';
      return cachedAccelerator;
    }
  }

  cachedAccelerator = 'cpu';
  return cachedAccelerator;
}

/** Test seam — clears the process-level accelerator cache. */
export function resetAcceleratorCache(): void {
  cachedAccelerator = undefined;
}

async function hasNvidiaGpu(): Promise<boolean> {
  try {
    // `-L` lists GPUs and exits fast; any zero-exit with output means a
    // driver + device are present. We don't parse — presence is enough.
    const { stdout } = await execAsync('nvidia-smi -L', {
      timeout: 4_000,
      // Keep the short-lived probe invisible in interactive Windows sessions.
      ...windowsHeadlessSpawnOptions(),
    });
    return /GPU\s+\d+:/i.test(stdout);
  } catch {
    return false;
  }
}

/** Whether generation on this accelerator will be painfully slow. */
export function isSlowAccelerator(accel: VideoAccelerator): boolean {
  return accel === 'cpu';
}

export { log as videoVenvLog };
