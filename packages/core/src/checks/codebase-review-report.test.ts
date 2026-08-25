import { describe, expect, it } from 'vitest';
import { codebaseReviewReport } from './codebase-review-report.js';
import type { WorkspaceLike } from './types.js';

function ws(files: Record<string, string>): WorkspaceLike {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

const GOOD_REPORT = `# Comprehensive Codebase Review

## Executive summary
Solid foundations, but two systemic problems (one high finding) need attention before the next release.

## Scorecard
| Dimension | Grade | Notes |
|---|---|---|
| Architecture | B | Clear layering; one boundary leak |
| Code quality | C | Duplicated parsing logic |
| Hygiene | C | Debug prints and dead files |
| Security | B | One high finding |
| Tests | B | Core paths covered |

## Index coverage and method
Static index fresh; 41 of 44 eligible files AI-reviewed.

## Systemic themes
### Parsing logic is duplicated instead of shared
Root cause: no shared parsing module. Blast radius: 4 files re-implement it.

### Console debugging left in production paths
Root cause: no lint rule. Blast radius: impacts every request log.

## Findings
See findings JSON.

## Quick wins
Delete the dead files; remove console output.

## Strategic recommendations
Extract a shared parsing module.

## Verified sound
Error handling in the request pipeline.

## Not assessed
Runtime performance under load.

## Suggested deeper reviews
Run the Deep Security Review for the auth surface.
`;

const GOOD_FINDINGS = JSON.stringify([
  {
    file: 'src/parse.ts',
    line: 12,
    severity: 'high',
    dimension: 'security',
    title: 'Unvalidated input reaches eval-like sink',
    remediation: 'Validate and route through the shared parser.',
  },
  {
    file: 'src/util.ts',
    severity: 'medium',
    dimension: 'duplication',
    title: 'Parsing logic duplicated from src/parse.ts',
    remediation: 'Extract a shared module.',
  },
  {
    file: 'src/server.ts',
    line: 3,
    severity: 'low',
    dimension: 'hygiene',
    title: 'console.log left in request handler',
    remediation: 'Use the logger.',
  },
]);

const SOURCE_FILES = {
  'src/parse.ts': 'x',
  'src/util.ts': 'x',
  'src/server.ts': 'x',
};

const REPORT_PATH = 'tasks/7/codebase-review.md';
const FINDINGS_PATH = 'tasks/7/codebase-review-findings.json';

function drawer(findings: string, report = GOOD_REPORT) {
  return ws({ [REPORT_PATH]: report, [FINDINGS_PATH]: findings });
}

const OPTS = { findings: FINDINGS_PATH };

describe('codebaseReviewReport', () => {
  it('passes a complete report with real citations', async () => {
    const r = await codebaseReviewReport(
      drawer(GOOD_FINDINGS),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(true);
    expect(r.findingCount).toBe(3);
  });

  it('rejects when the report is missing', async () => {
    const r = await codebaseReviewReport(
      ws({ [FINDINGS_PATH]: GOOD_FINDINGS }),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not found');
  });

  it('rejects when the findings JSON is missing or invalid', async () => {
    const missing = await codebaseReviewReport(
      ws({ [REPORT_PATH]: GOOD_REPORT }),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('machine-readable');

    const invalid = await codebaseReviewReport(
      drawer('{not json'),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.detail).toContain('not valid JSON');
  });

  it('rejects fabricated file citations and names them', async () => {
    const findings = JSON.stringify([
      {
        file: 'src/invented.ts',
        line: 1,
        severity: 'high',
        title: 'Made up',
        remediation: 'n/a',
      },
    ]);
    const r = await codebaseReviewReport(drawer(findings), ws(SOURCE_FILES), REPORT_PATH, OPTS);
    expect(r.ok).toBe(false);
    expect(r.fabricated).toEqual(['src/invented.ts']);
    expect(r.detail).toContain('src/invented.ts');
  });

  it('verifies citations by read when the listing is capped or dotfile-blind', async () => {
    // Regression (task gezel/8): the service-side listing walks breadth-first
    // under a 500-entry cap and skips dotfiles, so on a large repo a truthful
    // citation is absent from list(). A miss must fall back to a per-path
    // read, not read as fabrication.
    const onDisk: Record<string, string> = { ...SOURCE_FILES, '.gitignore': 'dist/' };
    const truncated: WorkspaceLike = {
      read: async (f) => onDisk[f] ?? null,
      list: async () => [],
    };
    const findings = JSON.stringify([
      ...JSON.parse(GOOD_FINDINGS),
      { file: '.gitignore', severity: 'low', title: 'Ignore list stale', remediation: 'Prune.' },
    ]);
    const r = await codebaseReviewReport(drawer(findings), truncated, REPORT_PATH, OPTS);
    expect(r.ok).toBe(true);
    expect(r.findingCount).toBe(4);

    const invented = JSON.stringify([
      { file: 'src/invented.ts', line: 1, severity: 'high', title: 'Made up', remediation: 'n/a' },
    ]);
    const bad = await codebaseReviewReport(drawer(invented), truncated, REPORT_PATH, OPTS);
    expect(bad.ok).toBe(false);
    expect(bad.fabricated).toEqual(['src/invented.ts']);
  });

  it('requires a line only for critical/high findings', async () => {
    const noLineHigh = JSON.stringify([
      { file: 'src/parse.ts', severity: 'high', title: 'T', remediation: 'R' },
    ]);
    const r = await codebaseReviewReport(drawer(noLineHigh), ws(SOURCE_FILES), REPORT_PATH, OPTS);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not pinned to a line');

    const noLineLow = JSON.stringify([
      { file: 'src/parse.ts', severity: 'low', title: 'T', remediation: 'R' },
    ]);
    const ok = await codebaseReviewReport(drawer(noLineLow), ws(SOURCE_FILES), REPORT_PATH, OPTS);
    expect(ok.ok).toBe(true);
  });

  it('rejects a missing required section', async () => {
    const report = GOOD_REPORT.replace('## Not assessed\nRuntime performance under load.\n', '');
    const r = await codebaseReviewReport(
      drawer(GOOD_FINDINGS, report),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('## Not assessed');
  });

  it('requires a scorecard table with enough dimensions', async () => {
    const report = GOOD_REPORT.replace(
      /\| Architecture[\s\S]*?\| Tests \| B \| Core paths covered \|\n/,
      '',
    );
    const r = await codebaseReviewReport(
      drawer(GOOD_FINDINGS, report),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Scorecard');
  });

  it('requires systemic themes once findings pass the threshold', async () => {
    const report = GOOD_REPORT.replace(
      /## Systemic themes[\s\S]*?## Findings/,
      '## Systemic themes\nNothing systemic.\n\n## Findings',
    );
    const r = await codebaseReviewReport(
      drawer(GOOD_FINDINGS, report),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Systemic themes');
  });

  it('rejects a clean-reading summary over open critical/high findings', async () => {
    const report = GOOD_REPORT.replace(
      /## Executive summary\n[^\n]*\n/,
      '## Executive summary\nThe codebase is in excellent health with no material issues.\n',
    );
    const r = await codebaseReviewReport(
      drawer(GOOD_FINDINGS, report),
      ws(SOURCE_FILES),
      REPORT_PATH,
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('executive summary');
  });
});
