import {
  FOLDER_KIND_PROPERTY,
  type GenerateProjectReportResponse,
  type ProjectReport,
  type ProjectReportsResponse,
  type WritableReportKind,
  findFirstH1,
  isCodingProject,
  isSharedLibraryProject,
  parseReportActions,
} from '@bendyline/gezel';
import type { DiffpackManager } from '../diffpack/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { CODEBASE_MAP_PATH, writeCodebaseMap } from '../index-store/codebase-map.js';
import { writeNightlyCodebaseReport } from '../index-store/codebase-report.js';
import { writeNightlyDocumentsReport } from '../index-store/documents-report.js';
import { MIN_PHOTOS, writeNightlyPhotoReport } from '../index-store/photo-report.js';
import type { Store } from '../fs/store.js';
import {
  ISSUE_HANDOFF_REPORT_PATH,
  writeIssueHandoffReport,
} from '../issue-triage/handoff-report.js';
import { isNightShiftReportArchive } from '../meester/night-shift-oversight.js';
import { isReportShaped, reportKindOf } from './report-paths.js';

/** Reports read per listing; older ones are still in the artifacts drawer. */
const LIST_LIMIT = 200;

export interface ProjectReportDeps {
  store: Store;
  contentIndex: ContentIndex;
  diffpacks: DiffpackManager;
}

/**
 * Every report-shaped markdown file in the project's artifacts drawer,
 * newest first: the nightly reports, the codebase map, code reviews, digests
 * and any report a task wrote. The night review's dated copies of earlier
 * mornings are left out — they repeat reports already listed.
 */
export async function listProjectReports(
  deps: ProjectReportDeps,
  projectId: string,
): Promise<ProjectReportsResponse> {
  const files = await deps.store
    .listProjectArtifactsRecursive(projectId, { withStats: true })
    .catch(() => []);
  const candidates = files
    .filter(
      (f) =>
        !f.isDirectory &&
        isReportShaped(f.path) &&
        !isNightShiftReportArchive(projectId, f.path),
    )
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || (a.path < b.path ? -1 : 1));
  const reports: ProjectReport[] = [];
  for (const file of candidates.slice(0, LIST_LIMIT)) {
    const content = await deps.store.readProjectArtifact(projectId, file.path).catch(() => null);
    if (content === null) continue;
    reports.push({
      path: file.path,
      title:
        findFirstH1(content.split('\n'))?.title ?? file.path.slice(file.path.lastIndexOf('/') + 1),
      kind: reportKindOf(file.path),
      mtimeMs: file.mtimeMs ?? 0,
      size: content.length,
      actions: parseReportActions(content).actions.length,
    });
  }
  return {
    reports,
    writable: await writableReports(deps, projectId),
    truncated: candidates.length > LIST_LIMIT,
  };
}

/** The reports this folder suits, by the same rules each writer applies. */
export async function writableReports(
  deps: ProjectReportDeps,
  projectId: string,
): Promise<WritableReportKind[]> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project || isSharedLibraryProject(project)) return [];
  const kind = project.properties?.[FOLDER_KIND_PROPERTY];
  const out: WritableReportKind[] = [];
  if (kind === 'code' || (kind === undefined && isCodingProject(project))) out.push('codebase', 'map', 'issues');
  if (project.workingDir && (kind === 'documents' || kind === 'mixed')) out.push('documents');
  const overview = await deps.contentIndex.overview(projectId).catch(() => null);
  if (kind !== 'code' && (overview?.byModality.image ?? 0) >= MIN_PHOTOS) out.push('photos');
  return out;
}

/**
 * Write one report now, replacing today's if there is one. Model-free, so it
 * costs nothing and runs anywhere. A report with nothing to say writes
 * nothing; that is an answer, not an error.
 */
export async function generateProjectReport(
  deps: ProjectReportDeps,
  projectId: string,
  kind: WritableReportKind,
  now: Date,
): Promise<GenerateProjectReportResponse> {
  const force = { force: true };
  switch (kind) {
    case 'codebase': {
      const path = await writeNightlyCodebaseReport(deps, projectId, now, undefined, force);
      return { path, wrote: path !== null };
    }
    case 'documents': {
      const path = await writeNightlyDocumentsReport(deps, projectId, now, undefined, force);
      return { path, wrote: path !== null };
    }
    case 'photos': {
      const path = await writeNightlyPhotoReport(deps, projectId, now, undefined, force);
      return { path, wrote: path !== null };
    }
    case 'map': {
      const path = await writeCodebaseMap(deps, projectId, now);
      if (path) return { path, wrote: true };
      // Unchanged since it was last written: the existing map is the answer.
      const existing = await deps.store
        .readProjectArtifact(projectId, CODEBASE_MAP_PATH)
        .catch(() => null);
      return { path: existing === null ? null : CODEBASE_MAP_PATH, wrote: false };
    }
    case 'issues': {
      const path = await writeIssueHandoffReport(deps, projectId, now);
      if (path) return { path, wrote: true };
      const existing = await deps.store
        .readProjectArtifact(projectId, ISSUE_HANDOFF_REPORT_PATH)
        .catch(() => null);
      return { path: existing === null ? null : ISSUE_HANDOFF_REPORT_PATH, wrote: false };
    }
  }
}
