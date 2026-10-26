/**
 * Whether llama-server is getting the hardware this machine has, as the
 * engine process sees it: the CUDA build discovery passed over for the
 * driver (`GEZEL_LLAMA_CUDA_BLOCKER`), a GPU build that started without its
 * GPU (gpu-startup-watch.ts), and Linux's out-of-memory killer stopping the
 * engine. Each is invisible otherwise — the engine keeps answering, slower,
 * or a chat fails with a crash that reads like any other.
 *
 * Process-wide like the backend env it sits beside: every llama provider in
 * this process launches the same build.
 */

import type { LlamaCppBackendHealthResponse } from '@bendyline/gezel';
import {
  missingMachineRuntime,
  readLlamaCudaBlocker,
  vcRedistributableUrl,
} from '@bendyline/gezel/native';
import type { GpuUnused } from './gpu-startup-watch.js';

type GpuUnusedState = NonNullable<LlamaCppBackendHealthResponse['gpuUnused']>;
type OutOfMemoryState = NonNullable<LlamaCppBackendHealthResponse['outOfMemory']>;
type MissingRuntimeState = NonNullable<LlamaCppBackendHealthResponse['missingRuntime']>;

/**
 * Reading an engine's import tables takes tens of milliseconds of synchronous
 * file reads, and the answer only changes when someone installs the runtime.
 */
const RUNTIME_CHECK_TTL_MS = 60_000;
let runtimeCheck: { binary: string; at: number; value: MissingRuntimeState | null } | null = null;

/**
 * Windows: whether this PC can load the runtime every engine imports, read from
 * the first engine binary discovery found. One is enough: they all link the
 * same runtime.
 */
export function readMissingRuntime(
  now: number = Date.now(),
  platform: NodeJS.Platform = process.platform,
): MissingRuntimeState | null {
  if (platform !== 'win32') return null;
  const binary = [
    process.env.GEZEL_LLAMA_SERVER_BIN,
    process.env.GEZEL_SD_SERVER_BIN,
    process.env.GEZEL_WHISPER_SERVER_BIN,
  ].find((path): path is string => Boolean(path));
  if (!binary) return null;
  if (runtimeCheck?.binary === binary && now - runtimeCheck.at < RUNTIME_CHECK_TTL_MS) {
    return runtimeCheck.value;
  }
  const failure = missingMachineRuntime(binary, process.env);
  const arch = failure?.arch === 'arm64' || failure?.arch === 'x64' ? failure.arch : null;
  const value =
    failure && arch
      ? {
          arch,
          dll: failure.dll ?? 'VCRUNTIME140.dll',
          downloadUrl: vcRedistributableUrl(arch),
          detail: `${binary}: ${failure.reason}`,
        }
      : null;
  runtimeCheck = { binary, at: now, value };
  return value;
}

let gpuUnused: GpuUnusedState | null = null;
let outOfMemory: OutOfMemoryState | null = null;

/** Record what the latest start of a build found; null clears it. */
export function noteGpuStartup(verdict: GpuUnused | null, now: Date = new Date()): void {
  gpuUnused = verdict ? { ...verdict, at: now.toISOString() } : null;
}

export function noteHostOutOfMemory(
  input: { model?: string | undefined; whileStarting: boolean },
  now: Date = new Date(),
): void {
  outOfMemory = {
    count: (outOfMemory?.count ?? 0) + 1,
    at: now.toISOString(),
    ...(input.model ? { model: input.model } : {}),
    whileStarting: input.whileStarting,
  };
}

const BACKENDS = ['cuda', 'vulkan', 'metal', 'cpu'] as const;

/**
 * The backend this process's on-device llama-server runs, for catalog
 * backend exclusions: the build discovery resolved, else what the probe
 * found, else the only build macOS ships. Undefined when an external server
 * is configured through the environment — its backend is not ours to know.
 */
export function currentLlamaCppBackend(): (typeof BACKENDS)[number] | undefined {
  if (process.env.GEZEL_LLAMA_SERVER_URL) return undefined;
  for (const raw of [
    process.env.GEZEL_LLAMA_SERVER_BACKEND,
    process.env.GEZEL_LLAMA_DETECTED_BACKEND,
  ]) {
    const backend = BACKENDS.find((b) => b === raw);
    if (backend) return backend;
  }
  return process.platform === 'darwin' ? 'metal' : undefined;
}

export function llamaBackendHealthView(): LlamaCppBackendHealthResponse {
  const runningRaw = process.env.GEZEL_LLAMA_SERVER_BACKEND;
  const running = BACKENDS.find((backend) => backend === runningRaw);
  const cudaBlocker = readLlamaCudaBlocker();
  // A verdict about a build the process has since moved off (a quarantine
  // fallback, a lifted quarantine) no longer describes what runs.
  const unused = gpuUnused && gpuUnused.backend === running ? gpuUnused : null;
  const missingRuntime = readMissingRuntime();
  return {
    ...(running ? { running } : {}),
    ...(cudaBlocker ? { cudaBlocker } : {}),
    ...(unused ? { gpuUnused: unused } : {}),
    ...(missingRuntime ? { missingRuntime } : {}),
    ...(outOfMemory ? { outOfMemory } : {}),
  };
}

export function __resetLlamaBackendHealthForTest(): void {
  gpuUnused = null;
  outOfMemory = null;
  runtimeCheck = null;
}
