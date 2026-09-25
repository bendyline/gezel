export interface MobileBuildIdentity {
  harnessSourceSha256: string;
  productIndexSha256: string;
}

/** Verify native evidence before any result is credited to the current build. */
export function requireMobileBuildIdentity(
  actual: Record<string, unknown>,
  expected: MobileBuildIdentity,
): void {
  for (const [key, label] of [
    ['harnessSourceSha256', 'test resource'],
    ['productIndexSha256', 'product assets'],
  ] as const) {
    if (actual[key] !== expected[key])
      throw new Error(
        `Native ${label} differ from this launch: expected ${expected[key]}, received ${String(actual[key])}. The retained report does not prove current build coverage.`,
      );
  }
}
