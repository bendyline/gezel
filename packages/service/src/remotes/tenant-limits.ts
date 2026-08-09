/**
 * Per-tenant admission control for the `/v1/remote/*` surface. B serves many
 * GPU-bound clients; this caps how much any single paired device can occupy so
 * one greedy tenant can't starve the others (or B's own local work). Sits in
 * FRONT of the GPU arbiter + provider queue — it bounds concurrent in-flight
 * requests per origin device; the queue still orders what gets in.
 *
 * In-memory only (per process); a restart resets counters, which is correct —
 * there are no in-flight requests across a restart.
 */

export interface TenantLimitsConfig {
  /** Max concurrent in-flight requests of ANY kind per device. Default 4. */
  maxConcurrentPerDevice?: number;
  /** Max concurrent CHAT requests per device. Default = maxConcurrentPerDevice. */
  maxChatPerDevice?: number;
  /**
   * Max admissions per device per sliding 60-second window, counting only
   * requests that were actually admitted. Unset = unlimited rate.
   */
  requestsPerMinute?: number;
}

export type TenantKind = 'chat' | 'generation';

/** Shared wire-side default; remote clients mirror this for local queuing. */
export const DEFAULT_TENANT_MAX_CONCURRENT = 4;

const RATE_WINDOW_MS = 60_000;

export type TenantAdmission =
  | { ok: true; release(): void }
  | { ok: false; reason: 'concurrency' | 'rate_limit'; retryAfterSec: number };

export interface TenantLimiter {
  /**
   * Try to admit one request for `deviceId`. On denial, `reason` selects the
   * wire error and `retryAfterSec` feeds the Retry-After header.
   */
  tryAcquire(deviceId: string, kind: TenantKind): TenantAdmission;
  /** Current in-flight count for a device (diagnostics / tests). */
  inFlight(deviceId: string): number;
  /**
   * Swap caps in place on a config change. In-flight counters and the rate
   * windows survive — releasing an already-admitted request must decrement
   * the same counters it incremented.
   */
  setLimits(config?: TenantLimitsConfig): void;
}

export function createTenantLimiter(
  config?: TenantLimitsConfig,
  opts?: { now?: () => number },
): TenantLimiter {
  const now = opts?.now ?? Date.now;
  let maxTotal = 0;
  let maxChat = 0;
  let ratePerMinute: number | undefined;
  const applyConfig = (next?: TenantLimitsConfig) => {
    maxTotal = Math.max(1, next?.maxConcurrentPerDevice ?? DEFAULT_TENANT_MAX_CONCURRENT);
    maxChat = Math.max(1, next?.maxChatPerDevice ?? maxTotal);
    ratePerMinute =
      next?.requestsPerMinute !== undefined ? Math.max(1, next.requestsPerMinute) : undefined;
  };
  applyConfig(config);

  const total = new Map<string, number>();
  const chat = new Map<string, number>();
  const admissions = new Map<string, number[]>();

  const pruneWindow = (deviceId: string, at: number): number[] => {
    const stamps = admissions.get(deviceId) ?? [];
    const live = stamps.filter((t) => t > at - RATE_WINDOW_MS);
    if (live.length === 0) admissions.delete(deviceId);
    else admissions.set(deviceId, live);
    return live;
  };

  return {
    tryAcquire(deviceId, kind) {
      const t = total.get(deviceId) ?? 0;
      if (t >= maxTotal || (kind === 'chat' && (chat.get(deviceId) ?? 0) >= maxChat)) {
        return { ok: false, reason: 'concurrency', retryAfterSec: 1 };
      }
      // Stamps are recorded even while no rate limit is configured (pruning
      // bounds them to one window) so a limit introduced via setLimits takes
      // effect against the traffic that just happened, not one window later.
      const at = now();
      const live = pruneWindow(deviceId, at);
      if (ratePerMinute !== undefined && live.length >= ratePerMinute) {
        const oldest = live[0] ?? at;
        const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - at) / 1000));
        return { ok: false, reason: 'rate_limit', retryAfterSec };
      }
      live.push(at);
      admissions.set(deviceId, live);

      total.set(deviceId, t + 1);
      if (kind === 'chat') chat.set(deviceId, (chat.get(deviceId) ?? 0) + 1);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const nt = (total.get(deviceId) ?? 1) - 1;
        if (nt <= 0) total.delete(deviceId);
        else total.set(deviceId, nt);
        if (kind === 'chat') {
          const nc = (chat.get(deviceId) ?? 1) - 1;
          if (nc <= 0) chat.delete(deviceId);
          else chat.set(deviceId, nc);
        }
      };
      return { ok: true, release };
    },
    inFlight(deviceId) {
      return total.get(deviceId) ?? 0;
    },
    setLimits(next) {
      applyConfig(next);
    },
  };
}
