import { stat } from 'node:fs/promises';
import type {
  BoekwachterIssue,
  FileReviewIssueSeverity,
  FileReviewWire,
  ListFileIssuesRequest,
  ListFileIssuesResponse,
} from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
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
    ...(record.latestVerdict ? { latestVerdict: record.latestVerdict } : {}),
    ...(record.lastReviewModel ? { reviewModel: record.lastReviewModel } : {}),
    ...(record.echoOf ? { echoOf: record.echoOf } : {}),
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    ...(record.handoffLease && record.handoffLease.until > new Date().toISOString()
      ? { handoff: record.handoffLease }
      : {}),
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
      // Replaced by its own rewording: the newer issue stands for it.
      if (!req.includeClosed && issue.supersededBy) return false;
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

/**
 * The first `limit` issues with counts over all of them. `isLowConfidence`
 * marks set-aside issues before the page is cut, so the count is not limited
 * to the page.
 */
export function boekwachterIssuePage(
  matching: readonly BoekwachterIssue[],
  limit: number,
  isLowConfidence?: (issue: BoekwachterIssue) => boolean,
): Pick<ListFileIssuesResponse, 'issues' | 'counts' | 'truncated'> {
  const issues = isLowConfidence
    ? matching.map((issue) => (isLowConfidence(issue) ? { ...issue, lowConfidence: true } : issue))
    : [...matching];
  return {
    issues: issues.slice(0, limit),
    counts: {
      total: issues.length,
      bySeverity: tallyBoekwachterIssues(issues, (issue) => issue.severity),
      byCategory: tallyBoekwachterIssues(issues, (issue) => issue.category),
      ...(isLowConfidence
        ? { lowConfidence: issues.filter((issue) => issue.lowConfidence).length }
        : {}),
    },
    truncated: issues.length > limit,
  };
}
