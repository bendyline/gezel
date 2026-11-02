import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';

/**
 * Memory and CPU as this process may actually use them. `os.totalmem()` and
 * `os.availableParallelism()` describe the host; inside a container started
 * with `--memory 8g --cpus 4` on a 64 GB, 16-core machine they still say 64
 * and 16, so a model sized from them gets the container killed by its own
 * cgroup. Every sizing decision reads these instead.
 */

export interface HostLimitsProbe {
  totalmem: () => number;
  freemem: () => number;
  constrainedMemory: () => number | undefined;
  availableMemory: () => number | undefined;
  availableParallelism: () => number;
  /** Every logical CPU the host has, whatever this process may use. */
  hostCpuCount: () => number;
  readFile: (path: string) => string | undefined;
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

const nodeProbe: HostLimitsProbe = {
  totalmem,
  freemem,
  constrainedMemory: () =>
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined,
  availableMemory: () =>
    typeof process.availableMemory === 'function' ? process.availableMemory() : undefined,
  availableParallelism,
  hostCpuCount: () => cpus().length,
  readFile: (path) => (process.platform === 'linux' ? readTrimmed(path) : undefined),
};

/**
 * The cgroup memory limit when it is below the host's RAM, else null.
 * Node reads cgroup v1 and v2; "no limit" comes back as 0 or as a value at
 * or above physical RAM, depending on the libuv release.
 */
export function containerMemoryLimitBytes(probe: HostLimitsProbe = nodeProbe): number | null {
  const host = probe.totalmem();
  const limit = probe.constrainedMemory();
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit < host) {
    return limit;
  }
  return null;
}

/** RAM this process may use: host RAM, or the container's limit when lower. */
export function totalMemoryBytes(probe: HostLimitsProbe = nodeProbe): number {
  return containerMemoryLimitBytes(probe) ?? probe.totalmem();
}

/** Free RAM, never more than the container's limit leaves. */
export function freeMemoryBytes(probe: HostLimitsProbe = nodeProbe): number {
  return capToContainer(probe.freemem(), probe);
}

/**
 * Caps a host-wide free-memory reading (`MemAvailable`, `vm_stat`) to what
 * the container still has. Unchanged outside a container.
 */
export function capToContainer(hostFreeBytes: number, probe: HostLimitsProbe = nodeProbe): number {
  if (containerMemoryLimitBytes(probe) === null) return hostFreeBytes;
  const available = probe.availableMemory();
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) {
    return hostFreeBytes;
  }
  return Math.min(hostFreeBytes, available);
}

/**
 * CPUs this process may keep busy: the scheduler's CPU set, further capped
 * by a cgroup v2 `cpu.max` quota (or v1 `cfs_quota_us`) rounded up.
 */
export function availableCpuCount(probe: HostLimitsProbe = nodeProbe): number {
  const cpus = Math.max(1, probe.availableParallelism());
  const quota = cgroupCpuQuota(probe);
  return quota === null ? cpus : Math.max(1, Math.min(cpus, Math.ceil(quota)));
}

export function cgroupCpuQuota(probe: HostLimitsProbe = nodeProbe): number | null {
  const v2 = probe.readFile('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [max, period] = v2.split(/\s+/);
    const quota = Number(max);
    const per = Number(period);
    if (max !== 'max' && quota > 0 && per > 0) return quota / per;
    return null;
  }
  const v1Quota = Number(probe.readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const v1Period = Number(probe.readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (v1Quota > 0 && v1Period > 0) return v1Quota / v1Period;
  return null;
}

/**
 * The CPUs a container (a `--cpus` quota or a `--cpuset-cpus` set) leaves this
 * process when that is fewer than the host has, else null. Engines that size
 * their own thread pool from the host's cores, as llama.cpp does, oversubscribe
 * such a limit badly: 32 threads under a 4-CPU quota spend most of each period
 * throttled. Measured in a 4-CPU container: a 0.8B model decoded at 3.7 t/s.
 */
export function containerCpuLimit(probe: HostLimitsProbe = nodeProbe): number | null {
  const allowed = availableCpuCount(probe);
  return allowed < probe.hostCpuCount() ? allowed : null;
}
