import { describe, expect, it } from 'vitest';
import { parseNpmAuditJson, parseOsvJson } from './external-tools.js';

/**
 * The null-vs-empty contract: null means "no measurement happened", [] means
 * "measured and clean". The presentation layer renders these differently, so
 * a tool failure must never come back as an empty (clean-looking) result.
 */

describe('parseNpmAuditJson', () => {
  it('returns null when the tool produced nothing', () => {
    expect(parseNpmAuditJson(null)).toBeNull();
    expect(parseNpmAuditJson(undefined)).toBeNull();
    expect(parseNpmAuditJson('not-an-object')).toBeNull();
  });

  it('returns null for npm audit error JSON (ENOLOCK prints parseable JSON)', () => {
    expect(
      parseNpmAuditJson({
        error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' },
      }),
    ).toBeNull();
  });

  it('returns [] for a measured-clean audit', () => {
    expect(parseNpmAuditJson({ vulnerabilities: {} })).toEqual([]);
  });

  it('maps advisories with severity and ids', () => {
    const out = parseNpmAuditJson({
      vulnerabilities: {
        lodash: {
          severity: 'high',
          via: [{ source: 1523, title: 'Prototype pollution' }, 'chain'],
        },
      },
    });
    expect(out).toEqual([
      { name: 'lodash', ecosystem: 'npm', advisoryIds: ['npm-1523'], maxSeverity: 'high' },
    ]);
  });
});

describe('parseOsvJson', () => {
  it('returns null when the tool produced nothing usable', () => {
    expect(parseOsvJson(null)).toBeNull();
    expect(parseOsvJson({})).toBeNull();
    expect(parseOsvJson({ error: 'boom' })).toBeNull();
  });

  it('returns [] for a measured-clean scan', () => {
    expect(parseOsvJson({ results: [] })).toEqual([]);
  });

  it('aggregates advisories per package with max severity', () => {
    const out = parseOsvJson({
      results: [
        {
          packages: [
            {
              package: { name: 'lodash', ecosystem: 'npm' },
              vulnerabilities: [
                { id: 'GHSA-1', database_specific: { severity: 'MODERATE' } },
                { id: 'GHSA-2', database_specific: { severity: 'CRITICAL' } },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toEqual([
      {
        name: 'lodash',
        ecosystem: 'npm',
        advisoryIds: ['GHSA-1', 'GHSA-2'],
        maxSeverity: 'critical',
      },
    ]);
  });
});
