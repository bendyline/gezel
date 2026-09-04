import type { GezelSummary, Project } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { GezelIcon } from './GezelIcon.js';

/** A quiet, completed trace left behind after ephemeral per-file indexing work. */
export interface IndexingReceipt {
  id: string;
  gezelId: string;
  projectId: string;
  startedAt: string;
  completedAt: string;
  files: string[];
}

interface CompletedIndexingFile {
  sessionId: string;
  gezelId: string;
  projectId: string;
  path: string;
  startedAt: string;
  completedAt: string;
}

/** A long index sweep is a chain of short one-shot model turns. */
export const INDEXING_RECEIPT_GAP_MS = 5 * 60_000;
const MAX_INDEXING_RECEIPTS = 20;
const INDEXING_RECEIPT_STORAGE_PREFIX = 'gezel:timeline:indexing-receipts:v1:';

function storageKey(scopeKey: string): string {
  return `${INDEXING_RECEIPT_STORAGE_PREFIX}${scopeKey}`;
}

function isIndexingReceipt(value: unknown): value is IndexingReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<IndexingReceipt>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.gezelId === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.startedAt === 'string' &&
    typeof candidate.completedAt === 'string' &&
    Array.isArray(candidate.files) &&
    candidate.files.every((path) => typeof path === 'string' && path.length > 0)
  );
}

/** Read the bounded local ledger for one timeline surface. */
export function readIndexingReceipts(scopeKey: string): IndexingReceipt[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(scopeKey)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isIndexingReceipt).slice(-MAX_INDEXING_RECEIPTS)
      : [];
  } catch {
    return [];
  }
}

/** Persist best-effort; a full or unavailable browser store must not affect indexing. */
export function writeIndexingReceipts(scopeKey: string, receipts: IndexingReceipt[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey(scopeKey),
      JSON.stringify(receipts.slice(-MAX_INDEXING_RECEIPTS)),
    );
  } catch {
    // The on-screen receipt remains authoritative for this mount.
  }
}

export function indexedPathFromActivity(activity: string | undefined): string | null {
  const match = /^Indexing\s+(.+)$/i.exec(activity?.trim() ?? '');
  const path = match?.[1]?.trim();
  return path ? path : null;
}

/**
 * Fold one completed one-shot into the newest compatible receipt. A code file
 * can receive both a file-summary and a symbol-summary pass; de-duplicating
 * paths keeps that implementation detail from inflating the visible count.
 */
export function recordIndexedFile(
  receipts: IndexingReceipt[],
  completed: CompletedIndexingFile,
): IndexingReceipt[] {
  const completedMs = Date.parse(completed.completedAt);
  let targetIndex = -1;
  for (let index = receipts.length - 1; index >= 0; index--) {
    const candidate = receipts[index]!;
    if (candidate.gezelId !== completed.gezelId || candidate.projectId !== completed.projectId) {
      continue;
    }
    const candidateMs = Date.parse(candidate.completedAt);
    if (
      Number.isFinite(completedMs) &&
      Number.isFinite(candidateMs) &&
      completedMs - candidateMs <= INDEXING_RECEIPT_GAP_MS
    ) {
      targetIndex = index;
    }
    break;
  }

  if (targetIndex < 0) {
    return [
      ...receipts,
      {
        id: `indexing:${completed.sessionId}`,
        gezelId: completed.gezelId,
        projectId: completed.projectId,
        startedAt: completed.startedAt,
        completedAt: completed.completedAt,
        files: [completed.path],
      },
    ].slice(-MAX_INDEXING_RECEIPTS);
  }

  const next = [...receipts];
  const target = next[targetIndex]!;
  if (target.files.includes(completed.path)) return receipts;
  next[targetIndex] = {
    ...target,
    completedAt: completed.completedAt,
    files: [...target.files, completed.path],
  };
  return next;
}

export function IndexingReceiptRow({
  receipt,
  gezels,
  projects,
  showProjectName,
  roleBasedNameOnlyMode,
  onOpenWorkspaceFile,
}: {
  receipt: IndexingReceipt;
  gezels: Map<string, GezelSummary>;
  projects: Map<string, Project>;
  showProjectName?: boolean;
  roleBasedNameOnlyMode: boolean;
  onOpenWorkspaceFile?: (path: string, projectId: string) => void;
}) {
  // Avoid mounting hundreds of path rows until the reader asks for them.
  const [expanded, setExpanded] = useState(false);
  const gezel = gezels.get(receipt.gezelId);
  const gezelName = gezel
    ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
    : 'Boekwachter';
  const project =
    showProjectName && receipt.projectId !== 'default'
      ? projects.get(receipt.projectId)
      : undefined;
  const count = receipt.files.length;

  return (
    <details
      className="timeline-indexing-receipt"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary title={formatAbsoluteTime(receipt.completedAt)}>
        <GezelIcon
          svg={gezel?.icon ?? null}
          poppetje={gezel?.poppetje}
          iconOverride={gezel?.iconOverride}
          name={gezelName}
          size={16}
        />
        <span className="timeline-indexing-receipt-label">
          <strong>{gezelName}</strong> has indexed <strong>{count}</strong>{' '}
          {count === 1 ? 'file' : 'files'}
          {project && <> in {project.name}</>}
          {' · '}
          {formatRelativeTime(receipt.completedAt)}
        </span>
      </summary>
      {expanded && (
        <ul className="timeline-indexing-file-list">
          {receipt.files.map((path) => (
            <li key={path}>
              {onOpenWorkspaceFile ? (
                <button
                  type="button"
                  className="timeline-indexing-file-link"
                  title={`Open ${path}`}
                  aria-label={`Open ${path}`}
                  onClick={() => onOpenWorkspaceFile(path, receipt.projectId)}
                >
                  {path}
                </button>
              ) : (
                <span className="timeline-indexing-file-path">{path}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
