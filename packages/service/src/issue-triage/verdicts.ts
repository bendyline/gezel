import { readFile } from 'node:fs/promises';
import {
  type ApplyIssueVerdictsResponse,
  ISSUE_VERDICT_LABELS,
  type IssueVerdictActor,
  type IssueVerdictInput,
  type IssueVerdictResult,
  createLogger,
  issueVerdictActorLabel,
} from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { IssueVerdictApplication } from '../fs/boekwachter-issue-store.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { sha256 } from '../index-store/hash.js';
import { toBoekwachterIssueWire } from '../index-store/review-wire.js';

const log = createLogger('issue-triage');

export interface IssueVerdictDeps {
  store: Pick<Store, 'boekwachterIssues' | 'listProjectBoekwachterIssues' | 'projectWorkspaceDir'>;
  history?: Pick<HistoryManager, 'log'>;
}

/**
 * The one owner of verdicts on BW issues: the person's buttons, a gezel's
 * `set_file_issue_status`, an outside app's `report_issue_verdicts` and an
 * imported handoff document all land here. `by` comes from the caller's
 * credential, never from a request body. See docs/issue-triage.md.
 */
export async function applyIssueVerdicts(
  deps: IssueVerdictDeps,
  projectId: string,
  inputs: readonly IssueVerdictInput[],
  by: IssueVerdictActor,
): Promise<ApplyIssueVerdictsResponse> {
  const records = await deps.store.listProjectBoekwachterIssues(projectId);
  const pathByRef = new Map(records.map((r) => [r.ref, r.path]));
  const workspaceDir = await deps.store.projectWorkspaceDir(projectId).catch(() => null);

  // The live hash of each file, read once: it records what the verdict was
  // made against, and it is how "fixed" with an unchanged file is caught.
  const hashes = new Map<string, string | null>();
  const liveHash = async (path: string | undefined): Promise<string | null> => {
    if (!path || !workspaceDir) return null;
    if (!hashes.has(path)) hashes.set(path, await liveTextHash(workspaceDir, path));
    return hashes.get(path) ?? null;
  };
  const items: IssueVerdictApplication[] = [];
  for (const input of inputs) {
    items.push({ input, fileHash: await liveHash(pathByRef.get(input.ref)) });
  }

  const outcomes = await deps.store.boekwachterIssues.applyIssueVerdicts(projectId, items, by);
  const results: IssueVerdictResult[] = [];
  for (const outcome of outcomes) {
    results.push({
      ref: outcome.ref,
      outcome: outcome.outcome,
      message: outcome.message,
      ...(outcome.record
        ? { issue: toBoekwachterIssueWire(outcome.record, hashes.get(outcome.record.path) ?? null) }
        : {}),
    });
  }
  const applied = results.filter((r) => r.outcome === 'applied');
  const refused = results.length - applied.length;

  if (applied.length > 0 && deps.history) {
    const counts: Record<string, number> = {};
    for (const input of inputs) {
      if (applied.some((r) => r.ref === input.ref))
        counts[input.kind] = (counts[input.kind] ?? 0) + 1;
    }
    const summaryParts = Object.entries(counts).map(
      ([kind, n]) =>
        `${n} ${ISSUE_VERDICT_LABELS[kind as IssueVerdictInput['kind']].toLowerCase()}`,
    );
    await deps.history
      .log({
        kind: 'project.issue.verdicts',
        projectId,
        ...(by.kind === 'gezel' ? { gezelId: by.gezelId } : {}),
        summary: `${issueVerdictActorLabel(by)} judged ${applied.length} issue${applied.length === 1 ? '' : 's'}: ${summaryParts.join(', ')}`,
        details: { by, refs: applied.map((r) => r.ref), counts, applied: applied.length, refused },
      })
      .catch((err: unknown) => log.warn(`history log failed: ${String(err)}`));
  }
  return { results, applied: applied.length, refused };
}

/**
 * The file's hash exactly as the indexer computes it for text (`sha256` of the
 * UTF-8 read), straight from disk: the index lags a save, which is precisely
 * when an app reports "fixed".
 */
async function liveTextHash(workspaceDir: string, path: string): Promise<string | null> {
  const absolute = safeJoin(workspaceDir, path);
  if (!absolute) return null;
  try {
    return sha256(await readFile(absolute, 'utf8'));
  } catch {
    return null;
  }
}
