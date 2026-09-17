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
