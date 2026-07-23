/**
 * GpuPanicGuard — refuse to spawn a fresh local GPU engine right after a
 * macOS GPU-driver kernel panic, so gezel doesn't re-trigger the crash loop.
 *
 * Background: heavy Metal use on Apple Silicon can trip a latent Apple GPU
 * driver bug (`IOGPUMemory.cpp` "completeMemory() prepare count underflow").
 * It is NOT OOM and NOT gezel code — a userspace process can't panic the
 * kernel — but our model load/unload + KV churn triggers it, and once the
 * machine reboots, autostart / scheduled jobs / a retried chat would happily
 * spawn the same workload again and crash it a second time. No telemetry
 * threshold catches a driver refcount underflow; the only defense is to stop
 * re-triggering.
 *
 * macOS writes a `.panic` report on the boot after a panic
 * ({@link findRecentGpuPanics}). When one is recent, this guard denies new
 * local-engine spawns (mlx + llama.cpp + ds4 — all Metal on a Mac) with a
 * clear, actionable message, for a cooldown window. The user can override
 * (`GEZEL_GPU_PANIC_GUARD=off`) to use local models at their own risk, or
 * update macOS (Apple's fix). No-op off macOS and for non-GPU providers.
 *
 * Wired at the single spawn chokepoint — {@link ProviderPool.buildEntry} —
 * so interactive chat AND autonomous jobs are both covered.
 */

import { createLogger } from '@bendyline/gezel';
import { type GpuPanicRecord, findRecentGpuPanics } from '@bendyline/gezel/native';
import type { LocalProviderName } from './engine-key.js';

const log = createLogger('gpu-panic');

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export interface GpuPanicDecision {
  blocked: boolean;
  reason?: string;
  panic?: GpuPanicRecord;
}

/** Minimal shape the pool depends on — keeps ProviderPool decoupled + testable. */
export interface GpuSpawnGuard {
  check(engine: LocalProviderName): GpuPanicDecision;
}

export interface GpuPanicGuardOptions {
  /** Force on/off. Default: on for macOS unless `GEZEL_GPU_PANIC_GUARD=off`. */
  enabled?: boolean;
  /** Block window after the most recent panic. Default 1h (env override:
   * `GEZEL_GPU_PANIC_COOLDOWN_HOURS`). */
  cooldownMs?: number;
  /** Test seams. */
  now?: () => number;
  find?: typeof findRecentGpuPanics;
}

export class GpuPanicGuard implements GpuSpawnGuard {
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly find: typeof findRecentGpuPanics;

  constructor(opts: GpuPanicGuardOptions = {}) {
    const envOff = process.env.GEZEL_GPU_PANIC_GUARD === 'off';
    this.enabled = opts.enabled ?? (process.platform === 'darwin' && !envOff);
    const envHours = Number.parseFloat(process.env.GEZEL_GPU_PANIC_COOLDOWN_HOURS ?? '');
    this.cooldownMs =
      opts.cooldownMs ??
      (Number.isFinite(envHours) && envHours > 0 ? envHours * 60 * 60 * 1000 : DEFAULT_COOLDOWN_MS);
    this.now = opts.now ?? Date.now;
    this.find = opts.find ?? findRecentGpuPanics;
  }

  check(engine: LocalProviderName): GpuPanicDecision {
    if (!this.enabled) return { blocked: false };
    const panics = this.find({ withinMs: this.cooldownMs, now: this.now() });
    const panic = panics[0];
    if (!panic) return { blocked: false };
    const reason = formatSpawnDenial(panic, this.cooldownMs);
    log.warn(
      `[gpu-panic] denying ${engine} engine spawn — recent GPU kernel panic (${panic.signature}, ${panic.when.toISOString()})`,
    );
    return { blocked: true, reason, panic };
  }
}

/** User-facing denial: what happened, why it's blocked, how to proceed. */
export function formatSpawnDenial(panic: GpuPanicRecord, cooldownMs: number): string {
  const hours = Math.max(1, Math.round(cooldownMs / (60 * 60 * 1000)));
  return `Local on-device models are paused because macOS recorded a GPU kernel panic at ${panic.when.toISOString()} (${panic.signature}). This is an Apple GPU-driver bug that heavy local-model use can trigger — loading another model now risks crashing and rebooting your Mac again. gezel pauses new local engines for ${hours}h after a panic. To proceed at your own risk, set GEZEL_GPU_PANIC_GUARD=off; the real fix is a macOS update. Cloud providers are unaffected.`;
}
