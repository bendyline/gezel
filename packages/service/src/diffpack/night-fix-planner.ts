import {
  type BoekwachterIssue,
  type NightShiftWindow,
  createLogger,
  isActiveDiffpackStatus,
  nightShiftDayKey,
  projectAllowsAmbientWork,
  projectAllowsNightlyFixes,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { resolveProjectBoekwachter, resolveProjectDeveloper } from '../gezels/autonomous-roles.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import type { TaskManager } from '../tasks/manager.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { DiffpackManager } from './manager.js';
import { FIX_CRAFTBOOK_ID, createNightFixTask } from './night-fix-task.js';

const log = createLogger('diffpack');

/**
 * How many open issues one project can hand a single night. Above this the
 * developer spends the whole window triaging instead of fixing, and the user
 * wakes to a review queue nobody will get through.
 */
export const MAX_ISSUES_PER_NIGHT = 40;

export interface NightFixPlannerDeps {
  store: Store;
  tasks: TaskManager;
  taskRunner: TaskRunner;
  contentIndex: ContentIndex;
  catalog: CatalogService;
  diffpacks: DiffpackManager;
  history?: HistoryManager;
  nightShiftWindow: () => NightShiftWindow;
  now?: () => Date;
}

export interface NightFixPlanResult {
  projectId: string;
  taskRef?: string;
  issueCount: number;
  /** Open issues the caps left behind, so a quiet truncation is never silent. */
  deferred: number;
  skipped?:
    | 'inactive'
    | 'opted-out'
    | 'indexing-off'
    | 'no-boekwachter'
    | 'no-developer'
    | 'nothing-open'
    | 'already-planned';
}

/**
 * Plan the night's bug fixing.
 *
 * Deterministic on purpose: enumerating open issues and deciding which
 * projects qualify is bookkeeping, and a model turn spent on bookkeeping is a
 * model turn not spent fixing anything. The gezel's judgement enters one step
 * later, when the developer decides how to CLUSTER the issues it has been
 * handed — which is the part that genuinely needs judgement, because a fix
 * often spans a file and its caller.
 *
 * The gate is crew composition, per the product rule that a role on the
 * roster is what switches autonomous work on: a Boekwachter (who found the
 * issues) plus a developer (who can fix them). Nothing recruits — conjuring
 * the gezel that unlocks the feature would make the gate meaningless.
 */
export async function planNightFixes(deps: NightFixPlannerDeps): Promise<NightFixPlanResult[]> {
  const projects = await deps.store.listProjects().catch(() => []);
  const out: NightFixPlanResult[] = [];
  for (const project of projects) {
    out.push(await planProjectNightFixes(deps, project.id));
  }
  const planned = out.filter((r) => r.taskRef);
  if (planned.length > 0) {
    log.info(
      `[diffpack] night fixing planned for ${planned.length} project(s): ${planned
        .map((r) => `${r.projectId} (${r.issueCount} issue(s))`)
        .join(', ')}`,
    );
  }
  return out;
}

export async function planProjectNightFixes(
  deps: NightFixPlannerDeps,
  projectId: string,
): Promise<NightFixPlanResult> {
  const now = deps.now?.() ?? new Date();
  const skip = (reason: NonNullable<NightFixPlanResult['skipped']>): NightFixPlanResult => ({
    projectId,
    issueCount: 0,
    deferred: 0,
    skipped: reason,
  });

  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return skip('inactive');
  if (!projectAllowsAmbientWork(project)) return skip('inactive');
  if (!projectAllowsNightlyFixes(project)) return skip('opted-out');
  if (project.indexingEnabled === false) return skip('indexing-off');

  const [boekwachter, developer] = await Promise.all([
    resolveProjectBoekwachter(deps.store, projectId),
    resolveProjectDeveloper(deps.store, projectId),
  ]);
  if (!boekwachter) return skip('no-boekwachter');
  if (!developer) return skip('no-developer');

  const dayKey = nightShiftDayKey(now, deps.nightShiftWindow());
  const existing = await deps.tasks.list({ projectId, status: 'active' }).catch(() => []);
  // One planning task per project per window. Re-entrancy matters: the
  // catch-up drain that triggers this can fire more than once a night (a
  // manual shift after a scheduled one), and a second host would re-claim
  // issues the first is already working.
  if (
    existing.some(
      (task) =>
        task.origin?.kind === 'boekwachter-issue' &&
        task.craftbook.id === FIX_CRAFTBOOK_ID &&
        task.nightShift?.enabled === true &&
        (task.nightShift.lastRunDay ?? dayKey) === dayKey,
    )
  ) {
    return skip('already-planned');
  }

  const claimed = await claimedPaths(deps, projectId);
  const open = await openIssuesForFixing(deps, projectId, claimed);
  if (open.selected.length === 0) return skip('nothing-open');

  const { task, gezelId } = await createNightFixTask(deps, {
    projectId,
    issues: open.selected,
    developerId: developer.id,
    developerName: developer.name,
    windowKey: dayKey,
  });

  // Claim the issues against this host so a re-plan, the "fix via AI" button,
  // and tomorrow night all see them as spoken for. Cancelling the task
  // reopens them through the existing settle hook.
  for (const issue of open.selected) {
    await deps.contentIndex
      .updateBoekwachterIssue(projectId, issue.ref, { status: 'in_progress', taskRef: task.ref })
      .catch((err) =>
        log.warn(`[diffpack] could not claim ${issue.ref} for ${task.ref}: ${String(err)}`),
      );
  }

  deps.history
    ?.log({
      kind: 'task.created',
      projectId,
      gezelId,
      summary: `Night fixing planned: ${open.selected.length} issue(s) for ${developer.name}`,
      details: {
        taskRef: task.ref,
        issueRefs: open.selected.map((i) => i.ref),
        deferred: open.deferred,
      },
    })
    .catch(() => {});

  await dispatchTaskEntry(
    { store: deps.store, taskRunner: deps.taskRunner, history: deps.history },
    task,
  );

  if (open.deferred > 0) {
    // Never let a cap read as "we covered everything".
    log.info(
      `[diffpack] ${projectId}: ${open.selected.length} issue(s) planned, ${open.deferred} deferred to a later night (cap ${MAX_ISSUES_PER_NIGHT})`,
    );
  }
  return {
    projectId,
    taskRef: task.ref,
    issueCount: open.selected.length,
    deferred: open.deferred,
  };
}

const SEVERITY_RANK: Record<string, number> = { major: 0, minor: 1, info: 2 };

/**
 * Open, non-stale issues worth handing a developer tonight, most serious
 * first and oldest-first within a severity.
 *
 * Stale issues are excluded rather than ranked last: their message and line
 * describe a version of the file that no longer exists, so a fix drafted from
 * them is guesswork. The Boekwachter re-reviews changed files anyway, which
 * is the honest way for them to come back.
 */
async function openIssuesForFixing(
  deps: NightFixPlannerDeps,
  projectId: string,
  claimedPaths: ReadonlySet<string>,
): Promise<{ selected: BoekwachterIssue[]; deferred: number }> {
  const listed = await deps.contentIndex
    .listFileIssues(projectId, { status: 'open', maxResults: 1000 })
    .catch(() => null);
  const eligible = (listed?.issues ?? [])
    .filter((issue) => !issue.stale && !issue.taskRef && !claimedPaths.has(issue.path))
    .sort((a, b) => {
      const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      return bySeverity !== 0 ? bySeverity : a.createdAt.localeCompare(b.createdAt);
    });
  return {
    selected: eligible.slice(0, MAX_ISSUES_PER_NIGHT),
    deferred: Math.max(0, eligible.length - MAX_ISSUES_PER_NIGHT),
  };
}

/**
 * Files an unapplied proposal already targets.
 *
 * Drafting a second proposal over the same file is legal — the review surface
 * reports the overlap and the loser reads back as drifted once the winner is
 * applied — but doing it on purpose, overnight, unprompted, would hand the
 * user two competing fixes and no way to tell which the gezel meant.
 */
async function claimedPaths(
  deps: NightFixPlannerDeps,
  projectId: string,
): Promise<ReadonlySet<string>> {
  const packs = await deps.diffpacks.list(projectId).catch(() => []);
  const out = new Set<string>();
  for (const pack of packs) {
    if (!isActiveDiffpackStatus(pack.status)) continue;
    for (const file of pack.files) out.add(file.path);
  }
  return out;
}
