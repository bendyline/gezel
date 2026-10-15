/**
 * The HTTP contract generation this build speaks, and the oldest one it still
 * serves. Reported on `/api/health` as `apiCompat`.
 *
 * This is NOT a version. `GEZEL_VERSION` moves on every release and says
 * nothing about whether two builds can talk; the only comparison anyone made
 * with it was string equality, which reads every ordinary release as a
 * mismatch. A client built separately from the daemon it finds — a store
 * build, the npm CLI, an app on the app SDK — cannot assume the two shipped
 * together, so it needs an answer that stays stable across the releases where
 * nothing about the contract changed.
 *
 * Bump `GEZEL_API_GENERATION` only for a breaking, client-visible change to
 * the schemas in `schemas/` as served over HTTP. Raise
 * `GEZEL_API_GENERATION_FLOOR` to the same number only when dropping support
 * for the older shape — keeping the floor behind the current generation is
 * what lets one daemon serve clients from several releases.
 */
export const GEZEL_API_GENERATION = 1;
export const GEZEL_API_GENERATION_FLOOR = 1;

/**
 * The parts of a `/api/health` body that decide compatibility. Structural, so
 * a typed `HealthResponse` and a loosely read body are both accepted.
 */
export interface ApiCompatEvidence {
  version?: string | undefined;
  serviceRole?: string | undefined;
  apiCompat?: { floor: number; current: number } | undefined;
}

export type ApiIncompatibilityCode =
  /** Not a product endpoint — the cross-account engine broker. */
  | 'machine-engine-role'
  /** Predates the handshake, so older than any generation a client can speak. */
  | 'no-handshake'
  /** Its newest generation is below ours: the service needs updating. */
  | 'service-too-old'
  /** It no longer serves our generation: the client needs updating. */
  | 'client-too-old';

/**
 * Deliberately two outcomes and no 'degraded' tier. A client that adopted a
 * daemon it half-understood would surface as scattered feature-level breakage
 * nobody can act on; declining it and saying why is always actionable.
 */
export type ApiCompatVerdict =
  | { compatible: true }
  | { compatible: false; code: ApiIncompatibilityCode; reason: string };

export interface EvaluateApiCompatOptions {
  /** Defaults to this build's own generation. */
  clientGeneration?: number;
  /** How the reason names the caller: "this app", "this gezel CLI". */
  client?: string;
}

/**
 * Judge whether a client may use the daemon that sent `evidence`.
 *
 * Different versions are the normal case, not the failure: the desktop app,
 * the store builds, the npm packages and apps on the SDK all ship on their own
 * schedules. What decides is only whether the generation ranges overlap. A
 * daemon that publishes no range at all predates the field, which puts it
 * below any floor this build could negotiate with — absence is a verdict.
 */
export function evaluateApiCompat(
  evidence: ApiCompatEvidence,
  options: EvaluateApiCompatOptions = {},
): ApiCompatVerdict {
  const clientGeneration = options.clientGeneration ?? GEZEL_API_GENERATION;
  const client = options.client ?? 'this app';
  const service = `the Gezel service${evidence.version ? ` (${evidence.version})` : ''}`;

  // The machine-engine broker serves inference to every local account and has
  // no product API behind it. Adopting it would look like a healthy connection
  // and then fail on the first gezel read.
  if (evidence.serviceRole === 'machine-engine') {
    return {
      compatible: false,
      code: 'machine-engine-role',
      reason: 'that service is the shared inference engine, not a full Gezel service',
    };
  }

  if (!evidence.apiCompat) {
    return {
      compatible: false,
      code: 'no-handshake',
      reason: `${service} is older than ${client} can connect to`,
    };
  }

  const { floor, current } = evidence.apiCompat;
  const range = floor === current ? `${floor}` : `${floor}-${current}`;
  if (clientGeneration > current) {
    return {
      compatible: false,
      code: 'service-too-old',
      reason: `${client} speaks Gezel API generation ${clientGeneration}; ${service} serves ${range} and needs updating`,
    };
  }
  if (clientGeneration < floor) {
    return {
      compatible: false,
      code: 'client-too-old',
      reason: `${client} speaks Gezel API generation ${clientGeneration}; ${service} serves ${range}, so ${client} needs updating`,
    };
  }
  return { compatible: true };
}

/**
 * Read compatibility evidence from an untrusted health body. Anything
 * malformed reads as absent, which {@link evaluateApiCompat} declines.
 */
export function readApiCompatEvidence(body: unknown): ApiCompatEvidence {
  if (!body || typeof body !== 'object') return {};
  const raw = body as Record<string, unknown>;
  const evidence: ApiCompatEvidence = {};
  if (typeof raw.version === 'string') evidence.version = raw.version;
  if (typeof raw.serviceRole === 'string') evidence.serviceRole = raw.serviceRole;
  const compat = raw.apiCompat as Record<string, unknown> | undefined;
  if (
    compat &&
    typeof compat === 'object' &&
    Number.isInteger(compat.floor) &&
    Number.isInteger(compat.current)
  ) {
    evidence.apiCompat = { floor: compat.floor as number, current: compat.current as number };
  }
  return evidence;
}
