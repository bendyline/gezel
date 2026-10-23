import { FOLDER_KIND_PROPERTY } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type ProjectReportDeps, listProjectReports, writableReports } from './project-reports.js';
import { reportKindOf } from './report-paths.js';

const ACTION = [
  '```gezel-action',
  'kind: fire-craftbook',
  'id: tidy-parser',
  'title: Tidy the parser',
  'reason: It changed most.',
  'craftbookId: refactor',
  'projectId: p',
  '```',
].join('\n');

function deps(opts: {
  files?: Record<string, { content: string; mtimeMs: number }>;
  kind?: string;
  workingDir?: string;
  images?: number;
}): ProjectReportDeps {
  const files = opts.files ?? {};
  const store = {
    getProject: async (id: string) => ({
      id,
      name: 'P',
      packages: [],
      ...(opts.workingDir ? { workingDir: opts.workingDir } : {}),
      properties: opts.kind ? { [FOLDER_KIND_PROPERTY]: opts.kind } : {},
    }),
    listProjectArtifactsRecursive: async () =>
      Object.entries(files).map(([path, f]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        isDirectory: false,
        mtimeMs: f.mtimeMs,
      })),
    readProjectArtifact: async (_id: string, path: string) => files[path]?.content ?? null,
  };
  const contentIndex = {
    overview: async () => ({ byModality: { image: opts.images ?? 0 } }),
  };
  return { store, contentIndex } as unknown as ProjectReportDeps;
}

describe('listProjectReports', () => {
  it('lists every report newest first, with its title, kind and actions', async () => {
    const result = await listProjectReports(
      deps({
        kind: 'code',
        files: {
          'reports/codebase-2026-10-20.md': { content: '# Your codebase · 2026-10-20\n', mtimeMs: 300 },
          'reports/codebase-map.md': { content: '# P: codebase map\n', mtimeMs: 100 },
          'reviews/r1/report.md': { content: `# Review of main\n\n${ACTION}\n`, mtimeMs: 200 },
          'tasks/3/weekly-digest.md': { content: 'no heading here', mtimeMs: 50 },
          'notes/plan.md': { content: '# A plan, not a report', mtimeMs: 400 },
          'reports/chart.png': { content: '', mtimeMs: 500 },
        },
      }),
      'p',
    );
    expect(result.reports.map((r) => [r.path, r.kind, r.title, r.actions])).toEqual([
      ['reports/codebase-2026-10-20.md', 'codebase', 'Your codebase · 2026-10-20', 0],
      ['reviews/r1/report.md', 'review', 'Review of main', 1],
      ['reports/codebase-map.md', 'map', 'P: codebase map', 0],
      ['tasks/3/weekly-digest.md', 'digest', 'weekly-digest.md', 0],
    ]);
    expect(result.writable).toEqual(['codebase', 'map', 'issues']);
    expect(result.truncated).toBe(false);
  });
});

describe('writableReports', () => {
  it('offers each folder the reports its writers would write', async () => {
    expect(await writableReports(deps({ kind: 'code' }), 'p')).toEqual([
      'codebase',
      'map',
      'issues',
    ]);
    expect(await writableReports(deps({ kind: 'documents', workingDir: '/docs' }), 'p')).toEqual([
      'documents',
    ]);
    expect(
      await writableReports(deps({ kind: 'mixed', workingDir: '/mix', images: 40 }), 'p'),
    ).toEqual(['documents', 'photos']);
    expect(await writableReports(deps({ kind: 'pictures', images: 5 }), 'p')).toEqual([]);
  });
});

describe('reportKindOf', () => {
  it('reads the kind from where each writer files its report', () => {
    expect(reportKindOf('reports/photos-2026-01-02.md')).toBe('photos');
    expect(reportKindOf('reports/issue-handoff.md')).toBe('issues');
    expect(reportKindOf('reports/documents-2026-01-02.md')).toBe('documents');
    expect(reportKindOf('reports/codebase-notes.md')).toBe('other');
    expect(reportKindOf('reviews/abc/report.md')).toBe('review');
  });
});
