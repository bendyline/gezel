/**
 * macOS GPU kernel-panic guard for the eval harness.
 *
 * Heavy MLX (Metal) eval sweeps on Apple Silicon can trip a latent Apple GPU
 * *driver* bug — a kernel panic in `IOGPUMemory.cpp` ("completeMemory()
 * prepare count underflow", driver `AGXAcceleratorG16X`). Wild-caught
 *a `gemma4-12b-q4` `--suite core` MLX sweep panicked the box
 * (M4 Max, macOS 26.5.2) ~29 min in; an identical panic hit the day before.
 *
 * This is NOT out-of-memory and NOT gezel/MLX code — only a driver bug can
 * panic the kernel; our per-trial Metal churn merely *triggers* it. No
 * thermal/memory threshold catches a driver refcount underflow, so the one
 * thing a guard CAN do is break the crash→reboot→auto-relaunch→crash LOOP:
 * after a panic, macOS writes a `.panic` report; if a recent one carries a
 * GPU-driver signature, refuse to auto-launch another MLX sweep until the
 * operator acknowledges (or updates macOS, the real fix).
 *
 * Detection ({@link findRecentGpuPanics}) is shared with the service's
 * in-product guard (`@bendyline/gezel/native`) so the two never drift.
 */

import { type GpuPanicRecord, findRecentGpuPanics } from '@bendyline/gezel/native';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export type { GpuPanicRecord };
export { findRecentGpuPanics };

/** Human-readable operator warning for a set of recent GPU panics. */
export function formatGpuPanicWarning(
  panics: GpuPanicRecord[],
  cooldownMs = DEFAULT_COOLDOWN_MS,
): string {
  const top = panics[0]!;
  const when = top.when.toISOString();
  const hours = Math.max(1, Math.round(cooldownMs / (60 * 60 * 1000)));
  const lines = [
    '',
    '  ⚠️  RECENT GPU KERNEL PANIC DETECTED — MLX eval launch blocked.',
    '',
    `  macOS recorded ${panics.length} GPU-driver kernel panic(s) in the last ${hours}h.`,
    `  Most recent: ${when}`,
    `  Signature:   ${top.signature}`,
    `  Report:      ${top.file}`,
    '',
    '  This is an Apple GPU-driver bug that heavy MLX Metal workloads trigger;',
    '  auto-relaunching another sweep risks another panic + reboot loop. Fixes,',
    '  highest leverage first: update macOS; reduce per-trial Metal churn; then',
    '  re-run. To proceed anyway, pass --ignore-gpu-panic (or set',
    '  GEZEL_EVAL_IGNORE_GPU_PANIC=1).',
    '',
  ];
  return lines.join('\n');
}

/**
 * Gate an MLX-engine sweep on recent GPU panics. Returns `{ block: true }`
 * with a formatted message when a recent GPU panic exists and the operator
 * hasn't overridden. No-op (returns `{ block: false }`) off macOS, for
 * non-MLX engines, or when overridden.
 */
export function checkGpuPanicGate(input: {
  engine: string;
  ignore?: boolean;
  withinMs?: number;
  dirs?: string[];
  now?: number;
}): { block: boolean; message?: string; panics: GpuPanicRecord[] } {
  const override = input.ignore || process.env.GEZEL_EVAL_IGNORE_GPU_PANIC === '1';
  // Only MLX drives the Metal churn that trips this. (llama.cpp Metal is
  // lower-churn; extend here if it starts panicking too.)
  if (input.engine !== 'mlx') return { block: false, panics: [] };
  const withinMs = input.withinMs ?? DEFAULT_COOLDOWN_MS;
  const panics = findRecentGpuPanics({
    withinMs,
    ...(input.dirs !== undefined ? { dirs: input.dirs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (panics.length === 0) return { block: false, panics: [] };
  if (override) return { block: false, panics };
  return { block: true, message: formatGpuPanicWarning(panics, withinMs), panics };
}
