import { GEZEL_API_GENERATION, type HealthResponse } from '@bendyline/gezel';

/**
 * Whether a store build may adopt the daemon a direct-download install is
 * already running, or must start its own beside it.
 *
 * The store lanes ship on the stores' schedule and the direct download ships
 * on ours, so the two versions on one machine are routinely different — that
 * is the normal case, not the failure. What matters is only whether they still
 * speak the same HTTP contract, which is what `apiCompat` answers and what
 * `version` cannot: an exact-version comparison would send every store user to
 * a private daemon the day either side shipped a patch.
 *
 * Deliberately two outcomes and no 'degraded' tier. A store build that adopted
 * a daemon it half-understood would surface as scattered feature-level
 * breakage the user cannot act on; running its own service is always correct,
 * just not shared. The result shape leaves room for a third verdict if a real
 * partial-compatibility case ever earns one.
 */
export type StoreCompatVerdict =
  | { compatible: true }
  | { compatible: false; code: StoreIncompatibilityCode; reason: string };

export type StoreIncompatibilityCode =
  /** Not a product endpoint — the cross-account engine broker. */
  | 'machine-engine-role'
  /** Predates the handshake, so older than any generation we could speak. */
  | 'no-handshake'
  /** Speaks a generation range that does not include ours. */
  | 'generation-mismatch';

/**
 * Judge a health response from a candidate daemon.
 *
 * `clientGeneration` defaults to this build's own; injectable so a test can
 * pin both sides of the comparison without rewriting a module constant.
 */
export function evaluateStoreCompat(
  health: HealthResponse,
  clientGeneration: number = GEZEL_API_GENERATION,
): StoreCompatVerdict {
  // The machine-engine broker serves inference to every local account and has
  // no product API behind it. Adopting it would look like a healthy connection
  // and then fail on the first gezel read.
  if (health.serviceRole === 'machine-engine') {
    return {
      compatible: false,
      code: 'machine-engine-role',
      reason: 'that service is the shared inference engine, not a full Gezel service',
    };
  }

  // Absence is a verdict, not silence — see the schema's note. A daemon that
  // does not publish a generation predates the field entirely, which puts it
  // below any floor this build knows how to negotiate with.
  if (!health.apiCompat) {
    return {
      compatible: false,
      code: 'no-handshake',
      reason: `the installed Gezel service (${health.version}) is older than this app can connect to`,
    };
  }

  const { floor, current } = health.apiCompat;
  // Both directions in one check. `floor` catches a service too new to still
  // serve us; `current` catches one too old to serve us yet.
  if (clientGeneration < floor || clientGeneration > current) {
    return {
      compatible: false,
      code: 'generation-mismatch',
      reason:
        `this app speaks Gezel API generation ${clientGeneration}; the installed service ` +
        `(${health.version}) serves ${floor === current ? `${floor}` : `${floor}-${current}`}`,
    };
  }

  return { compatible: true };
}
