import {
  FOLDER_KIND_PROPERTY,
  type FileMapResponse,
  type ListFileIssuesResponse,
  type MapBlock,
  createLogger,
  isCodingProject,
} from '@bendyline/gezel';

const log = createLogger('index');

const MAX_HOTSPOTS = 8;
const MAX_LOAD_BEARING = 5;
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export interface CodebaseReportDeps {
  store: {
    getProject(id: string): Promise<
      | (Parameters<typeof isCodingProject>[0] & {
          properties?: Record<string, string>;
        })
      | null
    >;
    readProjectArtifact(id: string, path: string): Promise<string | null>;
    writeProjectArtifact(id: string, path: string, content: string): Promise<unknown>;
  };
  contentIndex: {
    fileMap(projectId: string): Promise<FileMapResponse>;
    listFileIssues(
      projectId: string,
      req: { maxResults?: number },
    ): Promise<ListFileIssuesResponse>;
  };
}

interface Ranked {
  path: string;
  churn: number;
  findings: number;
  maxSeverity: string | null;
  fanIn: number;
  importance: number;
  weight: number;
}

/**
 * The nightly codebase report: where the risk sits (files that change often
 * and carry findings), which files everything else leans on, and the open
 * issues by severity. Read from the index and git history with no model, so
 * it runs on any machine after the night's sweep; the morning review finds it
 * under `reports/`. One per day, code folders only, nothing written when the
 * map is empty.
 */
export async function writeNightlyCodebaseReport(
  deps: CodebaseReportDeps,
  projectId: string,
  now: Date,
  /** The night's day key, so one night files one report whichever side of midnight it lands. */
  day = localDay(now),
): Promise<string | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;
  const kind = project.properties?.[FOLDER_KIND_PROPERTY];
  if (kind !== 'code' && !(kind === undefined && isCodingProject(project))) return null;

  const path = `reports/codebase-${day}.md`;
  if ((await deps.store.readProjectArtifact(projectId, path).catch(() => null)) !== null) {
    return null;
  }
  const map = await deps.contentIndex.fileMap(projectId);
  if (!map.indexed) return null;
  const files = rankable(map.blocks);
  if (files.length === 0) return null;
  const issues = await deps.contentIndex
    .listFileIssues(projectId, { maxResults: 1 })
    .catch(() => null);

  const hotspots = files
    .filter((f) => f.churn > 0 && (f.findings > 0 || f.fanIn > 0))
    .map((f) => ({
      f,
      score: f.churn * (1 + f.findings) * Math.log2(2 + f.weight) * (1 + f.importance),
    }))
    .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
    .slice(0, MAX_HOTSPOTS)
    .map((r) => r.f);
  const loadBearing = files
    .filter((f) => f.importance > 0 && f.fanIn > 0)
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
    .slice(0, MAX_LOAD_BEARING);
  const openIssues = issues?.counts.total ?? 0;
  if (hotspots.length === 0 && loadBearing.length === 0 && openIssues === 0) return null;

  const lines = [`# Your codebase · ${day}`, ''];
  lines.push(
    `${files.length.toLocaleString('en-US')} source files · ${openIssues.toLocaleString('en-US')} open issue${openIssues === 1 ? '' : 's'}${severityTail(issues)}.`,
  );
  if (hotspots.length > 0) {
    lines.push(
      '',
      '## Hotspots',
      '',
      'Files that change often and carry findings or many dependents: the first places a bug lands.',
      '',
    );
    for (const f of hotspots) {
      const parts = [`${f.churn} commit${f.churn === 1 ? '' : 's'} this year`];
      if (f.findings > 0) {
        parts.push(
          `${f.findings} finding${f.findings === 1 ? '' : 's'}${f.maxSeverity ? ` (${f.maxSeverity})` : ''}`,
        );
      }
      if (f.fanIn > 0) parts.push(`imported by ${f.fanIn}`);
      lines.push(`- \`${f.path}\` · ${parts.join(' · ')}`);
    }
  }
  if (loadBearing.length > 0) {
    lines.push('', '## Load-bearing files', '', 'What the rest of the code leans on most.', '');
    for (const f of loadBearing) {
      lines.push(`- \`${f.path}\` · imported by ${f.fanIn}`);
    }
  }
  lines.push('', 'Nothing has been changed. Proposed fixes, if any, are under Proposals.', '');
  await deps.store.writeProjectArtifact(projectId, path, lines.join('\n'));
  log.info(`[index] ${projectId}: wrote ${path}`);
  return path;
}

function rankable(blocks: MapBlock[]): Ranked[] {
  return blocks
    .filter((b) => b.state !== 'tombstoned' && !b.phantom && b.health)
    .map((b) => ({
      path: b.id,
      churn: b.health!.churn ?? 0,
      findings: b.health!.findings,
      maxSeverity: b.health!.maxSeverity,
      fanIn: b.health!.fanIn,
      importance: b.health!.importance ?? 0,
      weight: b.weight,
    }));
}

function severityTail(issues: ListFileIssuesResponse | null): string {
  const by = issues?.counts.bySeverity ?? {};
  const parts = SEVERITY_ORDER.filter((s) => (by[s] ?? 0) > 0).map((s) => `${by[s]} ${s}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
