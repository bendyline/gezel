/**
 * Can this Linux host's NVIDIA driver run a bundled CUDA build of
 * llama-server? Asked before the build is chosen, because the answer cannot
 * be learned from a crash: the Linux builds load their GPU backend with
 * dlopen, and a CUDA backend that cannot initialize leaves the engine running
 * on the CPU without a word. The person sees a GPU in Settings and gets CPU
 * speed.
 *
 * Three states rule CUDA out, each read from files any account can read:
 *
 * - **Module not loaded.** `libcuda.so.1` is installed but the kernel module
 *   is not (`/proc/driver/nvidia/version` is missing): typically a kernel
 *   update whose DKMS rebuild of the module failed, or Secure Boot refusing
 *   it.
 * - **Restart required.** The library and the loaded module are different
 *   versions — a driver update installed but not yet loaded. CUDA refuses
 *   that combination until the computer restarts.
 * - **Driver too old.** The driver predates the CUDA runtime the build ships
 *   (`cudaToolkit` in `gezel-llama-build.json`): CUDA 13 needs R580, CUDA 12
 *   needs R525.
 *
 * A CUDA build ruled out this way is skipped for the next build down, like a
 * quarantined one, but nothing is written down: the next launch asks again,
 * so a restart or a driver update brings CUDA back by itself.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LINUX_CUDA_DRIVER_PATHS } from './llama-backend.js';

export type NvidiaCudaBlockerKind = 'module-not-loaded' | 'restart-required' | 'driver-too-old';

export interface NvidiaCudaBlocker {
  kind: NvidiaCudaBlockerKind;
  /** The driver version installed (the library's), when it could be read. */
  installed?: string;
  /** The kernel module's version, when it differs from the library's. */
  loaded?: string;
  /** The oldest driver the build's CUDA runtime accepts. */
  required?: string;
  /** The CUDA toolkit the build was compiled with. */
  cudaToolkit?: string;
  /** One line for logs and a "Technical details" disclosure. */
  detail: string;
}

/**
 * Oldest Linux driver each CUDA major accepts under minor-version
 * compatibility (NVIDIA's CUDA compatibility table).
 */
const MINIMUM_LINUX_DRIVER: ReadonlyMap<number, string> = new Map([
  [11, '450.80.02'],
  [12, '525.60.13'],
  [13, '580.65.06'],
]);

/** `580.173.02` from `/proc/driver/nvidia/version`, for the open and proprietary modules. */
export function parseNvidiaModuleVersion(text: string): string | null {
  return /Kernel Module(?:\s+for\s+\S+)?\s+(\d+(?:\.\d+)+)/.exec(text)?.[1] ?? null;
}

/** `580.173.02` from the file `libcuda.so.1` resolves to (`libcuda.so.580.173.02`). */
export function nvidiaLibraryVersion(resolvedLibcuda: string): string | null {
  return /^libcuda\.so\.(\d+\.\d+(?:\.\d+)*)$/.exec(basename(resolvedLibcuda))?.[1] ?? null;
}

export function minimumNvidiaDriverForCuda(cudaToolkit: string): string | null {
  const major = Number.parseInt(cudaToolkit, 10);
  return MINIMUM_LINUX_DRIVER.get(major) ?? null;
}

/** Compare dotted driver versions numerically, segment by segment. */
export function compareDriverVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The decision, from facts already read. Null when CUDA can run. */
export function nvidiaCudaBlocker(input: {
  moduleVersion: string | null;
  libraryVersion: string | null;
  cudaToolkit?: string | undefined;
}): NvidiaCudaBlocker | null {
  const { moduleVersion, libraryVersion, cudaToolkit } = input;
  if (moduleVersion === null) {
    return {
      kind: 'module-not-loaded',
      ...(libraryVersion ? { installed: libraryVersion } : {}),
      detail: `libcuda${libraryVersion ? ` ${libraryVersion}` : ''} is installed but the NVIDIA kernel module is not loaded (/proc/driver/nvidia/version is missing)`,
    };
  }
  if (libraryVersion !== null && libraryVersion !== moduleVersion) {
    return {
      kind: 'restart-required',
      installed: libraryVersion,
      loaded: moduleVersion,
      detail: `NVIDIA driver library ${libraryVersion} does not match the loaded kernel module ${moduleVersion}`,
    };
  }
  const required = cudaToolkit ? minimumNvidiaDriverForCuda(cudaToolkit) : null;
  if (cudaToolkit && required && compareDriverVersions(moduleVersion, required) < 0) {
    return {
      kind: 'driver-too-old',
      installed: moduleVersion,
      required,
      cudaToolkit,
      detail: `NVIDIA driver ${moduleVersion} is older than ${required}, which the build's CUDA ${cudaToolkit} runtime requires`,
    };
  }
  return null;
}

export interface NvidiaDriverIo {
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

function tryRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Whether the CUDA llama-server at `binaryPath` can initialize on this Linux
 * host. Null whenever it cannot tell — no `libcuda.so.1` where discovery
 * looks for it, or WSL, whose GPU path has no NVIDIA kernel module — so an
 * unreadable fact never rules CUDA out.
 */
export function linuxCudaBuildBlocker(
  binaryPath: string,
  io: NvidiaDriverIo = {},
): NvidiaCudaBlocker | null {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const realpath = io.realpath ?? ((path: string) => realpathSync(path));
  const fileExists = io.fileExists ?? existsSync;
  const libcuda = LINUX_CUDA_DRIVER_PATHS.find((path) => fileExists(path));
  if (!libcuda || fileExists('/dev/dxg')) return null;
  const moduleText = tryRead(() => readFile('/proc/driver/nvidia/version'));
  const moduleVersion = moduleText === null ? null : parseNvidiaModuleVersion(moduleText);
  // A module that is loaded but reports in a format this build cannot read
  // says nothing either way.
  if (moduleText !== null && moduleVersion === null) return null;
  const resolved = tryRead(() => realpath(libcuda));
  const build = tryRead(
    () =>
      JSON.parse(readFile(join(dirname(binaryPath), 'gezel-llama-build.json'))) as {
        cudaToolkit?: unknown;
      },
  );
  return nvidiaCudaBlocker({
    moduleVersion,
    libraryVersion: resolved === null ? null : nvidiaLibraryVersion(resolved),
    cudaToolkit: typeof build?.cudaToolkit === 'string' ? build.cudaToolkit : undefined,
  });
}
