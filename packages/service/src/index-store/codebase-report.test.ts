import {
  FOLDER_KIND_PROPERTY,
  type FileMapResponse,
  type ListFileIssuesResponse,
  type MapBlock,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type CodebaseReportDeps, writeNightlyCodebaseReport } from './codebase-report.js';

const NOW = new Date(2026, 9, 8, 4, 0);

function block(
  path: string,
  health: {
    churn?: number;
    findings?: number;
    maxSeverity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
    fanIn?: number;
    importance?: number;
  },
  weight = 100,
): MapBlock {
  return {
    id: path,
    districtId: 'd',
    rect: { x: 0, y: 0, w: 1, h: 1 },
    label: path,
    weight,
    state: 'live',
    buildingCount: 1,
    health: {
      findings: health.findings ?? 0,
      maxSeverity: health.maxSeverity ?? null,
      fanIn: health.fanIn ?? 0,
      fanOut: 0,
      vibe: 'tidy',
      zone: 'commercial',
      ...(health.importance !== undefined ? { importance: health.importance } : {}),
      ...(health.churn !== undefined ? { churn: health.churn } : {}),
    },
  };
}

function deps(opts: { kind?: string; indexed?: boolean; blocks?: MapBlock[]; issues?: number }) {
  const written = new Map<string, string>();
  const map = {
    domain: 'code',
    root: '',
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    builtAt: NOW.toISOString(),
    indexed: opts.indexed ?? true,
    districts: [],
    blocks: opts.blocks ?? [],
    buildings: [],
    roads: [],
  } as unknown as FileMapResponse;
  const issues = {
    issues: [],
    counts: {
      total: opts.issues ?? 0,
      bySeverity: opts.issues ? { major: 1, minor: opts.issues - 1 } : {},
      byCategory: {},
    },
    truncated: false,
    indexed: true,
    reviewedFiles: 0,
    eligibleFiles: 0,
  } as ListFileIssuesResponse;
  const d: CodebaseReportDeps = {
    store: {
      getProject: async () => {
        const properties: Record<string, string> = {};
        if (opts.kind) properties[FOLDER_KIND_PROPERTY] = opts.kind;
        return { properties };
      },
      readProjectArtifact: async (_id, path) => written.get(path) ?? null,
      writeProjectArtifact: async (_id, path, content) => {
        written.set(path, content);
      },
    },
    contentIndex: { fileMapSnapshot: async () => map, listFileIssues: async () => issues },
  };
  return { d, written };
}

describe('writeNightlyCodebaseReport', () => {
  it('names the hotspots and the load-bearing files, once a day', async () => {
    const { d, written } = deps({
      kind: 'code',
      issues: 4,
      blocks: [
        block(
          'src/parser.ts',
          { churn: 30, findings: 3, maxSeverity: 'high', fanIn: 12, importance: 0.6 },
          900,
        ),
        block('src/core.ts', { churn: 4, fanIn: 40, importance: 1 }, 400),
        block('README.md', { churn: 50 }),
        block('src/quiet.ts', { fanIn: 2, importance: 0.1 }),
      ],
    });

    expect(await writeNightlyCodebaseReport(d, 'app', NOW)).toBe('reports/codebase-2026-10-08.md');
    const body = written.get('reports/codebase-2026-10-08.md')!;
    expect(body).toContain('4 source files · 4 open issues (1 major, 3 minor).');
    const hotspots = body.slice(body.indexOf('## Hotspots'), body.indexOf('## Load-bearing'));
    expect(hotspots.indexOf('src/parser.ts')).toBeLessThan(hotspots.indexOf('src/core.ts'));
    expect(hotspots).toContain(
      '`src/parser.ts` · 30 commits this year · 3 findings (high) · imported by 12',
    );
    expect(hotspots).not.toContain('README.md');
    expect(body).toContain('- `src/core.ts` · imported by 40');

    expect(await writeNightlyCodebaseReport(d, 'app', NOW)).toBeNull();

    // A person asking for one now replaces the day's report.
    written.set('reports/codebase-2026-10-08.md', 'stale');
    expect(await writeNightlyCodebaseReport(d, 'app', NOW, undefined, { force: true })).toBe(
      'reports/codebase-2026-10-08.md',
    );
    expect(written.get('reports/codebase-2026-10-08.md')).toContain('## Hotspots');
  });

  it('leads with the issues first flagged tonight and tallies the verdicts so far', async () => {
    const { d, written } = deps({
      kind: 'code',
      blocks: [block('src/a.ts', { churn: 3, fanIn: 1, importance: 1 })],
    });
    const base = {
      fingerprint: 'f',
      category: 'bug',
      status: 'open' as const,
      seen: false,
      stale: false,
      lastSeenAt: NOW.toISOString(),
    };
    const issues = [
      {
        ...base,
        id: '1',
        ref: 'BW-1',
        path: 'src/a.ts',
        line: 4,
        severity: 'minor' as const,
        message: 'Tonight, minor.',
        createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      },
      {
        ...base,
        id: '2',
        ref: 'BW-2',
        path: 'src/b.ts',
        severity: 'major' as const,
        message: 'Tonight, major.',
        createdAt: new Date(NOW.getTime() - 7_200_000).toISOString(),
      },
      {
        ...base,
        id: '3',
        ref: 'BW-3',
        path: 'src/c.ts',
        severity: 'major' as const,
        message: 'Last week.',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        ...base,
        id: '4',
        ref: 'BW-4',
        path: 'src/a.ts',
        severity: 'minor' as const,
        message: 'A repeat.',
        echoOf: 'BW-9',
        createdAt: NOW.toISOString(),
      },
    ];
    d.contentIndex.listFileIssues = async () => ({
      issues,
      counts: { total: 4, bySeverity: { major: 2, minor: 2 }, byCategory: {} },
      truncated: false,
      indexed: true,
      reviewedFiles: 3,
      eligibleFiles: 3,
    });
    d.store.boekwachterIssues = {
      readIssueVerdicts: async () =>
        [
          {
            issueId: 'a',
            category: 'bug',
            kind: 'not_a_bug',
            by: { kind: 'app', client: 'claude-code' },
          },
          { issueId: 'b', category: 'bug', kind: 'not_a_bug', by: { kind: 'person' } },
          {
            issueId: 'c',
            category: 'bug',
            kind: 'fixed',
            by: { kind: 'app', client: 'claude-code' },
          },
          { issueId: 'c', category: 'bug', kind: 'recurred', by: { kind: 'system' } },
        ] as never,
    };

    await writeNightlyCodebaseReport(d, 'app', NOW);
    const body = written.get('reports/codebase-2026-10-08.md')!;
    const tonight = body.slice(body.indexOf('## New tonight'), body.indexOf('## Triage so far'));
    expect(tonight).toContain('2 new suspected problems');
    expect(tonight.indexOf('BW-2')).toBeLessThan(tonight.indexOf('BW-1'));
    expect(tonight).toContain('- BW-1 · minor · `src/a.ts:4` · Tonight, minor.');
    expect(tonight).not.toContain('BW-3');
    expect(tonight).not.toContain('BW-4');
    expect(body).toContain('3 verdicts so far: 2 not a bug, 1 fixed.');
  });

  it('writes nothing for photo or document folders, or before the first scan', async () => {
    const blocks = [block('src/a.ts', { churn: 3, fanIn: 1, importance: 1 })];
    expect(
      await writeNightlyCodebaseReport(deps({ kind: 'pictures', blocks }).d, 'p', NOW),
    ).toBeNull();
    expect(
      await writeNightlyCodebaseReport(deps({ kind: 'documents', blocks }).d, 'd', NOW),
    ).toBeNull();
    expect(
      await writeNightlyCodebaseReport(deps({ kind: 'code', indexed: false, blocks }).d, 'c', NOW),
    ).toBeNull();
  });
});
