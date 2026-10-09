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
      bySeverity: opts.issues ? { high: 1, medium: opts.issues - 1 } : {},
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
    contentIndex: { fileMap: async () => map, listFileIssues: async () => issues },
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
    expect(body).toContain('4 source files · 4 open issues (1 high, 3 medium).');
    const hotspots = body.slice(body.indexOf('## Hotspots'), body.indexOf('## Load-bearing'));
    expect(hotspots.indexOf('src/parser.ts')).toBeLessThan(hotspots.indexOf('src/core.ts'));
    expect(hotspots).toContain(
      '`src/parser.ts` · 30 commits this year · 3 findings (high) · imported by 12',
    );
    expect(hotspots).not.toContain('README.md');
    expect(body).toContain('- `src/core.ts` · imported by 40');

    expect(await writeNightlyCodebaseReport(d, 'app', NOW)).toBeNull();
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
