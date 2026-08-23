import {
  type DiffpackSummary,
  type NightShiftCompletedTask,
  type NightShiftReport,
  type NightShiftReviewResponse,
  type NightShiftWindow,
  type Question,
  type Task,
  findFirstH1,
  isActiveDiffpackStatus,
  lastNightShiftWindow,
  parseReportActions,
} from '@bendyline/gezel';
import type { DiffpackManager } from '../diffpack/manager.js';
import type { Store } from '../fs/store.js';
import type { ReportActionManager } from '../report-actions/report-action-manager.js';
import type { TaskManager } from '../tasks/manager.js';

/**
 * The morning review: what the most recent night window accomplished.
 *
 * Built read-only from durable traces — no new bookkeeping:
 *   - tasks whose `nightShift.lastRunDay` equals the window key (the
 *     stamp both workable night tasks and spawn hosts carry), plus any
 *     task that COMPLETED inside the window;
 *   - report artifacts: declared step deliverables (`advanceWhen` with
 *     `artifact: true`) of those tasks, plus a bounded mtime sweep for
 *     markdown written during the window (`reports/**`, `*report*.md`);
 *   - each report parsed for gezel-action blocks + the lifecycle overlay
 *     for the action tally.
 *
 * Parse-per-request; the route is only hit on menu-open / Home load /
 * window close, over a handful of small files.
 */
export async function buildNightShiftReview(
  deps: {
    store: Store;
    tasks: TaskManager;
    reportActions: ReportActionManager;
    diffpacks: DiffpackManager;
  },
  window: NightShiftWindow,
  now: Date,
): Promise<NightShiftReviewResponse> {
  const { store, tasks, reportActions, diffpacks } = deps;
  const { key, start, end } = lastNightShiftWindow(now, window);
  const startMs = start.getTime();
  const endMs = end.getTime();

  const projects = await store.listProjects().catch(() => []);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  const tasksCompleted: NightShiftCompletedTask[] = [];
  const proposals: DiffpackSummary[] = [];
  const reportCandidates = new Map<string, Set<string>>(); // projectId → artifact paths

  const addCandidate = (projectId: string, path: string) => {
    let set = reportCandidates.get(projectId);
    if (!set) {
      set = new Set();
      reportCandidates.set(projectId, set);
    }
    set.add(path);
  };

  for (const project of projects) {
    const projectTasks = await store.listProjectTasks(project.id).catch(() => []);
    for (const task of projectTasks) {
      // Tasks carry no top-level completion stamp — the last completed
      // step's stamp is the closest truth, with `updatedAt` (written on
      // the status flip) as the fallback.
      const completedAt =
        task.craftbook.steps.reduce<string | undefined>(
          (latest, step) =>
            step.completedAt && (!latest || step.completedAt > latest) ? step.completedAt : latest,
          undefined,
        ) ?? (task.status === 'complete' ? task.updatedAt : undefined);
      const ranThisWindow = task.nightShift?.lastRunDay === key;
      const completedInWindow =
        task.status === 'complete' &&
        completedAt !== undefined &&
        Date.parse(completedAt) >= startMs &&
        Date.parse(completedAt) < endMs;
      if (!ranThisWindow && !completedInWindow) continue;

      // Spawn hosts stay active — list the WORK (children/workables), not
      // the host machinery.
      if (!task.spawnsCraftbook) {
        tasksCompleted.push({
          ref: task.ref,
          title: task.title,
          projectId: project.id,
          projectName: project.name,
          ...(completedAt ? { completedAt } : {}),
        });
      }
      for (const path of declaredArtifacts(task)) addCandidate(project.id, path);
    }

    // Change proposals still awaiting a decision. Listed by window key
    // rather than swept by mtime: a proposal drafted two nights ago and
    // never answered is still the first thing the user should see, and
    // dropping it out of the review would quietly lose a night's work.
    for (const pack of await diffpacks.list(project.id).catch(() => [])) {
      if (!isActiveDiffpackStatus(pack.status)) continue;
      proposals.push({
        packId: pack.packId,
        projectId: project.id,
        projectName: project.name,
        title: pack.title,
        status: pack.status,
        fileCount: pack.files.length,
        additions: pack.additions,
        deletions: pack.deletions,
        issueRefs: pack.origin.kind === 'boekwachter-issue' ? pack.origin.issueRefs : [],
        drifted: pack.drifted.length > 0,
      });
    }

    // Mtime sweep: report-shaped markdown written during the window.
    const files = await store
      .listProjectArtifactsRecursive(project.id, { withStats: true })
      .catch(() => []);
    for (const file of files) {
      if (file.isDirectory || file.mtimeMs === undefined) continue;
      if (file.mtimeMs < startMs || file.mtimeMs >= endMs) continue;
      if (!isReportShaped(file.path)) continue;
      addCandidate(project.id, file.path);
    }
  }

  const reports: NightShiftReport[] = [];
  for (const [projectId, paths] of reportCandidates) {
    for (const path of paths) {
      const content = await store.readProjectArtifact(projectId, path).catch(() => null);
      if (content === null) continue;
      const title = findFirstH1(content.split('\n'))?.title ?? path.split('/').pop() ?? path;
      const counts = { total: 0, suggested: 0, fired: 0, applied: 0, dismissed: 0 };
      if (parseReportActions(content).actions.length > 0) {
        const overlay = await reportActions.listForReport(projectId, path).catch(() => null);
        for (const view of overlay?.actions ?? []) {
          counts.total++;
          if (view.state === 'suggested') counts.suggested++;
          else if (view.state === 'fired') counts.fired++;
          else if (view.state === 'applied') counts.applied++;
          else if (view.state === 'dismissed') counts.dismissed++;
        }
      }
      reports.push({
        projectId,
        projectName: projectNames.get(projectId) ?? projectId,
        path,
        title,
        actionCounts: counts,
      });
    }
  }
  reports.sort((a, b) => b.actionCounts.total - a.actionCounts.total);
  // Ready before still-drafting — a proposal you can act on outranks one that
  // is not finished — then largest first, since the biggest change is the one
  // most worth reading before it lands.
  proposals.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ready' ? -1 : 1;
    return b.fileCount - a.fileCount;
  });
  tasksCompleted.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  return {
    windowKey: key,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    tasksCompleted,
    reports,
    diffpacks: proposals,
  };
}

export function nightShiftReportAttachmentPath(
  report: Pick<NightShiftReport, 'projectId' | 'path'>,
): string {
  return `projects/${report.projectId}/artifacts/${report.path}`;
}

export function normalizeNightShiftReportAttachment(question: Question): Question {
  const report = question.intent?.kind === 'night-shift-review' ? question.intent.reports[0] : null;
  if (!report) return question;
  const documentPath = nightShiftReportAttachmentPath(report);
  return question.documentPath === documentPath ? question : { ...question, documentPath };
}

/** Artifact paths a task's embedded craftbook declares as deliverables. */
function declaredArtifacts(task: Task): string[] {
  const out: string[] = [];
  for (const step of task.craftbook.steps) {
    const aw = step.advanceWhen;
    if (aw?.artifact && aw.file && !aw.file.includes('{{')) out.push(aw.file);
  }
  return out;
}

/** Markdown that reads as a report: under reports/, or *report*.md, or digest. */
function isReportShaped(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md')) return false;
  return (
    lower.startsWith('reports/') ||
    lower.includes('/reports/') ||
    lower.includes('report') ||
    lower.includes('digest')
  );
}
