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
}

export type TenantKind = 'chat' | 'generation';

/** Shared wire-side default; remote clients mirror this for local queuing. */
export const DEFAULT_TENANT_MAX_CONCURRENT = 4;

export interface TenantLimiter {
  /**
   * Try to admit one request for `deviceId`. Returns a release function on
   * success, or `null` when the device is at its cap (caller returns 429).
   */
  tryAcquire(deviceId: string, kind: TenantKind): (() => void) | null;
  /** Current in-flight count for a device (diagnostics / tests). */
  inFlight(deviceId: string): number;
}

export function createTenantLimiter(config?: TenantLimitsConfig): TenantLimiter {
  const maxTotal = Math.max(1, config?.maxConcurrentPerDevice ?? DEFAULT_TENANT_MAX_CONCURRENT);
  const maxChat = Math.max(1, config?.maxChatPerDevice ?? maxTotal);
  const total = new Map<string, number>();
  const chat = new Map<string, number>();

  return {
    tryAcquire(deviceId, kind) {
      const t = total.get(deviceId) ?? 0;
      if (t >= maxTotal) return null;
      if (kind === 'chat' && (chat.get(deviceId) ?? 0) >= maxChat) return null;

      total.set(deviceId, t + 1);
      if (kind === 'chat') chat.set(deviceId, (chat.get(deviceId) ?? 0) + 1);

      let released = false;
      return () => {
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
    },
    inFlight(deviceId) {
      return total.get(deviceId) ?? 0;
    },
  };
}
