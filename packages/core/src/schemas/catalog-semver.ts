// Loose semver: major.minor.patch with optional pre-release / build tags.
// Strict enough to reject `latest` or `v1` while still accepting common
// pre-release shapes (`1.0.0-rc.1`, `1.0.0+build.7`).
export const SemverRegex = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(v: string): boolean {
  return SemverRegex.test(v);
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (`rc.1` etc.); empty string means none. */
  pre: string;
}

function parseSemver(v: string): ParsedSemver | null {
  const m = SemverRegex.exec(v);
  if (!m) return null;
  // Strip build metadata (`+...`) — semver spec says it doesn't affect ordering.
  const noBuild = v.split('+', 1)[0] ?? v;
  const [versionCore, pre] = noBuild.split('-', 2) as [string, string | undefined];
  const [major, minor, patch] = versionCore.split('.').map((n) => Number.parseInt(n, 10));
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0, pre: pre ?? '' };
}

function compareIdentifier(a: string, b: string): number {
  // Numeric identifiers compare numerically; alphanumerics lexically;
  // numeric identifiers always sort below alphanumerics. (semver §11.4.3)
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Standard semver compare: returns < 0 if a < b, 0 if equal, > 0 if
 * a > b. Throws on non-semver input. Pre-release versions sort below
 * their associated normal version (1.0.0-rc.1 < 1.0.0).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`not semver: ${a}`);
  if (!pb) throw new Error(`not semver: ${b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  // A version without a pre-release outranks one with a pre-release.
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  const aIds = pa.pre.split('.');
  const bIds = pb.pre.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const ai = aIds[i];
    const bi = bIds[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const c = compareIdentifier(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Sort comparator: newest version first. Tolerates folder names that are
 * not strict semver by falling back to a plain string order, so a stray
 * folder never throws out of a directory listing. A string sort alone put
 * 1.9.0 above 1.10.0.
 */
export function newestVersionFirst(a: string, b: string): number {
  if (isSemver(a) && isSemver(b)) return compareSemver(b, a);
  return a < b ? 1 : a > b ? -1 : 0;
}

function bumpFor(op: '^' | '~', v: string): string {
  const [major = 0, minor = 0, patch = 0] = v
    .split('-', 1)[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  if (op === '~') return `${major}.${minor + 1}.0-0`;
  if (major > 0) return `${major + 1}.0.0-0`;
  if (minor > 0) return `0.${minor + 1}.0-0`;
  return `0.0.${patch + 1}-0`;
}

function satisfiesComparator(version: string, comparator: string): boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator);
  if (!m) throw new Error(`unsupported version range: ${comparator}`);
  const op = m[1] ?? '=';
  const bound = m[2]!;
  const c = compareSemver(version, bound);
  switch (op) {
    case '^':
    case '~':
      return c >= 0 && compareSemver(version, bumpFor(op, bound)) < 0;
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    default:
      return c === 0;
  }
}

/**
 * Whether `version` satisfies an npm-style range: `^`, `~`, comparisons,
 * exact versions, space-separated conjunctions and `||` alternatives. A
 * pre-release only satisfies a range that names one, as npm has it. Throws on
 * shapes it does not understand (x-ranges, hyphen ranges), so a caller
 * gating code on it fails closed.
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (!isSemver(version)) throw new Error(`not semver: ${version}`);
  const pre = version.includes('-');
  return range.split('||').some((alternative) => {
    const comparators = alternative
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    if (comparators.length === 0) throw new Error(`empty version range: ${range}`);
    if (pre && !comparators.some((c) => c.includes('-'))) return false;
    return comparators.every((c) => satisfiesComparator(version, c));
  });
}
