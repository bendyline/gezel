/**
 * Host state captured alongside the preflight throughput probe.
 *
 * Why this exists: the probe's measured decode rate now scales every
 * scenario's hard ceiling (ADR 0003), and that rate was observed to vary
 * 2-4x on an *identical* model + binary + host. The variance tracked machine
 * uptime, not load:
 *
 *   uptime < 1 day   → 632-703 prefill tok/s   (three probes, 2026-08-02)
 *   uptime > 2 days  → 170-300 prefill tok/s   (three probes, 07-26 … 08-01)
 *
 * The 2026-08-01 probe ran the same binary as the fast ones and was 2.2x
 * slower at 3.5 days uptime; a reboot sits exactly on the boundary. The
 * leading hypothesis is physical-memory fragmentation on a unified-memory
 * host (the GPU reads weights from system RAM, and repeated ~29 GB model
 * loads fragment it), but it is unproven: nobody captured fragmentation
 * counters on a slow day, so the mechanism could not be confirmed after the
 * fact. That is exactly what this module fixes — it is cheap, and it turns
 * the next occurrence into a diagnosis instead of another mystery.
 *
 * Linux-only by design; every field is optional and the whole block is
 * omitted elsewhere rather than faked.
 */

export interface HostStateSnapshot {
  /** Seconds since boot. The variable that correlated with probe throughput. */
  uptimeSeconds?: number;
  memAvailableMb?: number;
  memTotalMb?: number;
  /**
   * Transparent-hugepage allocation failures since boot. Nonzero means the
   * kernel wanted a huge page and could not find contiguous memory — the
   * direct fingerprint of the fragmentation hypothesis above. Read `0` on a
   * slow day and fragmentation is exonerated.
   */
  thpFaultFallback?: number;
  /** Compaction stalls / failures — corroborating fragmentation pressure. */
  compactStall?: number;
  compactFail?: number;
}

/** Parse `/proc/uptime`; first field is seconds since boot. */
export function parseProcUptime(text: string): number | undefined {
  const first = Number.parseFloat(text.trim().split(/\s+/)[0] ?? '');
  return Number.isFinite(first) ? Math.round(first) : undefined;
}

/** Pull a `key: value kB` line out of `/proc/meminfo`, returning MB. */
export function parseMeminfoMb(text: string, key: string): number | undefined {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  if (!m) return undefined;
  const kb = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
}

/** Pull a `key value` counter out of `/proc/vmstat`. */
export function parseVmstatCounter(text: string, key: string): number | undefined {
  const m = new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(text);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

export function buildHostStateSnapshot(sources: {
  uptime?: string;
  meminfo?: string;
  vmstat?: string;
}): HostStateSnapshot {
  const snapshot: HostStateSnapshot = {};
  const uptimeSeconds = sources.uptime ? parseProcUptime(sources.uptime) : undefined;
  if (uptimeSeconds !== undefined) snapshot.uptimeSeconds = uptimeSeconds;
  if (sources.meminfo) {
    const avail = parseMeminfoMb(sources.meminfo, 'MemAvailable');
    const total = parseMeminfoMb(sources.meminfo, 'MemTotal');
    if (avail !== undefined) snapshot.memAvailableMb = avail;
    if (total !== undefined) snapshot.memTotalMb = total;
  }
  if (sources.vmstat) {
    const fallback = parseVmstatCounter(sources.vmstat, 'thp_fault_fallback');
    const stall = parseVmstatCounter(sources.vmstat, 'compact_stall');
    const fail = parseVmstatCounter(sources.vmstat, 'compact_fail');
    if (fallback !== undefined) snapshot.thpFaultFallback = fallback;
    if (stall !== undefined) snapshot.compactStall = stall;
    if (fail !== undefined) snapshot.compactFail = fail;
  }
  return snapshot;
}

/**
 * Read the snapshot from /proc. Returns an empty object on non-Linux hosts or
 * when /proc is unreadable — this is diagnostic garnish on an admission
 * probe, so it must never be able to fail a preflight.
 */
export async function readHostStateSnapshot(): Promise<HostStateSnapshot> {
  if (process.platform !== 'linux') return {};
  const { readFile } = await import('node:fs/promises');
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const [uptime, meminfo, vmstat] = await Promise.all([
    read('/proc/uptime'),
    read('/proc/meminfo'),
    read('/proc/vmstat'),
  ]);
  return buildHostStateSnapshot({
    ...(uptime ? { uptime } : {}),
    ...(meminfo ? { meminfo } : {}),
    ...(vmstat ? { vmstat } : {}),
  });
}

/** One-line summary for the preflight CLI + logs. */
export function formatHostState(state: HostStateSnapshot): string {
  if (state.uptimeSeconds === undefined) return 'unavailable';
  const days = state.uptimeSeconds / 86400;
  const uptimeText =
    days >= 1 ? `${days.toFixed(1)}d` : `${(state.uptimeSeconds / 3600).toFixed(1)}h`;
  const parts = [`uptime ${uptimeText}`];
  if (state.memAvailableMb !== undefined && state.memTotalMb !== undefined) {
    parts.push(
      `mem ${Math.round(state.memAvailableMb / 1024)}/${Math.round(state.memTotalMb / 1024)} GB avail`,
    );
  }
  if (state.thpFaultFallback !== undefined) parts.push(`thpFallback ${state.thpFaultFallback}`);
  if (state.compactStall !== undefined) parts.push(`compactStall ${state.compactStall}`);
  return parts.join(' · ');
}
