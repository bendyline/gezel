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
import { readLlamaCudaBlocker } from '@bendyline/gezel/native';
import type { GpuUnused } from './gpu-startup-watch.js';

type GpuUnusedState = NonNullable<LlamaCppBackendHealthResponse['gpuUnused']>;
type OutOfMemoryState = NonNullable<LlamaCppBackendHealthResponse['outOfMemory']>;

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

export function llamaBackendHealthView(): LlamaCppBackendHealthResponse {
  const runningRaw = process.env.GEZEL_LLAMA_SERVER_BACKEND;
  const running = BACKENDS.find((backend) => backend === runningRaw);
  const cudaBlocker = readLlamaCudaBlocker();
  // A verdict about a build the process has since moved off (a quarantine
  // fallback, a lifted quarantine) no longer describes what runs.
  const unused = gpuUnused && gpuUnused.backend === running ? gpuUnused : null;
  return {
    ...(running ? { running } : {}),
    ...(cudaBlocker ? { cudaBlocker } : {}),
    ...(unused ? { gpuUnused: unused } : {}),
    ...(outOfMemory ? { outOfMemory } : {}),
  };
}

export function __resetLlamaBackendHealthForTest(): void {
  gpuUnused = null;
  outOfMemory = null;
}
