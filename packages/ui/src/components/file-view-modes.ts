import type { BoekwachterIssue, FileReviewIssueSeverity } from '@bendyline/gezel';
import type { FileEntry, TreeNode } from './FileTree.js';

/**
 * View modes for the project file panels (Workspace and Artifacts).
 *
 *   - `tree-alpha`        folder tree, folders and files alphabetical
 *   - `tree-modified`     folder tree, folders alphabetical, files newest-first
 *   - `flat-modified`     flat list of every file, newest-first
 *   - `flat-issues`       flat list ranked by open Boekwachter issue count
 *   - `flat-criticality`  flat list ranked by severity-weighted issue score
 *
 * The last two are workspace-only: artifacts carry no review issues.
 */
export type FileViewMode =
  | 'tree-alpha'
  | 'tree-modified'
  | 'flat-modified'
  | 'flat-issues'
  | 'flat-criticality';

export type TreeSortMode = 'none' | 'alpha' | 'modified';

export const WORKSPACE_VIEW_MODES: readonly FileViewMode[] = [
  'tree-alpha',
  'tree-modified',
  'flat-modified',
  'flat-issues',
  'flat-criticality',
];

export const ARTIFACT_VIEW_MODES: readonly FileViewMode[] = [
  'tree-alpha',
  'tree-modified',
  'flat-modified',
];

function compareNames(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Newest first; entries without a timestamp sink to the end; name tiebreak. */
export function compareFilesByMtimeDesc(
  a: { name: string; mtimeMs?: number },
  b: { name: string; mtimeMs?: number },
): number {
  const at = a.mtimeMs;
  const bt = b.mtimeMs;
  if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
  if (at !== undefined && bt === undefined) return -1;
  if (at === undefined && bt !== undefined) return 1;
  return compareNames(a.name, b.name);
}

/**
 * Sort a built tree recursively: directories always first and always
 * alphabetical; files by the selected mode. Returns new arrays — the input
 * nodes are not mutated beyond their `children` references being re-created.
 */
export function sortTreeNodes(nodes: TreeNode[], mode: 'alpha' | 'modified'): TreeNode[] {
  const sorted = nodes.map((node) =>
    node.children.length > 0 ? { ...node, children: sortTreeNodes(node.children, mode) } : node,
  );
  sorted.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (a.isDirectory || mode === 'alpha') return compareNames(a.name, b.name);
    return compareFilesByMtimeDesc(a, b);
  });
  return sorted;
}

/**
 * Severity weights for the flat "criticality" triage view. Deliberately
 * lopsided: one major outranks three minors on its own.
 */
export const CRITICALITY_WEIGHTS: Record<FileReviewIssueSeverity, number> = {
  major: 10,
  minor: 3,
  info: 1,
};

export interface FileIssueAggregate {
  path: string;
  total: number;
  bySeverity: Record<FileReviewIssueSeverity, number>;
  /** Severity-weighted score per {@link CRITICALITY_WEIGHTS}. */
  score: number;
}

/** Group live issues by file path, one pass. Input order does not matter. */
export function aggregateIssuesByFile(issues: readonly BoekwachterIssue[]): FileIssueAggregate[] {
  const byPath = new Map<string, FileIssueAggregate>();
  for (const issue of issues) {
    let agg = byPath.get(issue.path);
    if (!agg) {
      agg = { path: issue.path, total: 0, bySeverity: { major: 0, minor: 0, info: 0 }, score: 0 };
      byPath.set(issue.path, agg);
    }
    agg.total += 1;
    agg.bySeverity[issue.severity] += 1;
    agg.score += CRITICALITY_WEIGHTS[issue.severity];
  }
  return [...byPath.values()];
}

/** Sorted copy: descending by count or weighted score, path-alpha tiebreak. */
export function sortAggregates(
  aggs: readonly FileIssueAggregate[],
  by: 'count' | 'score',
): FileIssueAggregate[] {
  return [...aggs].sort((a, b) => {
    const diff = by === 'count' ? b.total - a.total : b.score - a.score;
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
  });
}

/** Short severity breakdown for row trailers, e.g. `2 major · 1 minor`. */
export function describeSeverities(bySeverity: Record<FileReviewIssueSeverity, number>): string {
  const parts: string[] = [];
  for (const severity of ['major', 'minor', 'info'] as const) {
    const count = bySeverity[severity];
    if (count > 0) parts.push(`${count} ${severity}`);
  }
  return parts.join(' · ');
}

export function fileViewStorageKey(projectId: string, tab: 'workspace' | 'artifacts'): string {
  return `gezel.projectFilesView:${projectId}:${tab}`;
}

/** Persistence key for the per-tab "show hidden files" toggle. */
export function fileHiddenStorageKey(projectId: string, tab: 'workspace' | 'artifacts'): string {
  return `gezel.projectFilesHidden:${projectId}:${tab}`;
}

/**
 * Coerce a persisted (or otherwise untrusted) mode string to one valid for
 * the given tab. Unknown values — and workspace-only modes persisted before
 * a switch to the artifacts tab — fall back to `tree-alpha`.
 */
export function coerceFileViewMode(
  raw: string | null | undefined,
  tab: 'workspace' | 'artifacts',
): FileViewMode {
  const allowed = tab === 'workspace' ? WORKSPACE_VIEW_MODES : ARTIFACT_VIEW_MODES;
  return allowed.includes(raw as FileViewMode) ? (raw as FileViewMode) : 'tree-alpha';
}

/** Map a flat index-file record (or any path) to a FileTree-shaped entry. */
export function fileEntryFromPath(path: string, mtimeMs?: number): FileEntry {
  const slash = path.lastIndexOf('/');
  return {
    name: slash >= 0 ? path.slice(slash + 1) : path,
    path,
    isDirectory: false,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

/** Parent directory of a slash path, `''` at the root. */
export function parentDirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}
