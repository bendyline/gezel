import { totalmem } from 'node:os';

/**
 * Auto-detect budget: 60% of system RAM on ordinary machines; 80% on
 * 96 GB+ workstation machines, capped at 96 GiB. The low-memory fraction
 * keeps 16–64 GB hosts from cramping the OS. The high-memory fraction lets
 * measured workstation-tier models fit while retaining substantial headroom.
 *
 * `GEZEL_CAPACITY_BUDGET_GB` is an explicit escape hatch for unified-memory
 * systems whose owners accept the additional out-of-memory risk.
 */
export function autoDetectBudgetBytes(systemRamBytes: number = totalmem()): number {
  const envOverride = process.env.GEZEL_CAPACITY_BUDGET_GB;
  if (envOverride) {
    const gb = Number.parseFloat(envOverride);
    if (Number.isFinite(gb) && gb > 0) {
      return Math.round(gb * 1024 ** 3);
    }
  }
  const highMemoryThreshold = 96 * 1024 ** 3;
  const cap = 96 * 1024 ** 3;
  const fraction = systemRamBytes >= highMemoryThreshold ? 0.8 : 0.6;
  return Math.min(Math.floor(systemRamBytes * fraction), cap);
}
