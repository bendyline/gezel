import { join } from 'node:path';
import {
  type IssueHandoffDocumentResponse,
  type IssueHandoffRequest,
  createLogger,
  renderIssueHandoff,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { type CodebaseMapDeps, writeCodebaseMap } from '../index-store/codebase-map.js';
import { type IssueHandoffDeps, buildIssueHandoffQueue } from './queue.js';

const log = createLogger('issue-triage');

export const ISSUE_HANDOFF_REPORT_PATH = 'reports/issue-handoff.md';

export interface IssueHandoffDocumentDeps extends IssueHandoffDeps {
  store: IssueHandoffDeps['store'] &
    Pick<
      Store,
      'getProject' | 'projectWorkspaceDir' | 'readProjectArtifact' | 'writeProjectArtifact'
    >;
}

/**
 * The handoff document for a project: the next batch of issues as markdown
 * with a response block under each. Built for the person, so it leases
 * nothing; an app that wants issues held for it uses the tools.
 */
export async function buildIssueHandoffDocument(
  deps: IssueHandoffDocumentDeps,
  projectId: string,
  req: IssueHandoffRequest,
  now: Date = new Date(),
): Promise<IssueHandoffDocumentResponse> {
  const [queue, project, workspaceDir] = await Promise.all([
    buildIssueHandoffQueue(deps, projectId, req),
    deps.store.getProject(projectId),
    deps.store.projectWorkspaceDir(projectId).catch(() => null),
  ]);
  const markdown = renderIssueHandoff(queue, {
    projectId,
    projectName: project?.name ?? projectId,
    generatedAt: now.toISOString(),
    absolutePath: (rel) => (workspaceDir ? join(workspaceDir, rel) : rel),
  });
  return { markdown, count: queue.count, remaining: queue.remaining };
}

/**
 * The night's `reports/issue-handoff.md`, rewritten only when its issues
 * changed, so a person can hand the list to any app in the morning. Nothing
 * is written for a project with no open issues.
 */
export async function writeIssueHandoffReport(
  deps: IssueHandoffDocumentDeps,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const doc = await buildIssueHandoffDocument(deps, projectId, {}, now);
  if (doc.count === 0) return null;
  const previous = await deps.store
    .readProjectArtifact(projectId, ISSUE_HANDOFF_REPORT_PATH)
    .catch(() => null);
  const withoutStamp = (text: string) => text.replace(/ generated=\S+/, '');
  if (previous !== null && withoutStamp(previous) === withoutStamp(doc.markdown)) return null;
  await deps.store.writeProjectArtifact(projectId, ISSUE_HANDOFF_REPORT_PATH, doc.markdown);
  log.info(`[issue-triage] ${projectId}: wrote ${ISSUE_HANDOFF_REPORT_PATH} (${doc.count} issues)`);
  return ISSUE_HANDOFF_REPORT_PATH;
}

/**
 * A code folder's two undated night files: the codebase map and the issues
 * for another app. One call from the night work, each failing on its own.
 */
export async function writeNightlyCodeFolderFiles(
  deps: IssueHandoffDocumentDeps & CodebaseMapDeps,
  projectId: string,
  now: Date,
): Promise<void> {
  await writeCodebaseMap(deps, projectId, now).catch((err) =>
    log.warn(`[index] codebase map failed for ${projectId}: ${String(err)}`),
  );
  await writeIssueHandoffReport(deps, projectId, now).catch((err) =>
    log.warn(`[issue-triage] issue handoff report failed for ${projectId}: ${String(err)}`),
  );
}
