/**
 * macOS GPU kernel-panic detection.
 *
 * Heavy Metal workloads on Apple Silicon can trip a latent Apple GPU *driver*
 * bug: a kernel panic in `IOGPUMemory.cpp` ("completeMemory() prepare count
 * underflow", driver family `AGXAcceleratorG16X`). Wild-caught on
 * an M4 Max running local MLX models — an identical panic hit two days
 * running. It is NOT out-of-memory and NOT gezel/MLX code: a userspace
 * process can't panic the kernel; only a driver bug can. Our GPU
 * allocate/free churn (loading/unloading models, KV cache) merely *triggers*
 * it.
 *
 * No thermal/memory telemetry threshold catches a driver refcount underflow,
 * so the one thing gezel can do is DETECT that a panic happened (macOS writes
 * a `.panic` report on the next boot) and stop re-triggering the loop —
 * refuse to auto-spawn a fresh local GPU engine right after a panic until the
 * operator acknowledges. This module is the pure detector; consumers (the
 * service's engine-spawn guard, the eval harness) decide policy.
 *
 * Node built-ins only, so it lives in core native alongside device-health.
 * No-op off macOS.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PANIC_DIRS = [
  '/Library/Logs/DiagnosticReports',
  join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
];

/**
 * Panic strings that implicate the GPU / Metal kernel driver — the class
 * Metal churn triggers. Broad across Apple GPU driver families (AGX = Apple
 * GPU) and the IOAccelerator/IOGPU memory paths so a slightly different
 * underflow site or a newer SoC's accelerator name still matches.
 */
export const GPU_PANIC_RE =
  /IOGPUMemory|IOAccelerator|AGXAccelerator|AGXG\d|completeMemory\(\)\s+prepare\s+count\s+underflow|IOGPUFamily/i;

export interface GpuPanicRecord {
  /** Absolute path to the `.panic`/`.ips` report. */
  file: string;
  /** Report file mtime — when macOS wrote it (≈ the reboot after the panic). */
  when: Date;
  /** The matched driver signature, for the operator message. */
  signature: string;
}

export interface FindGpuPanicOptions {
  /** Only report panics newer than this many ms ago. Default 24h. */
  withinMs?: number;
  /** Injected for tests: current time. Defaults to `Date.now()`. */
  now?: number;
  /** Injected for tests: directories to scan. Defaults to the macOS report dirs. */
  dirs?: string[];
}

/**
 * Return GPU-driver kernel panics recorded within the window, newest first.
 * Empty on non-macOS (no report dirs) or when nothing matches.
 */
export function findRecentGpuPanics(opts: FindGpuPanicOptions = {}): GpuPanicRecord[] {
  const dirs = opts.dirs ?? (process.platform === 'darwin' ? PANIC_DIRS : []);
  const withinMs = opts.withinMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  const out: GpuPanicRecord[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.panic') || f.endsWith('.ips'));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > withinMs) continue;
      let text: string;
      try {
        // Panic reports are small; cap the read so a malformed giant file
        // can't stall the scan.
        text = readFileSync(path, 'utf8').slice(0, 16_384);
      } catch {
        continue;
      }
      const m = GPU_PANIC_RE.exec(text);
      if (m) out.push({ file: path, when: new Date(mtimeMs), signature: m[0] });
    }
  }
  return out.sort((a, b) => b.when.getTime() - a.when.getTime());
}
