/**
 * Per-craftbook gate calibration stats, aggregated from `task.step.gated`
 * history events. The two mis-calibration smells the strategy docs call
 * out read directly off this shape: a book whose gates NEVER reject
 * (approves ≈ attempts, zero holds) adds no information; a book that
 * ALWAYS holds (holds ≈ attempts, pauses climbing) is stricter than its
 * deliverable class and stalls every task that pins it. Task-domain
 * logic, kept out of HistoryManager (generic infra) and in-process so a
 * future suggest-ranking prior can call it directly.
 */

import type { HistoryEvent } from '@bendyline/gezel';
import type { HistoryManager } from '../history/manager.js';

export interface GateBookStats {
  bookCatalogId: string;
  /** Total gate evaluations recorded (approves + holds). */
  attempts: number;
  approves: number;
  holds: number;
  /** Holds that exhausted the budget and paused the task. */
  pauses: number;
  distinctTasks: number;
  /** Histogram of the first failing check kind across holds. */
  firstFailKinds: Record<string, number>;
}

export async function aggregateGateStats(
  history: Pick<HistoryManager, 'listEvents'>,
  filter: { projectId?: string; from?: string; to?: string } = {},
): Promise<GateBookStats[]> {
  const events = await history.listEvents({
    kinds: ['task.step.gated'],
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.from ? { from: filter.from } : {}),
    ...(filter.to ? { to: filter.to } : {}),
  });
  const byBook = new Map<string, GateBookStats & { taskRefs: Set<string> }>();
  for (const event of events) {
    const d = detailsOf(event);
    const bookCatalogId = typeof d.bookCatalogId === 'string' ? d.bookCatalogId : '(inline)';
    let row = byBook.get(bookCatalogId);
    if (!row) {
      row = {
        bookCatalogId,
        attempts: 0,
        approves: 0,
        holds: 0,
        pauses: 0,
        distinctTasks: 0,
        firstFailKinds: {},
        taskRefs: new Set<string>(),
      };
      byBook.set(bookCatalogId, row);
    }
    row.attempts += 1;
    if (typeof d.ref === 'string') row.taskRefs.add(d.ref);
    if (d.decision === 'approve') {
      row.approves += 1;
    } else {
      row.holds += 1;
      if (d.paused === true) row.pauses += 1;
      if (typeof d.firstFailKind === 'string') {
        row.firstFailKinds[d.firstFailKind] = (row.firstFailKinds[d.firstFailKind] ?? 0) + 1;
      }
    }
  }
  return [...byBook.values()]
    .map(({ taskRefs, ...row }) => ({ ...row, distinctTasks: taskRefs.size }))
    .sort((a, b) => b.attempts - a.attempts);
}

/**
 * Per-MODEL gate evidence for capability-floor routing (C4): how each
 * (provider, model) pair has fared against completion gates, optionally
 * scoped to one book. Reads the `model`/`provider` fields the gated
 * event gained with the routing work — events stamped before that (or
 * whose working session couldn't be resolved) carry neither and are
 * skipped, which keeps the aggregation backward-compatible.
 */
export interface ModelGateEvidence {
  attempts: number;
  approves: number;
  holds: number;
  pauses: number;
}

export async function aggregateModelGateEvidence(
  history: Pick<HistoryManager, 'listEvents'>,
  filter: { bookCatalogId?: string; from?: string } = {},
): Promise<Map<string, ModelGateEvidence>> {
  const events = await history.listEvents({
    kinds: ['task.step.gated'],
    ...(filter.from ? { from: filter.from } : {}),
  });
  const byModel = new Map<string, ModelGateEvidence>();
  for (const event of events) {
    const d = detailsOf(event);
    if (typeof d.model !== 'string' || typeof d.provider !== 'string') continue;
    if (filter.bookCatalogId && d.bookCatalogId !== filter.bookCatalogId) continue;
    const key = `${d.provider}:${d.model}`;
    let row = byModel.get(key);
    if (!row) {
      row = { attempts: 0, approves: 0, holds: 0, pauses: 0 };
      byModel.set(key, row);
    }
    row.attempts += 1;
    if (d.decision === 'approve') {
      row.approves += 1;
    } else {
      row.holds += 1;
      if (d.paused === true) row.pauses += 1;
    }
  }
  return byModel;
}

function detailsOf(event: HistoryEvent): Record<string, unknown> {
  return event.details && typeof event.details === 'object'
    ? (event.details as Record<string, unknown>)
    : {};
}
