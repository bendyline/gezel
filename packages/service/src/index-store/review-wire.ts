import { stat } from 'node:fs/promises';
import type {
  BoekwachterIssue,
  FileReviewIssueSeverity,
  FileReviewWire,
  ListFileIssuesRequest,
} from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import type { ProjectBoekwachterIssueRecord } from '../fs/store.js';
import type { FileReviewRow } from './index-store-types.js';
import type { IndexStore } from './index-store.js';

/**
 * Boekwachter reviews and the issues tracked from them, shaped for the wire:
 * the per-file review, each durable issue with its staleness, and the
 * filter, sort and tallies `list_file_issues` serves.
 */

export function toReviewWire(row: FileReviewRow): FileReviewWire {
  return {
    notesMd: row.notesMd,
    issues: row.issues,
    health: row.health,
    healthReason: row.healthReason,
    model: row.model,
    provider: row.provider,
    gezelId: row.gezelId,
    gezelName: row.gezelName,
    appVersion: row.appVersion,
    reviewedAt: row.reviewedAt,
  };
}

export function toBoekwachterIssueWire(
  record: ProjectBoekwachterIssueRecord,
  currentContentHash: string | null,
): BoekwachterIssue {
  return {
    id: record.id,
    ref: record.ref,
    fingerprint: record.fingerprint,
    path: record.path,
    severity: record.severity,
    category: record.category,
    message: record.message,
    ...(record.line !== undefined ? { line: record.line } : {}),
    status: record.status,
    seen: record.seenAt !== undefined,
    stale: currentContentHash === null || currentContentHash !== record.lastSeenContentHash,
    ...(record.taskRef ? { taskRef: record.taskRef } : {}),
    ...(record.dismissalReason ? { dismissalReason: record.dismissalReason } : {}),
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}),
    ...(record.seenAt ? { seenAt: record.seenAt } : {}),
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.dismissedAt ? { dismissedAt: record.dismissedAt } : {}),
  };
}

/**
 * The indexer updates asynchronously after a save. Compare its cheap change
 * gate with the live file before trusting the indexed hash so a freshly edited
 * file marks old BW anchors stale immediately, not one index tick later.
 */
export async function currentIndexedHash(
  index: IndexStore,
  workspaceDir: string,
  path: string,
): Promise<string | null> {
  const indexed = index.getFile(path);
  if (!indexed?.hash) return null;
  const absolute = safeJoin(workspaceDir, path);
  if (!absolute) return null;
  const live = await stat(absolute).catch(() => null);
  if (!live || !live.isFile()) return null;
  return live.size === indexed.size && live.mtimeMs === indexed.mtimeMs ? indexed.hash : null;
}

function issueSeverityRank(severity: FileReviewIssueSeverity): number {
  return severity === 'major' ? 0 : severity === 'minor' ? 1 : 2;
}

export function tallyBoekwachterIssues(
  issues: readonly BoekwachterIssue[],
  key: (issue: BoekwachterIssue) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const value = key(issue);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function filterAndSortBoekwachterIssues(
  issues: BoekwachterIssue[],
  req: ListFileIssuesRequest,
): BoekwachterIssue[] {
  return issues
    .filter((issue) => {
      if (!req.includeClosed && issue.status !== 'open' && issue.status !== 'in_progress') {
        return false;
      }
      if (req.status && issue.status !== req.status) return false;
      if (req.severity && issue.severity !== req.severity) return false;
      if (req.category && issue.category !== req.category) return false;
      if (req.path && !issue.path.startsWith(req.path)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        issueSeverityRank(a.severity) - issueSeverityRank(b.severity) ||
        a.ref.localeCompare(b.ref, undefined, { numeric: true }),
    );
}
