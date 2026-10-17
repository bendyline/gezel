/**
 * The engine process's side of the llama-server quarantine
 * (`llama-quarantine.ts` in `@bendyline/gezel/native`): which build this
 * process launches, kept in the env discovery stamps at startup
 * (`GEZEL_LLAMA_SERVER_BIN`, `GEZEL_LLAMA_SERVER_BACKEND`,
 * `GEZEL_LLAMA_QUARANTINED`), and the view and undo behind the engine's
 * Settings tab.
 *
 * Discovery reads the quarantine only at startup. These move the env inside
 * a running process, so a quarantine and its undo both take effect on the
 * next engine launch instead of the next app start.
 */

import type { LlamaCppQuarantineResponse } from '@bendyline/gezel';
import {
  LLAMA_QUARANTINE_STRIKES,
  type LlamaBackend,
  type ResolvedLlamaBinary,
  clearLlamaQuarantine,
  createLlamaBuildCheck,
  isBinaryQuarantined,
  llamaVariantBinaryPath,
  publishLlamaCudaBlocker,
  readLlamaQuarantine,
  resolveLlamaFallbackBinary,
  resolveLlamaVariantBinary,
} from '@bendyline/gezel/native';

const BACKENDS: readonly LlamaBackend[] = ['cuda', 'vulkan', 'metal', 'cpu'];

export function isLlamaBackend(value: string): value is LlamaBackend {
  return BACKENDS.some((backend) => backend === value);
}

function envBackend(name: string): LlamaBackend | undefined {
  const raw = process.env[name];
  return raw !== undefined && isLlamaBackend(raw) ? raw : undefined;
}

function updateQuarantinedEnv(update: (backends: Set<string>) => void): void {
  const backends = new Set(process.env.GEZEL_LLAMA_QUARANTINED?.split(',').filter(Boolean));
  update(backends);
  if (backends.size > 0) process.env.GEZEL_LLAMA_QUARANTINED = [...backends].join(',');
  else delete process.env.GEZEL_LLAMA_QUARANTINED;
}

/**
 * Point this process at the build that replaces `backend`'s, just
 * quarantined, so the pool's rebuild of the failed engine launches it. Null,
 * env untouched, when nothing usable is bundled beside `binary`.
 */
export function adoptLlamaFallback(
  home: string,
  binary: string,
  backend: LlamaBackend,
): ResolvedLlamaBinary | null {
  const quarantine = readLlamaQuarantine(home);
  const fallback = resolveLlamaFallbackBinary(
    binary,
    backend,
    (candidate, path) => !isBinaryQuarantined(quarantine, candidate, path),
  );
  if (!fallback) return null;
  process.env.GEZEL_LLAMA_SERVER_BIN = fallback.path;
  process.env.GEZEL_LLAMA_SERVER_BACKEND = fallback.backend;
  updateQuarantinedEnv((backends) => backends.add(backend));
  return fallback;
}

/**
 * The quarantined builds that still apply. An entry pins its binary's bytes,
 * so one whose build an update replaced is left out — discovery ignores it
 * too. Without a resolved build to measure from, entries are shown as written.
 */
export function llamaQuarantineView(home: string): LlamaCppQuarantineResponse {
  const binary = process.env.GEZEL_LLAMA_SERVER_BIN;
  const running = envBackend('GEZEL_LLAMA_SERVER_BACKEND');
  const entries = readLlamaQuarantine(home).filter((entry) => {
    if (!isLlamaBackend(entry.backend)) return false;
    if (!binary || !running) return true;
    const path = llamaVariantBinaryPath(binary, running, entry.backend);
    return path === null || isBinaryQuarantined([entry], entry.backend, path);
  });
  return {
    entries: entries.map(({ backend, signal, reason, at, crashes }) => ({
      backend,
      signal,
      reason,
      at,
      ...(crashes !== undefined ? { crashes } : {}),
    })),
    strikeThreshold: LLAMA_QUARANTINE_STRIKES,
    ...(running ? { running } : {}),
  };
}

/**
 * Lift `backend`'s quarantine at a person's request. Unless they pinned a
 * backend, also point this process back at the best build the hardware
 * supports, so the next engine launch tries it; `restored` is that build when
 * the env moved. A pinned backend is launched as pinned and was never routed
 * around, so there is nothing to move back.
 */
export function liftLlamaQuarantine(
  home: string,
  backend: LlamaBackend,
  opts: { pinned: boolean },
): { cleared: boolean; restored: ResolvedLlamaBinary | null } {
  const cleared = clearLlamaQuarantine(home, backend);
  updateQuarantinedEnv((backends) => backends.delete(backend));
  const binary = process.env.GEZEL_LLAMA_SERVER_BIN;
  const running = envBackend('GEZEL_LLAMA_SERVER_BACKEND');
  if (opts.pinned || !binary || !running) return { cleared, restored: null };
  // Discovery's own check: a CUDA build the driver cannot run stays passed
  // over, whatever else was lifted.
  const check = createLlamaBuildCheck({
    quarantine: readLlamaQuarantine(home),
    platform: process.platform,
  });
  const best = resolveLlamaVariantBinary(
    binary,
    running,
    envBackend('GEZEL_LLAMA_DETECTED_BACKEND') ?? backend,
    check.isUsable,
  );
  publishLlamaCudaBlocker(check.cudaBlocker());
  if (!best || best.backend === running) return { cleared, restored: null };
  process.env.GEZEL_LLAMA_SERVER_BIN = best.path;
  process.env.GEZEL_LLAMA_SERVER_BACKEND = best.backend;
  return { cleared, restored: best };
}
