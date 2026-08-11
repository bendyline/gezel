/**
 * App-version compatibility checks for catalog content.
 *
 * Gilde items may declare `minGezelVersion` — the oldest gezel build that can
 * meaningfully use them (e.g. a model needing a newer bundled engine). Gezel
 * versions are date-based (`1.YYDDD.RUN`, see scripts/stamp-version.mjs), so
 * floors are authored as `1.YYDDD` — major.minor only, because the run number
 * is unknowable ahead of a release. Comparison is numeric per component with
 * missing components treated as 0, which makes a two-component floor behave
 * exactly like "any build of that day or later".
 */

/**
 * Numeric component-wise comparison of dotted version strings. Missing
 * components count as 0. Returns NaN when either side has a non-numeric
 * component — callers decide how to treat malformed input.
 */
export function compareGezelVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] === undefined || pa[i] === '' ? 0 : Number(pa[i]);
    const nb = pb[i] === undefined || pb[i] === '' ? 0 : Number(pb[i]);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return Number.NaN;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * True when `current` satisfies a `minGezelVersion` floor.
 *
 * - No floor → satisfied.
 * - `current === '0.0.0'` (unstamped dev checkout — dev daemons, evals,
 *   tests) → satisfied; dev builds never filter content.
 * - `GEZEL_IGNORE_MIN_GEZEL_VERSION=1` → satisfied (debug escape hatch for
 *   stamped builds).
 * - A malformed floor → satisfied. Malformed content must never make items
 *   vanish from the catalog (same swallow-errors stance as the loader's
 *   semver `safeCompare`).
 */
export function satisfiesMinGezelVersion(floor: string | undefined, current: string): boolean {
  if (!floor) return true;
  if (current === '0.0.0') return true;
  if (typeof process !== 'undefined' && process.env?.GEZEL_IGNORE_MIN_GEZEL_VERSION === '1') {
    return true;
  }
  const cmp = compareGezelVersions(current, floor);
  if (Number.isNaN(cmp)) return true;
  return cmp >= 0;
}

/**
 * The stricter (higher) of two optional floors — used when composing an
 * identity-level floor with a version-level one into the resolved manifest.
 * Malformed floors lose to well-formed ones; two malformed floors return the
 * first.
 */
export function maxMinGezelVersion(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const cmp = compareGezelVersions(a, b);
  if (Number.isNaN(cmp)) {
    const aValid = !Number.isNaN(compareGezelVersions(a, '0'));
    return aValid ? a : b;
  }
  return cmp >= 0 ? a : b;
}
