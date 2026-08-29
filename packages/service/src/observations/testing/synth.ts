/**
 * Deterministic synthetic web-traffic rows.
 *
 * The observation pipeline's correctness claims are all about *volume* —
 * partitioning, sealing, compaction row-count verification, aggregate
 * accuracy — and none of them can be demonstrated with a hand-written
 * fixture of six rows. This generator produces as many realistic rows as a
 * test asks for, from a seed, so the same call always yields the same corpus
 * and a failure is reproducible from the seed alone.
 *
 * Seeded rather than random on purpose: `Math.random` in a test suite buys
 * nothing and costs the ability to reproduce a failure. Everything here is a
 * pure function of `(seed, index)`.
 */

/** One synthetic request. Mirrors the shape of a CDN / Front Door access log. */
export interface SynthRequestRow extends Record<string, unknown> {
  ts: string;
  route: string;
  status: number;
  latency_ms: number;
  bytes: number;
  client_country: string;
  ua_family: string;
}

export interface SynthOptions {
  rows: number;
  seed?: number;
  /** First day of the generated span, `YYYY-MM-DD`. */
  startDate?: string;
  /** Days the rows are spread across; drives how many partitions appear. */
  days?: number;
}

const ROUTES = [
  '/api/v1/orders',
  '/api/v1/customers',
  '/api/v1/search',
  '/health',
  '/assets/app.js',
  '/assets/app.css',
];
const COUNTRIES = ['NL', 'US', 'DE', 'GB', 'JP', 'BR'];
const UA_FAMILIES = ['Chrome', 'Safari', 'Firefox', 'Edge', 'curl'];
const STATUSES = [200, 200, 200, 200, 201, 304, 404, 500];

/** mulberry32 — small, fast, and adequate for fixture data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], r: number): T {
  return items[Math.min(items.length - 1, Math.floor(r * items.length))] as T;
}

/**
 * Generate `rows` requests spread evenly across `days` starting at
 * `startDate`. Latency is route-dependent and long-tailed, so p95 is a
 * meaningfully different number from the mean — otherwise a percentile test
 * would pass against a mean by accident.
 */
export function synthRequests(opts: SynthOptions): SynthRequestRow[] {
  const { rows, seed = 1, startDate = '2026-08-01', days = 3 } = opts;
  const random = rng(seed);
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const out: SynthRequestRow[] = [];

  for (let i = 0; i < rows; i++) {
    const dayIndex = i % days;
    const route = pick(ROUTES, random());
    // Static assets are fast; search is slow. A fixed per-route base plus a
    // heavy tail gives percentiles something real to find.
    const base = route.startsWith('/assets') ? 4 : route === '/api/v1/search' ? 120 : 30;
    const tail = random() < 0.05 ? 400 + random() * 1600 : random() * 40;
    const latency = Math.round((base + tail) * 100) / 100;

    const msIntoDay = Math.floor(random() * 86_400_000);
    out.push({
      ts: new Date(startMs + dayIndex * 86_400_000 + msIntoDay).toISOString(),
      route,
      status: pick(STATUSES, random()),
      latency_ms: latency,
      bytes: Math.floor(200 + random() * 50_000),
      client_country: pick(COUNTRIES, random()),
      ua_family: pick(UA_FAMILIES, random()),
    });
  }
  return out;
}

/** The authored manifest a `synthRequests` corpus would ship with. */
export function synthRequestsManifest(table = 'requests') {
  return {
    schemaVersion: 1 as const,
    table,
    title: 'Synthetic request log',
    grain: 'one row per HTTP request',
    timeColumn: 'ts',
    partitionColumn: 'dt',
    columns: [
      { name: 'ts', type: 'TIMESTAMP' as const, role: 'time' as const },
      { name: 'dt', type: 'VARCHAR' as const, role: 'dimension' as const },
      { name: 'route', type: 'VARCHAR' as const, role: 'dimension' as const },
      { name: 'status', type: 'BIGINT' as const, role: 'dimension' as const },
      {
        name: 'latency_ms',
        type: 'DOUBLE' as const,
        role: 'measure' as const,
        unit: 'milliseconds',
      },
      { name: 'bytes', type: 'BIGINT' as const, role: 'measure' as const, unit: 'bytes' },
      { name: 'client_country', type: 'VARCHAR' as const, role: 'dimension' as const },
      { name: 'ua_family', type: 'VARCHAR' as const, role: 'dimension' as const },
    ],
    measures: [],
    exemplars: [],
    rollups: [],
  };
}

/** Ground truth computed in JS, for comparison against the engine's answer. */
export function expectedRouteStats(
  rows: readonly SynthRequestRow[],
): Map<string, { requests: number; totalLatency: number }> {
  const byRoute = new Map<string, { requests: number; totalLatency: number }>();
  for (const row of rows) {
    const entry = byRoute.get(row.route) ?? { requests: 0, totalLatency: 0 };
    entry.requests += 1;
    entry.totalLatency += row.latency_ms;
    byRoute.set(row.route, entry);
  }
  return byRoute;
}
