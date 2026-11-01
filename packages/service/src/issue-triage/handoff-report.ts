import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type IssueHandoffDocumentResponse,
  type IssueHandoffRequest,
  type IssueHandoffResponse,
  type IssueHandoffSnippet,
  createLogger,
  issueHandoffContent,
  issueHandoffRefs,
  issueHandoffSnippet,
  parseIssueHandoffResponses,
  renderIssueHandoff,
  summaryLead,
} from '@bendyline/gezel';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { Store } from '../fs/store.js';
import { type CodebaseMapDeps, writeCodebaseMap } from '../index-store/codebase-map.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { type IssueHandoffDeps, buildIssueHandoffQueue } from './queue.js';

const log = createLogger('issue-triage');

export const ISSUE_HANDOFF_REPORT_PATH = 'reports/issue-handoff.md';
/** Larger files are generated or data; an excerpt of one helps nobody. */
const MAX_EXCERPT_FILE_BYTES = 2 * 1024 * 1024;

export interface IssueHandoffDocumentDeps extends IssueHandoffDeps {
  contentIndex: IssueHandoffDeps['contentIndex'] & Pick<ContentIndex, 'fileSummary'>;
  store: IssueHandoffDeps['store'] &
    Pick<
      Store,
      | 'getProject'
      | 'listProjectBoekwachterIssues'
      | 'projectWorkspaceDir'
      | 'readProjectArtifact'
      | 'writeProjectArtifact'
    >;
}

/**
 * The handoff document for a project: the next batch of issues as markdown
 * with a response block under each. Built for the person, so it leases
 * nothing; an app that wants issues held for it uses the tools. `keep` is
 * the batch a document already lists (see `buildIssueHandoffQueue`).
 */
export async function buildIssueHandoffDocument(
  deps: IssueHandoffDocumentDeps,
  projectId: string,
  req: IssueHandoffRequest,
  opts: { now?: Date; keep?: readonly string[] } = {},
): Promise<IssueHandoffDocumentResponse> {
  const now = opts.now ?? new Date();
  const [queue, project, workspaceDir] = await Promise.all([
    buildIssueHandoffQueue(deps, projectId, req, opts.keep ? { keep: opts.keep } : {}),
    deps.store.getProject(projectId),
    deps.store.projectWorkspaceDir(projectId).catch(() => null),
  ]);
  const [snippets, fileSummaries] = await Promise.all([
    workspaceDir ? readExcerpts(workspaceDir, queue) : new Map<string, IssueHandoffSnippet>(),
    readFileSummaries(deps, projectId, queue),
  ]);
  const markdown = renderIssueHandoff(queue, {
    projectId,
    projectName: project?.name ?? projectId,
    generatedAt: now.toISOString(),
    absolutePath: (rel) => (workspaceDir ? join(workspaceDir, rel) : rel),
    snippets,
    fileSummaries,
  });
  return { markdown, count: queue.count, remaining: queue.remaining };
}

/**
 * The code at each issue's line, read once per file. A stale issue gets none:
 * its line has moved, and the wrong code is worse than no code.
 */
async function readExcerpts(
  workspaceDir: string,
  queue: IssueHandoffResponse,
): Promise<Map<string, IssueHandoffSnippet>> {
  const out = new Map<string, IssueHandoffSnippet>();
  for (const file of queue.files) {
    const wanted = file.issues.filter((i) => i.line !== undefined && !i.stale);
    if (wanted.length === 0) continue;
    const text = await readWorkspaceText(workspaceDir, file.path);
    if (text === null) continue;
    for (const issue of wanted) {
      const snippet = issueHandoffSnippet(text, issue.line!);
      if (snippet) out.set(issue.ref, snippet);
    }
  }
  return out;
}

async function readWorkspaceText(workspaceDir: string, relPath: string): Promise<string | null> {
  const full = safeJoin(workspaceDir, relPath);
  if (!full || !(await realpathContained(workspaceDir, full).catch(() => false))) return null;
  try {
    if ((await stat(full)).size > MAX_EXCERPT_FILE_BYTES) return null;
    const text = await readFile(full, 'utf8');
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

/** One line per file on what it is for, from the index's summary. */
async function readFileSummaries(
  deps: IssueHandoffDocumentDeps,
  projectId: string,
  queue: IssueHandoffResponse,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of queue.files) {
    try {
      const summary = await deps.contentIndex.fileSummary(projectId, file.path);
      const lead = summary ? firstSentenceOf(summary) : '';
      if (lead) out.set(file.path, lead);
    } catch {
      // A summary is context, never a reason to fail the document.
    }
  }
  return out;
}

/** A heading's worth of a summary: its first sentence, as plain text. */
function firstSentenceOf(summary: string): string {
  const paragraph = summaryLead(summary, 1000);
  return summaryLead(/^[\s\S]*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph, 200);
}

export interface IssueHandoffReportWrite {
  /** The document on disk, whether or not this call wrote it; null when there is none. */
  path: string | null;
  wrote: boolean;
  /** Answers in the document Gezel has not recorded; while there are any, it is left as it is. */
  unimportedAnswers?: number;
}

/**
 * The night's `reports/issue-handoff.md`, so a person can hand the list to
 * any app in the morning. It keeps the issues it lists until they are
 * settled, so it changes only when one of them does. It is never rewritten
 * while it holds answers Gezel has not recorded: an app may have filled it
 * in place, and a new batch would throw that work away. Nothing is written
 * for a project with no open issues.
 */
export async function writeIssueHandoffReport(
  deps: IssueHandoffDocumentDeps,
  projectId: string,
  now: Date,
): Promise<IssueHandoffReportWrite> {
  const previous = await deps.store
    .readProjectArtifact(projectId, ISSUE_HANDOFF_REPORT_PATH)
    .catch(() => null);
  if (previous !== null) {
    const unimportedAnswers = await countUnimportedAnswers(deps, projectId, previous);
    if (unimportedAnswers > 0) {
      log.info(
        `[issue-triage] ${projectId}: left ${ISSUE_HANDOFF_REPORT_PATH} as it is (${unimportedAnswers} answers not imported yet)`,
      );
      return { path: ISSUE_HANDOFF_REPORT_PATH, wrote: false, unimportedAnswers };
    }
  }
  const doc = await buildIssueHandoffDocument(
    deps,
    projectId,
    {},
    {
      now,
      keep: previous === null ? [] : issueHandoffRefs(previous),
    },
  );
  const existing = previous === null ? null : ISSUE_HANDOFF_REPORT_PATH;
  if (doc.count === 0) return { path: existing, wrote: false };
  if (previous !== null && issueHandoffContent(previous) === issueHandoffContent(doc.markdown)) {
    return { path: existing, wrote: false };
  }
  await deps.store.writeProjectArtifact(projectId, ISSUE_HANDOFF_REPORT_PATH, doc.markdown);
  log.info(`[issue-triage] ${projectId}: wrote ${ISSUE_HANDOFF_REPORT_PATH} (${doc.count} issues)`);
  return { path: ISSUE_HANDOFF_REPORT_PATH, wrote: true };
}

/**
 * Answers filled into a handoff document that Gezel has not recorded: the
 * verdict log has no entry with that issue, verdict and note. An answer an
 * import would refuse (an issue that no longer exists, or a duplicate of
 * one) never counts, so it cannot hold the document for good.
 */
export async function countUnimportedAnswers(
  deps: { store: Pick<Store, 'boekwachterIssues' | 'listProjectBoekwachterIssues'> },
  projectId: string,
  markdown: string,
): Promise<number> {
  const { verdicts } = parseIssueHandoffResponses(markdown);
  if (verdicts.length === 0) return 0;
  const [records, logged] = await Promise.all([
    deps.store.listProjectBoekwachterIssues(projectId),
    deps.store.boekwachterIssues.readIssueVerdicts(projectId),
  ]);
  const known = new Set(records.map((r) => r.ref));
  const key = (ref: string, kind: string, note?: string) => `${ref} ${kind} ${note?.trim() ?? ''}`;
  const recorded = new Set(logged.map((e) => key(e.ref, e.kind, e.note)));
  return verdicts.filter(
    (v) =>
      known.has(v.ref) &&
      (v.kind !== 'duplicate' || (v.duplicateOf !== undefined && known.has(v.duplicateOf))) &&
      !recorded.has(key(v.ref, v.kind, v.note)),
  ).length;
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
