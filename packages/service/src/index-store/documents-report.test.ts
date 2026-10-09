import { FOLDER_KIND_PROPERTY, SHARED_PROJECT_MARKER } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type DocumentsReportDeps,
  type RecentDocument,
  summaryLead,
  writeNightlyDocumentsReport,
} from './documents-report.js';

const NOW = new Date(2026, 9, 8, 4, 0);

function deps(opts: {
  kind?: string;
  shared?: boolean;
  reports?: string[];
  recent?: RecentDocument[];
}) {
  const written = new Map<string, string>();
  const since: number[] = [];
  const d: DocumentsReportDeps = {
    store: {
      getProject: async () => ({
        workingDir: '/Users/a/Documents',
        properties: {
          ...(opts.kind ? { [FOLDER_KIND_PROPERTY]: opts.kind } : {}),
          ...(opts.shared ? { [SHARED_PROJECT_MARKER]: '1' } : {}),
        },
      }),
      listProjectArtifacts: async () =>
        (opts.reports ?? []).map((name) => ({ name, path: `reports/${name}`, isDirectory: false })),
      readProjectArtifact: async (_id, path) => written.get(path) ?? null,
      writeProjectArtifact: async (_id, path, content) => {
        written.set(path, content);
      },
    },
    contentIndex: {
      recentDocuments: async (_id, sinceMs) => {
        since.push(sinceMs);
        return opts.recent ?? [];
      },
    },
  };
  return { d, written, since };
}

describe('writeNightlyDocumentsReport', () => {
  it('lists what changed since the last report, with what each document is, once a day', async () => {
    const { d, written, since } = deps({
      kind: 'documents',
      reports: ['documents-2026-10-06.md', 'photos-2026-10-07.md'],
      recent: [
        {
          path: 'Home/lease.pdf',
          mtimeMs: NOW.getTime() - 3_600_000,
          summary: '## Lease\n\nThe flat lease for 2026, renewed in March.',
        },
        { path: 'Taxes/2025.xlsx', mtimeMs: NOW.getTime() - 7_200_000, summary: null },
      ],
    });

    expect(await writeNightlyDocumentsReport(d, 'docs', NOW)).toBe(
      'reports/documents-2026-10-08.md',
    );
    expect(since[0]).toBe(new Date(2026, 9, 6).getTime());
    const body = written.get('reports/documents-2026-10-08.md')!;
    expect(body).toContain('2 documents added or changed since 2026-10-06.');
    expect(body).toContain('- `Home/lease.pdf` — The flat lease for 2026, renewed in March.');
    expect(body).toContain('- `Taxes/2025.xlsx`\n');
    expect(body).toContain('Nothing has been moved or changed.');

    expect(await writeNightlyDocumentsReport(d, 'docs', NOW)).toBeNull();
  });

  it('writes nothing for photos, code, the shared library, or a quiet night', async () => {
    const doc = [{ path: 'a.md', mtimeMs: NOW.getTime(), summary: null }];
    expect(
      await writeNightlyDocumentsReport(deps({ kind: 'pictures', recent: doc }).d, 'p', NOW),
    ).toBeNull();
    expect(
      await writeNightlyDocumentsReport(deps({ kind: 'code', recent: doc }).d, 'c', NOW),
    ).toBeNull();
    expect(
      await writeNightlyDocumentsReport(
        deps({ kind: 'documents', shared: true, recent: doc }).d,
        's',
        NOW,
      ),
    ).toBeNull();
    expect(await writeNightlyDocumentsReport(deps({ kind: 'mixed' }).d, 'm', NOW)).toBeNull();
  });

  it('looks back a day on the first report and never more than a week', async () => {
    const first = deps({ kind: 'documents' });
    await writeNightlyDocumentsReport(first.d, 'docs', NOW);
    expect(first.since[0]).toBe(NOW.getTime() - 86_400_000);
    const stale = deps({ kind: 'documents', reports: ['documents-2026-01-01.md'] });
    await writeNightlyDocumentsReport(stale.d, 'docs', NOW);
    expect(stale.since[0]).toBe(NOW.getTime() - 7 * 86_400_000);
  });

  it('keeps a summary to its first prose line', () => {
    expect(summaryLead('# Title\n\nFirst **bold** line.\n\nSecond.')).toBe('First bold line.');
  });
});
