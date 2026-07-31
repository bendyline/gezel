import { arch, platform, totalmem } from 'node:os';

const GIB = 1024 ** 3;

/** Ceiling on the auto-derived budget however much RAM the host reports. */
const BUDGET_CAP_BYTES = 96 * GIB;

/** Above this, a discrete-GPU/CPU host is treated as workstation-tier. */
const HIGH_MEMORY_THRESHOLD_BYTES = 96 * GIB;

/**
 * Fraction of unified memory local engines may hold. Apple Silicon shares
 * one pool between CPU and GPU, so the split that protects a discrete-GPU
 * host from cramping the OS just strands capacity here: the weights sit in
 * the same RAM the fraction was reserving. macOS itself lets the GPU wire
 * roughly 75% (`iogpu.wired_limit_pct`), and our budget covers weights plus
 * KV plus scratch, so 80% of the pool is the realistic working ceiling.
 */
const UNIFIED_FRACTION = 0.8;

/**
 * Floor on what stays outside the budget on a unified host. A fraction
 * alone is wrong at the small end — 80% of a 16 GB Mac leaves 3.2 GB for
 * macOS, the Electron shell, and the renderer combined. The OS reserve is
 * roughly constant in absolute terms, not proportional, so express it that
 * way and let whichever bound is tighter win.
 */
const UNIFIED_OS_RESERVE_BYTES = 4 * GIB;

/**
 * True when CPU and GPU share one physical memory pool, so a byte spent on
 * weights is a byte the OS cannot use. Apple Silicon is the case that
 * matters; Intel Macs and integrated-GPU PCs technically share too, but
 * they don't run GPU inference through this path.
 */
export function isUnifiedMemoryHost(): boolean {
  return platform() === 'darwin' && arch() === 'arm64';
}

/**
 * Auto-detect budget for resident local-engine processes, combined.
 *
 * Unified-memory hosts get {@link UNIFIED_FRACTION} of the pool, minus a
 * flat {@link UNIFIED_OS_RESERVE_BYTES} floor, capped at
 * {@link BUDGET_CAP_BYTES}. Everything else keeps the discrete-GPU curve:
 * 60% of system RAM, or 80% on 96 GB+ workstations.
 *
 * The unified curve is deliberately more permissive than the discrete one
 * at the 16–32 GB end. That is where the old shared 60% fraction denied
 * models the machine could actually hold — a 16 GB Mac was capped at
 * 9.6 GiB, below any 8B-class model at 8-bit. It also means a fully
 * committed budget on a small Mac will lean on compressed memory; the
 * `localEngineMemoryGb` setting (Settings → the engine pages) is the dial
 * for owners who want that traded back.
 *
 * `GEZEL_CAPACITY_BUDGET_GB` overrides everything, including the setting.
 */
export function autoDetectBudgetBytes(
  systemRamBytes: number = totalmem(),
  opts: { unifiedMemory?: boolean } = {},
): number {
  const envOverride = process.env.GEZEL_CAPACITY_BUDGET_GB;
  if (envOverride) {
    const gb = Number.parseFloat(envOverride);
    if (Number.isFinite(gb) && gb > 0) {
      return Math.round(gb * GIB);
    }
  }
  const unified = opts.unifiedMemory ?? isUnifiedMemoryHost();
  if (unified) {
    return Math.max(
      0,
      Math.min(
        Math.floor(systemRamBytes * UNIFIED_FRACTION),
        systemRamBytes - UNIFIED_OS_RESERVE_BYTES,
        BUDGET_CAP_BYTES,
      ),
    );
  }
  const fraction = systemRamBytes >= HIGH_MEMORY_THRESHOLD_BYTES ? 0.8 : 0.6;
  return Math.min(Math.floor(systemRamBytes * fraction), BUDGET_CAP_BYTES);
}
