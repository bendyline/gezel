import {
  FOLDER_KIND_PROPERTY,
  type ProjectFileEntry,
  createLogger,
  isSharedLibraryProject,
} from '@bendyline/gezel';

const log = createLogger('index');

/** Documents one report lists; the rest are counted. */
const MAX_LISTED = 25;
/** A first report, or one after a long gap, looks back no further than this. */
const MAX_LOOKBACK_MS = 7 * 86_400_000;
const DEFAULT_LOOKBACK_MS = 86_400_000;
const REPORT_NAME = /^documents-(\d{4}-\d{2}-\d{2})\.md$/;

export interface RecentDocument {
  path: string;
  mtimeMs: number;
  summary: string | null;
}

export interface DocumentsReportDeps {
  store: {
    getProject(id: string): Promise<{
      properties?: Record<string, string>;
      workingDir?: string;
    } | null>;
    listProjectArtifacts(id: string, subpath?: string): Promise<ProjectFileEntry[]>;
    readProjectArtifact(id: string, path: string): Promise<string | null>;
    writeProjectArtifact(id: string, path: string, content: string): Promise<unknown>;
  };
  contentIndex: {
    recentDocuments(projectId: string, sinceMs: number): Promise<RecentDocument[] | null>;
  };
}

/**
 * The nightly "what's new in your documents" report for a folder of
 * documents: what changed since the last report, each with the Boekwachter's
 * summary of what it is. Read from the index with no model, after the night's
 * sweep has summarized the new files; the morning review finds it under
 * `reports/`. One per day, nothing written when nothing changed, and never for
 * the shared library, which is not a jobsite.
 */
export async function writeNightlyDocumentsReport(
  deps: DocumentsReportDeps,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  const kind = project?.properties?.[FOLDER_KIND_PROPERTY];
  if (!project?.workingDir || (kind !== 'documents' && kind !== 'mixed')) return null;
  if (isSharedLibraryProject(project)) return null;

  const day = localDay(now);
  const path = `reports/documents-${day}.md`;
  if ((await deps.store.readProjectArtifact(projectId, path).catch(() => null)) !== null) {
    return null;
  }
  const since = await lookbackStart(deps, projectId, now);
  const recent = await deps.contentIndex.recentDocuments(projectId, since);
  if (!recent || recent.length === 0) return null;

  const lines = [
    `# Your documents · ${day}`,
    '',
    `${recent.length.toLocaleString('en-US')} document${recent.length === 1 ? '' : 's'} added or changed since ${localDay(new Date(since))}.`,
    '',
  ];
  for (const doc of recent.slice(0, MAX_LISTED)) {
    const lead = doc.summary ? summaryLead(doc.summary) : '';
    lines.push(`- \`${doc.path}\`${lead ? ` — ${lead}` : ''}`);
  }
  if (recent.length > MAX_LISTED) {
    lines.push('', `And ${(recent.length - MAX_LISTED).toLocaleString('en-US')} more.`);
  }
  lines.push('', 'Nothing has been moved or changed.', '');
  await deps.store.writeProjectArtifact(projectId, path, lines.join('\n'));
  log.info(`[index] ${projectId}: wrote ${path}`);
  return path;
}

/** The start of the day of the last report, else a day back; never more than a week. */
async function lookbackStart(
  deps: DocumentsReportDeps,
  projectId: string,
  now: Date,
): Promise<number> {
  const entries = await deps.store.listProjectArtifacts(projectId, 'reports').catch(() => []);
  const days = entries
    .map((e) => REPORT_NAME.exec(e.name)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
  const last = days[days.length - 1];
  const floor = now.getTime() - MAX_LOOKBACK_MS;
  if (!last) return now.getTime() - DEFAULT_LOOKBACK_MS;
  const [y, m, d] = last.split('-').map(Number);
  return Math.max(floor, new Date(y!, m! - 1, d!).getTime());
}

/** The first prose paragraph of a summary, as one short plain line. */
export function summaryLead(summary: string): string {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const first =
    paragraphs.find((p) => !/^#+\s/.test(p)) ?? paragraphs[0]?.replace(/^#+\s+/, '') ?? '';
  const plain = first.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  return plain.length > 200 ? `${plain.slice(0, 197).trimEnd()}…` : plain;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
