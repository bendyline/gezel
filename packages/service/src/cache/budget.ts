/**
 * RAM-aware default cache-budget heuristic.
 *
 * Operators tune via `config.cacheBudgetMb.{mlx,llamaCpp}`; when those
 * are unset the controller falls back to a tier picked from system
 * RAM. Tiered (not continuous) so the default is predictable per
 * machine class — a 32 GB Mac always sees 4 GB, a 16 GB Mac always
 * sees 2 GB, etc. — rather than some weird fractional number that
 * shifts when other apps reserve memory.
 *
 * Conservative on purpose. The auto-default never bites unsupervised:
 * users with unusual setups (e.g. a 16 GB Mac dedicated to one chat)
 * tune up via Settings.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function defaultCacheBudgetMb(systemRamBytes: number): number {
  // Sized so a typical 25K-token Meester session (~2.5 GB at our
  // 100 KB/token estimate) fits comfortably without triggering
  // eviction on the smallest supported Macs. Overbudget single
  // sessions are kept anyway (in-engine "don't evict the only entry"
  // rule), but the auto-tier should still be generous enough that
  // multi-session users don't see surprise eviction either.
  if (systemRamBytes < 16 * GB) return 2048; // <16 GB → 2 GB (one warm session)
  if (systemRamBytes < 32 * GB) return 4096; // 16–32 GB → 4 GB (two warm sessions)
  if (systemRamBytes < 64 * GB) return 8192; // 32–64 GB → 8 GB (several)
  return 16384; // ≥64 GB → 16 GB (many)
}
