export interface SeedFixture {
  path: string;
  content: string;
}

export type PersistedFixtureContents = ReadonlyMap<string, string | null | undefined>;

export interface SeedFixtureIntegrityResult {
  ok: boolean;
  missingPaths: string[];
  modifiedPaths: string[];
}

/**
 * Compare persisted seeded inputs with their scenario-owned source of truth.
 * Exact content equality is intentional: these files are model inputs, so a
 * whitespace-only edit is still source tampering and must invalidate a run.
 * Extra workspace files are ignored because deliverables live beside fixtures
 * in several scenarios.
 */
export function checkSeedFixtureIntegrity(
  expected: readonly SeedFixture[],
  persisted: PersistedFixtureContents,
): SeedFixtureIntegrityResult {
  const missingPaths: string[] = [];
  const modifiedPaths: string[] = [];

  for (const fixture of expected) {
    const actual = persisted.get(fixture.path);
    if (actual === null || actual === undefined) {
      missingPaths.push(fixture.path);
    } else if (actual !== fixture.content) {
      modifiedPaths.push(fixture.path);
    }
  }

  return {
    ok: missingPaths.length === 0 && modifiedPaths.length === 0,
    missingPaths,
    modifiedPaths,
  };
}

export function describeSeedFixtureIntegrityFailure(result: SeedFixtureIntegrityResult): string {
  const failures: string[] = [];
  if (result.missingPaths.length > 0) {
    failures.push(`missing seeded source(s): ${result.missingPaths.join(', ')}`);
  }
  if (result.modifiedPaths.length > 0) {
    failures.push(`modified seeded source(s): ${result.modifiedPaths.join(', ')}`);
  }
  return failures.join('; ');
}
