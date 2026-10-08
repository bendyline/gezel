import { type DiffpackRecord, type Task, createLogger } from '@bendyline/gezel';

const log = createLogger('diffpack');

/**
 * Boekwachter issues follow the proposal that would fix them, not the task
 * that drafted it. A drafting task finishing means a fix was *proposed*; the
 * issue resolves when the person applies the file it sits on, and goes back
 * to open when no live proposal covers it (nothing was drafted for it, or the
 * proposal was dismissed). The link is the file path: proposals record only
 * the first issue that seeded them, but an applied fix always touches the
 * file its issue is on.
 */
export interface ProposalIssueDeps {
  store: {
    settleProjectBoekwachterIssuesForProposal(
      id: string,
      taskRefs: readonly string[],
      change: { resolvePaths?: readonly string[]; reopenUnless?: ReadonlySet<string> },
    ): Promise<{ resolved: number; reopened: number }>;
  };
  diffpacks: { list(projectId: string): Promise<DiffpackRecord[]> };
  tasks: { getByRef?(ref: string): Promise<Task | null> };
}

/** Packs that still hold a claim: waiting for review, or partly applied. */
function live(pack: DiffpackRecord): boolean {
  return pack.status === 'ready' || pack.status === 'partially-applied';
}

/** The drafting family a pack belongs to: its own task and the host that spawned it. */
async function familyOf(deps: ProposalIssueDeps, taskRef: string): Promise<string[]> {
  const task = await deps.tasks.getByRef?.(taskRef).catch(() => null);
  return task?.parentTaskRef ? [taskRef, task.parentTaskRef] : [taskRef];
}

/** Paths the family's live proposals still offer to change. */
async function coveredPaths(
  deps: ProposalIssueDeps,
  projectId: string,
  family: readonly string[],
  except?: string,
): Promise<Set<string>> {
  const members = new Set(family);
  const covered = new Set<string>();
  for (const pack of await deps.diffpacks.list(projectId)) {
    if (pack.packId === except || !live(pack)) continue;
    const owner = await familyOf(deps, pack.taskRef);
    if (!owner.some((ref) => members.has(ref))) continue;
    const applied = new Set(pack.results?.filter((r) => r.ok).map((r) => r.path));
    for (const file of pack.files) if (!applied.has(file.path)) covered.add(file.path);
  }
  return covered;
}

/**
 * A drafting task completed: its issues stay in progress while a proposal
 * covers their file, and reopen otherwise. Run after its packs are sealed.
 */
export async function settleIssuesForDraftingTask(
  deps: ProposalIssueDeps,
  projectId: string,
  taskRef: string,
): Promise<void> {
  const family = await familyOf(deps, taskRef);
  const covered = await coveredPaths(deps, projectId, family);
  const res = await deps.store.settleProjectBoekwachterIssuesForProposal(projectId, [taskRef], {
    reopenUnless: covered,
  });
  if (res.reopened > 0) {
    log.info(`[diffpack] ${taskRef}: ${res.reopened} issue(s) reopened — no proposal covers them`);
  }
}

/** The person applied files from a proposal: the issues on those files are fixed. */
export async function resolveIssuesForAppliedFiles(
  deps: ProposalIssueDeps,
  projectId: string,
  pack: DiffpackRecord,
  appliedPaths: readonly string[],
): Promise<void> {
  if (appliedPaths.length === 0) return;
  const family = await familyOf(deps, pack.taskRef);
  const res = await deps.store.settleProjectBoekwachterIssuesForProposal(projectId, family, {
    resolvePaths: appliedPaths,
  });
  if (res.resolved > 0) {
    log.info(`[diffpack] DP-${pack.packId}: ${res.resolved} issue(s) resolved by the apply`);
  }
}

/**
 * The person dismissed a proposal: its issues reopen unless another live
 * proposal from the same run covers their file. While the run is still
 * drafting, its completion settles them instead.
 */
export async function reopenIssuesForDismissedPack(
  deps: ProposalIssueDeps,
  projectId: string,
  pack: DiffpackRecord,
): Promise<void> {
  const family = await familyOf(deps, pack.taskRef);
  const members = new Set(family);
  for (const other of await deps.diffpacks.list(projectId)) {
    if (other.packId === pack.packId || other.status !== 'drafting') continue;
    if ((await familyOf(deps, other.taskRef)).some((ref) => members.has(ref))) return;
  }
  const covered = await coveredPaths(deps, projectId, family, pack.packId);
  const res = await deps.store.settleProjectBoekwachterIssuesForProposal(projectId, family, {
    reopenUnless: covered,
  });
  if (res.reopened > 0) {
    log.info(`[diffpack] DP-${pack.packId} dismissed: ${res.reopened} issue(s) reopened`);
  }
}
