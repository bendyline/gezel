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
 * KV plus scratch, so the working ceiling sits just under that.
 *
 * Deliberately not higher. The budget is also what
 * {@link localEngineSlotCeiling} sizes concurrent KV slots against, so
 * raising it buys more than a bigger model — past ~0.72 on a 64 GB Mac a
 * 27B-q8 at 32K f16 goes from serial to two slots, which is the exact
 * shape that aborted Metal (see the regression test of that name). Growing
 * the load ceiling should not silently grow peak concurrency; until those
 * two are decoupled, this fraction has to respect both.
 */
const UNIFIED_FRACTION = 0.7;

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
 * Unified-memory hosts below the workstation tier get
 * {@link UNIFIED_FRACTION} of the pool, minus a flat
 * {@link UNIFIED_OS_RESERVE_BYTES} floor. Everything else keeps the
 * discrete-GPU curve: 60% of system RAM, or 80% on 96 GB+ workstations,
 * capped at {@link BUDGET_CAP_BYTES}.
 *
 * The unified curve is more permissive than the discrete one at the 16–64
 * GB end. That is where the old shared 60% fraction denied models the
 * machine could actually hold — a 16 GB Mac was capped at 9.6 GiB, below
 * any 8B-class model at 8-bit. It also means a fully committed budget on a
 * small Mac will lean on compressed memory; the `localEngineMemoryGb`
 * setting (Settings → the engine pages) is the dial for owners who want
 * that traded either way.
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
  const highMemory = systemRamBytes >= HIGH_MEMORY_THRESHOLD_BYTES;
  const unified = opts.unifiedMemory ?? isUnifiedMemoryHost();
  if (unified && !highMemory) {
    return Math.max(
      0,
      Math.min(
        Math.floor(systemRamBytes * UNIFIED_FRACTION),
        systemRamBytes - UNIFIED_OS_RESERVE_BYTES,
        BUDGET_CAP_BYTES,
      ),
    );
  }
  // Workstation-tier hosts already got the generous share, unified or not.
  const fraction = highMemory ? 0.8 : 0.6;
  return Math.min(Math.floor(systemRamBytes * fraction), BUDGET_CAP_BYTES);
}
