import { describe, expect, it } from 'vitest';
import { securityReport } from './security-report.js';
import type { WorkspaceLike } from './types.js';

function ws(files: Record<string, string>): WorkspaceLike {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

const GOOD_REPORT = `# Security Review

## Verdict
Merge after fixes — 1 high, 2 medium findings open.

## Systemic Themes
### Inconsistent input validation across routes
Root cause: each route re-implements validation ad hoc. Blast radius: all 5 API routes.

### Ad-hoc secret loading
Root cause: no central config. Blast radius: several modules read process.env directly.

## Findings
See findings.json.

## Verified Safe
CSRF tokens are enforced on all mutating routes.

## Not Statically Verifiable
Runtime authz on the admin panel needs a pentest.
`;

const GOOD_FINDINGS = JSON.stringify([
  {
    file: 'src/routes/users.ts',
    line: 42,
    severity: 'high',
    category: 'injection',
    title: 'SQL injection in user lookup',
    remediation: 'Use a parameterized query.',
  },
  {
    file: 'src/routes/orders.ts',
    line: 10,
    severity: 'medium',
    category: 'injection',
    title: 'String-built query',
    remediation: 'Parameterize.',
  },
  {
    file: 'src/config.ts',
    line: 3,
    severity: 'medium',
    category: 'secret',
    title: 'Ad-hoc env read',
    remediation: 'Load via central config.',
  },
]);

const REAL_FILES = {
  'src/routes/users.ts': 'x',
  'src/routes/orders.ts': 'x',
  'src/config.ts': 'x',
};

function withReport(findings: string, report = GOOD_REPORT) {
  return ws({
    ...REAL_FILES,
    'security-review/REPORT.md': report,
    'security-review/findings.json': findings,
  });
}

describe('securityReport gate', () => {
  const opts = { findings: 'security-review/findings.json' };

  it('approves a well-formed report citing real files', async () => {
    const r = await securityReport(withReport(GOOD_FINDINGS), 'security-review/REPORT.md', opts);
    expect(r.ok).toBe(true);
    expect(r.findingCount).toBe(3);
  });

  it('falls back to a per-path read when the listing misses a real file', async () => {
    const files: Record<string, string> = {
      ...REAL_FILES,
      'security-review/REPORT.md': GOOD_REPORT,
      'security-review/findings.json': GOOD_FINDINGS,
    };
    const truncated: WorkspaceLike = {
      read: async (f) => files[f] ?? null,
      list: async () => ['security-review/REPORT.md', 'security-review/findings.json'],
    };
    const r = await securityReport(truncated, 'security-review/REPORT.md', opts);
    expect(r.ok).toBe(true);
    expect(r.findingCount).toBe(3);
  });

  it('rejects and names a fabricated file citation', async () => {
    const findings = JSON.stringify([
      {
        file: 'src/does-not-exist.ts',
        line: 1,
        severity: 'high',
        title: 'x',
        remediation: 'fix',
      },
    ]);
    const r = await securityReport(withReport(findings), 'security-review/REPORT.md', opts);
    expect(r.ok).toBe(false);
    expect(r.fabricated).toContain('src/does-not-exist.ts');
    expect(r.detail).toMatch(/do not exist|does not exist|don't exist/i);
  });

  it('rejects a finding with no remediation', async () => {
    const findings = JSON.stringify([
      { file: 'src/config.ts', line: 3, severity: 'medium', title: 'x' },
    ]);
    const r = await securityReport(withReport(findings), 'security-review/REPORT.md', opts);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/remediation/i);
  });

  it('rejects a report missing a required section', async () => {
    const report = GOOD_REPORT.replace('## Verified Safe', '## Nope');
    const r = await securityReport(
      withReport(GOOD_FINDINGS, report),
      'security-review/REPORT.md',
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Verified Safe/);
  });

  it('rejects "safe to merge" when a high finding is open', async () => {
    const report = GOOD_REPORT.replace(
      'Merge after fixes — 1 high, 2 medium findings open.',
      'Safe to merge — looks secure.',
    );
    const r = await securityReport(
      withReport(GOOD_FINDINGS, report),
      'security-review/REPORT.md',
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/verdict/i);
  });

  it('requires systemic themes once there is enough material', async () => {
    const report = GOOD_REPORT.replace(
      /## Systemic Themes[\s\S]*?## Findings/,
      '## Systemic Themes\nNothing notable.\n\n## Findings',
    );
    const r = await securityReport(
      withReport(GOOD_FINDINGS, report),
      'security-review/REPORT.md',
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Systemic Themes/);
  });

  it('fails clearly when findings.json is missing', async () => {
    const w = ws({ ...REAL_FILES, 'security-review/REPORT.md': GOOD_REPORT });
    const r = await securityReport(w, 'security-review/REPORT.md', opts);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/findings\.json not found/);
  });
});
