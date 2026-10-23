import type { ProjectReportKind } from '@bendyline/gezel';

/** Markdown that reads as a report: under reports/, or *report*.md, or digest. */
export function isReportShaped(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md')) return false;
  return (
    lower.startsWith('reports/') ||
    lower.includes('/reports/') ||
    lower.includes('report') ||
    lower.includes('digest')
  );
}

/** What a report is about, by where its writer files it. */
export function reportKindOf(path: string): ProjectReportKind {
  const lower = path.toLowerCase();
  if (lower === 'reports/codebase-map.md') return 'map';
  if (lower === 'reports/issue-handoff.md') return 'issues';
  if (/^reports\/codebase-\d{4}-\d{2}-\d{2}\.md$/.test(lower)) return 'codebase';
  if (/^reports\/documents-\d{4}-\d{2}-\d{2}\.md$/.test(lower)) return 'documents';
  if (/^reports\/photos-\d{4}-\d{2}-\d{2}\.md$/.test(lower)) return 'photos';
  if (/(^|\/)reviews\/[^/]+\/report\.md$/.test(lower)) return 'review';
  if (lower.includes('digest')) return 'digest';
  return 'other';
}
