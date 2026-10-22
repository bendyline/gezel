import {
  type BoekwachterIssue,
  FOLDER_KIND_PROPERTY,
  type FileMapResponse,
  ISSUE_VERDICT_LABELS,
  type IssueVerdictEntry,
  type IssueVerdictLogKind,
  type ListFileIssuesResponse,
  type MapBlock,
  createLogger,
  isCodingProject,
} from '@bendyline/gezel';
import {
  type VerdictTally,
  isLowConfidence,
  issueVerdictStats,
} from '../issue-triage/calibration.js';

const log = createLogger('index');

const MAX_HOTSPOTS = 8;
const MAX_LOAD_BEARING = 5;
const MAX_NEW_ISSUES = 10;
/** Below this many verdicts a percentage says more about chance than about the reviewer. */
const MIN_DECIDED_FOR_RATE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Boekwachter review severities (`FileReviewIssueSeveritySchema`), worst first — not the security scale. */
const SEVERITY_ORDER = ['major', 'minor', 'info'] as const;

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
    /** The verdict log, for the triage tally; absent in older test fakes. */
    boekwachterIssues?: { readIssueVerdicts(id: string): Promise<IssueVerdictEntry[]> };
  };
  contentIndex: {
    /** Read-only: a background report must never found a village. */
    fileMapSnapshot(projectId: string): Promise<FileMapResponse>;
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
  /** Replace the day's report instead of keeping it: a person asked for one now. */
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;
  const kind = project.properties?.[FOLDER_KIND_PROPERTY];
  if (kind !== 'code' && !(kind === undefined && isCodingProject(project))) return null;

  const path = `reports/codebase-${day}.md`;
  if (
    !opts.force &&
    (await deps.store.readProjectArtifact(projectId, path).catch(() => null)) !== null
  ) {
    return null;
  }
  const map = await deps.contentIndex.fileMapSnapshot(projectId);
  if (!map.indexed) return null;
  const files = rankable(map.blocks);
  if (files.length === 0) return null;
  const issues = await deps.contentIndex
    .listFileIssues(projectId, { maxResults: 1000 })
    .catch(() => null);
  const verdicts =
    (await deps.store.boekwachterIssues?.readIssueVerdicts(projectId).catch(() => [])) ?? [];
  const stats = issueVerdictStats(verdicts);
  // A category the verdicts say is almost never real is not news.
  const newIssues = newSince(issues?.issues ?? [], now.getTime() - DAY_MS).filter(
    (i) => !isLowConfidence(stats, i),
  );

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
  if (
    hotspots.length === 0 &&
    loadBearing.length === 0 &&
    openIssues === 0 &&
    newIssues.length === 0
  ) {
    return null;
  }

  const lines = [`# Your codebase · ${day}`, ''];
  lines.push(
    `${files.length.toLocaleString('en-US')} source files · ${openIssues.toLocaleString('en-US')} open issue${openIssues === 1 ? '' : 's'}${severityTail(issues)}.`,
  );
  if (newIssues.length > 0) {
    lines.push(
      '',
      '## New tonight',
      '',
      `The reviewer flagged ${newIssues.length} new suspected problem${newIssues.length === 1 ? '' : 's'}. They are leads from a smaller model, often wrong; your coding app can check them through Gezel's tools (Settings → Integrations), or hand it \`reports/issue-handoff.md\`.`,
      '',
    );
    for (const issue of newIssues.slice(0, MAX_NEW_ISSUES)) {
      const where = `${issue.path}${issue.line ? `:${issue.line}` : ''}`;
      lines.push(`- ${issue.ref} · ${issue.severity} · \`${where}\` · ${issue.message}`);
    }
    if (newIssues.length > MAX_NEW_ISSUES) {
      lines.push(`- …and ${newIssues.length - MAX_NEW_ISSUES} more.`);
    }
  }
  const tally = triageTally(verdicts, stats.overall);
  if (tally) lines.push('', '## Triage so far', '', tally);
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

/** Open issues first reported since `since`, worst first; repeats of earlier ones are not new. */
function newSince(issues: readonly BoekwachterIssue[], since: number): BoekwachterIssue[] {
  return issues
    .filter((i) => i.status === 'open' && !i.echoOf && Date.parse(i.createdAt) >= since)
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/** One line of verdict counts: "12 verdicts so far: 7 not a bug, 3 fixed, 2 confirmed real." */
function triageTally(verdicts: readonly IssueVerdictEntry[], overall: VerdictTally): string | null {
  const counts = new Map<IssueVerdictLogKind, number>();
  for (const v of verdicts) {
    if (v.by.kind === 'system' || v.kind === 'reopened') continue;
    counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const parts = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${ISSUE_VERDICT_LABELS[kind].toLowerCase()}`);
  const line = `${total} verdict${total === 1 ? '' : 's'} so far: ${parts.join(', ')}.`;
  if (overall.decided < MIN_DECIDED_FOR_RATE) return line;
  const pct = (n: number) => `${Math.round((100 * n) / overall.decided)}%`;
  return `${line} Of the leads checked, ${pct(overall.valid)} were true (${pct(overall.actionable)} worth fixing) and ${pct(overall.wrong)} were wrong.`;
}

function severityTail(issues: ListFileIssuesResponse | null): string {
  const by = issues?.counts.bySeverity ?? {};
  const parts = SEVERITY_ORDER.filter((s) => (by[s] ?? 0) > 0).map((s) => `${by[s]} ${s}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
