/**
 * GpuArbiter — coordinates GPU/VRAM tenancy between the local LLM
 * (llama-cpp) and the local image generator (sd-cpp). Both engines
 * are GPU-resident when running, and on consumer cards (12 GB
 * VRAM-class) they don't fit in memory simultaneously. This class
 * decides whether they coexist or take turns.
 *
 * Policies:
 *   - `coexist` — `acquire()` is a no-op. Both engines stay loaded.
 *     Right when the user has plenty of memory (Mac unified memory
 *     ≥24 GB, or a discrete GPU ≥20 GB) so swap latency would be
 *     pure overhead.
 *   - `swap` — `acquire(slot)` evicts the *other* slot first. The
 *     evicted engine's lazy-restart kicks in on its next request,
 *     so callers see a small one-time latency on the turn after a
 *     swap, not on every turn.
 *
 * Engines register an evictor via {@link registerEvictor}; the
 * llama-cpp + sd-cpp providers each call this once at construction
 * with their supervisor's `stop()`. When no engine has registered
 * for a slot (e.g. cloud LLM + local image gen), `acquire()` for
 * that slot is a no-op — there's nothing to evict.
 *
 * Designed to be light: no internal state machine, no per-request
 * tracking. The supervisor's own state machine is the source of
 * truth for "is the engine running"; an unconditional `stop()`
 * call when the supervisor is already stopped is a tested no-op.
 */

import { totalmem } from 'node:os';
import { createLogger } from '@bendyline/gezel';
import type {
  DeviceHealthGate,
  DeviceHealthStatusSnapshot,
  DeviceSafetyPolicyInput,
} from '@bendyline/gezel/native';

const arbiterLog = createLogger('gpu-arbiter');

export type GpuSlot = 'llm' | 'image' | 'video';
export type GpuPolicy = 'coexist' | 'swap';
export type GpuPolicySetting = GpuPolicy | 'auto';
type DeviceHealthAdmissionGate = Pick<DeviceHealthGate, 'admit' | 'setPolicy' | 'status'>;

export interface GpuMemoryPressureStatus {
  pressured: boolean;
  freeBytes?: number;
  totalBytes?: number;
  detail?: string;
}

export interface GpuArbiterOptions {
  /**
   * Initial policy. Use {@link detectGpuPolicy} to derive an `auto`
   * default at boot, or pass `swap`/`coexist` directly when the user
   * has overridden the auto pick in Settings.
   */
  policy: GpuPolicy;
  /**
   * Where lifecycle messages go. Defaults to `console.log`. The
   * service wires this to its structured logger so swap events show
   * up in the daemon log.
   */
  log?: (msg: string) => void;
  /**
   * Optional cross-vendor admission gate. It is consulted for every GPU slot
   * regardless of the memory coexist/swap policy, so thermal safety does not
   * accidentally disappear on large-memory systems.
   */
  healthGate?: DeviceHealthAdmissionGate;
  /**
   * How long a single lease may be held before the arbiter treats it as
   * leaked and breaks it. Backstop only — see {@link STALE_LEASE_BREAK_MS}.
   */
  staleLeaseBreakMs?: number;
}

/**
 * Ceiling above which a held lease is assumed leaked rather than slow.
 *
 * Sized against the longest *legitimate* holder, not against typical use: the
 * video provider's own request timeout is 1 h, so anything at or below that
 * would break real renders mid-decode — precisely what the lease exists to
 * prevent. Every legitimate holder is bounded by its own operation timeout, so
 * a lease older than this one has no owner that will ever release it.
 *
 * This is a backstop, not the fix. A turn that throws now releases its lease in
 * a `finally` (see the llama-cpp provider's tool loop). Before that, a leaked
 * lease parked every later acquirer forever and the whole daemon stopped
 * serving until gezeld restarted; this bounds that outage instead of letting it
 * run indefinitely.
 */
const STALE_LEASE_BREAK_MS = 90 * 60_000;

/** How often a blocked acquirer re-reports that it is still waiting. */
const LEASE_WAIT_POLL_MS = 60_000;

export class GpuArbiter {
  private policy: GpuPolicy;
  /**
   * Evictors per slot, keyed by owner. A slot can have multiple
   * registered engines at once — the engine pool runs several
   * llama-server replicas (one per resident model), each registering
   * under its engine key — and an eviction of the slot must stop ALL
   * of them, not just the most recently registered.
   */
  private readonly evictors = new Map<GpuSlot, Map<string, () => Promise<void>>>();
  private readonly log: (msg: string) => void;
  private readonly healthGate?: DeviceHealthAdmissionGate;
  private activeLease: GpuSlot | null = null;
  private activeLeaseSince: number | null = null;
  private leaseWaiters: Array<() => void> = [];
  private readonly staleLeaseBreakMs: number;

  constructor(opts: GpuArbiterOptions) {
    this.policy = opts.policy;
    this.log = opts.log ?? ((msg) => arbiterLog.info(msg));
    if (opts.healthGate) this.healthGate = opts.healthGate;
    this.staleLeaseBreakMs = opts.staleLeaseBreakMs ?? STALE_LEASE_BREAK_MS;
  }

  /**
   * Drop a lease the holder can no longer release, so blocked acquirers make
   * progress. Returns true when a lease was actually broken.
   */
  private breakStaleLease(): boolean {
    if (this.activeLease === null || this.activeLeaseSince === null) return false;
    const heldMs = Date.now() - this.activeLeaseSince;
    if (heldMs < this.staleLeaseBreakMs) return false;
    arbiterLog.error(
      `[gpu-arbiter] breaking stale ${this.activeLease} lease held ${Math.round(heldMs / 1000)}s (ceiling ${Math.round(this.staleLeaseBreakMs / 1000)}s) — its holder never released it. This is a leak: every GPU acquirer was blocked behind it.`,
    );
    this.activeLease = null;
    this.activeLeaseSince = null;
    this.wakeLeaseWaiters();
    return true;
  }

  /**
   * Register the function the arbiter should call to evict an engine
   * from the GPU. Typically the supervisor's `stop()`. Re-registering
   * the same `(slot, ownerId)` replaces the previous evictor — useful
   * when a provider is rebuilt (e.g. user switched llama-cpp models
   * in Settings) and the old supervisor is gone. Distinct owners on
   * the same slot coexist (pool replicas); pass the engine key as
   * `ownerId` so each replica can be unregistered independently.
   */
  registerEvictor(slot: GpuSlot, evict: () => Promise<void>, ownerId = 'default'): void {
    let owners = this.evictors.get(slot);
    if (!owners) {
      owners = new Map();
      this.evictors.set(slot, owners);
    }
    owners.set(ownerId, evict);
  }

  /**
   * Forget an evictor. Called when a provider is shut down for good
   * (e.g. user switched from local to cloud, or the pool evicted a
   * replica). After this, `acquire()` for the *other* slot won't try
   * to evict here.
   */
  unregisterEvictor(slot: GpuSlot, ownerId = 'default'): void {
    const owners = this.evictors.get(slot);
    if (!owners) return;
    owners.delete(ownerId);
    if (owners.size === 0) this.evictors.delete(slot);
  }

  /**
   * Called by a provider just before it intends to use the GPU. In
   * `swap` mode, evicts every other registered slot first; in
   * `coexist` mode, returns immediately. Failures during eviction are
   * logged and swallowed — the requesting engine still gets to run,
   * which is the user-visible promise.
   */
  async acquire(slot: GpuSlot): Promise<void> {
    if (this.getPolicy() === 'swap') {
      await this.waitForForeignLease(slot);
      if (this.getPolicy() === 'swap') await this.evictOthers(slot);
    }
    await this.healthGate?.admit(`${slot} workload`);
  }

  /**
   * Acquire the GPU and keep an in-flight operation protected until the
   * returned release function is called. Long local image generations use
   * this so a chat nudge cannot evict sd-server halfway through VAE decode.
   */
  async acquireLease(slot: GpuSlot): Promise<() => void> {
    if (this.getPolicy() === 'coexist') {
      await this.healthGate?.admit(`${slot} workload`);
      return () => {};
    }
    while (this.getPolicy() === 'swap' && this.activeLease !== null) {
      if (this.breakStaleLease()) break;
      this.log(`[gpu-arbiter] ${slot} requested GPU — waiting for active ${this.activeLease} job`);
      await this.waitForLeaseRelease();
    }
    if (this.getPolicy() === 'coexist') return () => {};
    this.activeLease = slot;
    this.activeLeaseSince = Date.now();
    try {
      await this.evictOthers(slot);
      await this.healthGate?.admit(`${slot} workload`);
    } catch (error) {
      if (this.activeLease === slot) {
        this.activeLease = null;
        this.activeLeaseSince = null;
        this.wakeLeaseWaiters();
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.activeLease === slot) {
        this.activeLease = null;
        this.activeLeaseSince = null;
        this.wakeLeaseWaiters();
      }
    };
  }

  private async waitForForeignLease(slot: GpuSlot): Promise<void> {
    while (this.getPolicy() === 'swap' && this.activeLease !== null && this.activeLease !== slot) {
      if (this.breakStaleLease()) break;
      this.log(`[gpu-arbiter] ${slot} requested GPU — waiting for active ${this.activeLease} job`);
      await this.waitForLeaseRelease();
    }
  }

  /**
   * Resolves on the next release, or after {@link LEASE_WAIT_POLL_MS} so the
   * caller re-evaluates. The timed wake is what makes the stale-lease breaker
   * reachable: a leaked lease produces no release, so a wake-on-release-only
   * wait would never re-check and the caller would park forever.
   */
  private waitForLeaseRelease(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settleOnce = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settleOnce, Math.min(LEASE_WAIT_POLL_MS, this.staleLeaseBreakMs));
      // Never hold the process open on a lease wait.
      timer.unref?.();
      this.leaseWaiters.push(settleOnce);
    });
  }

  private wakeLeaseWaiters(): void {
    const waiters = this.leaseWaiters;
    this.leaseWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async evictOthers(slot: GpuSlot): Promise<void> {
    const others = [...this.evictors.entries()].filter(([s]) => s !== slot);
    if (others.length === 0) return;
    for (const [otherSlot, owners] of others) {
      for (const [ownerId, evict] of owners) {
        this.log(`[gpu-arbiter] ${slot} requested GPU — evicting ${otherSlot} (${ownerId})`);
        try {
          await evict();
        } catch (err) {
          // The other engine may already be stopped, in which case its
          // supervisor's `stop()` is a fast no-op. A real error
          // shouldn't block the requesting engine from proceeding —
          // worst case the OS handles the VRAM contention.
          this.log(
            `[gpu-arbiter] evict ${otherSlot} (${ownerId}) threw (continuing): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  getPolicy(): GpuPolicy {
    return this.policy;
  }

  /**
   * Hot-swap the policy. Used by the config PUT handler when the user
   * flips the toggle in Settings. Doesn't preemptively load or evict
   * anything — the new policy applies on the next `acquire()`.
   */
  setPolicy(policy: GpuPolicy): void {
    if (policy === this.policy) return;
    this.log(`[gpu-arbiter] policy ${this.policy} → ${policy}`);
    this.policy = policy;
    if (policy === 'coexist') this.wakeLeaseWaiters();
  }

  /** Hot-swap native device-safety thresholds for the next admission. */
  setDeviceSafetyPolicy(policy: DeviceSafetyPolicyInput): void {
    this.healthGate?.setPolicy(policy);
  }

  /** Latest normalized machine-health snapshot for the authenticated UI. */
  async getDeviceHealthStatus(maxAgeMs?: number): Promise<DeviceHealthStatusSnapshot | undefined> {
    return this.healthGate?.status(maxAgeMs);
  }

  /**
   * Low-free-VRAM signal for idle engine supervisors. This is deliberately a
   * release hint, not an admission denial: active inference always finishes,
   * then an idle model gets one minute to be reused before caches flush and
   * its process exits.
   */
  async getMemoryPressureStatus(maxAgeMs = 1_000): Promise<GpuMemoryPressureStatus> {
    const status = await this.healthGate?.status(maxAgeMs);
    const readings = (status?.readings ?? []).filter(
      (reading) =>
        typeof reading.memoryTotalMb === 'number' &&
        Number.isFinite(reading.memoryTotalMb) &&
        reading.memoryTotalMb > 0 &&
        typeof reading.memoryUsedMb === 'number' &&
        Number.isFinite(reading.memoryUsedMb) &&
        reading.memoryUsedMb >= 0,
    );
    if (readings.length === 0) return { pressured: false };
    const totalBytes =
      readings.reduce((sum, reading) => sum + (reading.memoryTotalMb ?? 0), 0) * 1024 ** 2;
    const usedBytes =
      readings.reduce((sum, reading) => sum + (reading.memoryUsedMb ?? 0), 0) * 1024 ** 2;
    const freeBytes = Math.max(0, totalBytes - usedBytes);
    const thresholdBytes = Math.max(1024 ** 3, totalBytes * 0.08);
    const pressured = freeBytes <= thresholdBytes;
    const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    return {
      pressured,
      freeBytes,
      totalBytes,
      ...(pressured ? { detail: `${gib(freeBytes)} GB free of ${gib(totalBytes)} GB VRAM` } : {}),
    };
  }
}

/**
 * Pick a sensible default GPU policy from platform + memory. Coexist
 * when we're confident both a 7B-class LLM and an SDXL-class image
 * model fit alongside the OS; swap otherwise. Conservative thresholds
 * — the cost of misclassifying coexist is OOM, while swap just adds
 * one cold-start every time the user crosses domains.
 *
 * Mac (Apple Silicon) uses unified memory, so total system RAM is
 * the right thing to compare against. ≥24 GB comfortably holds a
 * Q4 7B (~5 GB), an SDXL-class model (~7 GB), and the OS + app
 * working set with margin.
 *
 * Windows / Linux discrete GPUs are dominated by VRAM, not system
 * RAM. We don't probe `nvidia-smi` here — the cost of a synchronous
 * probe at startup isn't worth it for a heuristic, and the user can
 * flip to coexist explicitly via Settings if they have the headroom.
 */
export function detectGpuPolicy(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemBytes?: number;
}): GpuPolicy {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const totalMem = opts?.totalMemBytes ?? totalmem();
  const COEXIST_MAC_THRESHOLD = 24 * 1024 ** 3;
  if (platform === 'darwin' && arch === 'arm64' && totalMem >= COEXIST_MAC_THRESHOLD) {
    return 'coexist';
  }
  return 'swap';
}

/**
 * Resolve the user-facing setting (which may be `'auto'`) into a
 * concrete policy by consulting {@link detectGpuPolicy} for the
 * `'auto'` case. Centralized so the service entrypoint and the
 * config-change path agree on the same mapping.
 */
export function resolveGpuPolicy(setting: GpuPolicySetting | undefined): GpuPolicy {
  if (setting === 'coexist' || setting === 'swap') return setting;
  return detectGpuPolicy();
}
