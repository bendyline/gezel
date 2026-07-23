import { describe, expect, it } from 'vitest';

import {
  checkSeedFixtureIntegrity,
  describeSeedFixtureIntegrityFailure,
} from './fixture-integrity.ts';

const EXPECTED = [
  { path: 'evidence/a.txt', content: 'alpha\n' },
  { path: 'evidence/b.txt', content: 'beta\n' },
] as const;

describe('seed fixture integrity', () => {
  it('accepts exact fixture contents and ignores unrelated deliverables', () => {
    const persisted = new Map<string, string>([
      ['evidence/a.txt', 'alpha\n'],
      ['evidence/b.txt', 'beta\n'],
      ['report.md', '# Deliverable'],
    ]);

    expect(checkSeedFixtureIntegrity(EXPECTED, persisted)).toEqual({
      ok: true,
      missingPaths: [],
      modifiedPaths: [],
    });
  });

  it('reports missing and modified fixtures in expected-fixture order', () => {
    const persisted = new Map<string, string>([['evidence/b.txt', 'tampered\n']]);
    const result = checkSeedFixtureIntegrity(EXPECTED, persisted);

    expect(result).toEqual({
      ok: false,
      missingPaths: ['evidence/a.txt'],
      modifiedPaths: ['evidence/b.txt'],
    });
    expect(describeSeedFixtureIntegrityFailure(result)).toBe(
      'missing seeded source(s): evidence/a.txt; modified seeded source(s): evidence/b.txt',
    );
  });

  it('treats whitespace-only edits as source tampering', () => {
    const persisted = new Map<string, string>([
      ['evidence/a.txt', 'alpha'],
      ['evidence/b.txt', 'beta\n'],
    ]);

    expect(checkSeedFixtureIntegrity(EXPECTED, persisted).modifiedPaths).toEqual([
      'evidence/a.txt',
    ]);
  });
});
