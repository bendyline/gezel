import {
  type FolderKind,
  NIGHT_WORK_ARMED_AT_PROPERTY,
  NIGHT_WORK_PROPERTY,
  type ProviderName,
  type SuggestedWorkItem,
  createLogger,
  folderKindOf,
  isLocalProvider,
  projectNightWorkEnabled,
} from '@bendyline/gezel';
import { type SuggestedWorkDeps, enableSuggestedWork } from './enable.js';
import { resolveSuggestedWork } from './resolve.js';

const log = createLogger('suggested-work');

/**
 * Night books a folder of each kind gets switched on when the person adds it.
 * Report- and proposal-only: every change to a person's files arrives as a
 * proposal they apply, so a book that edits the workspace (bug-fix-tdd) is
 * never armed. `nightly-fix-sweep` is absent on purpose: the night-fix
 * planner already runs it. Ids not yet in the catalog are inert.
 */
const ARMABLE_BY_KIND: Record<FolderKind, ReadonlySet<string>> = {
  code: new Set([
    'codebase-refactoring-review',
    'dependency-audit',
    'security-architecture-review',
    'test-coverage-review',
  ]),
  pictures: new Set(['photo-library-nightly']),
  documents: new Set(['library-digest', 'document-deadlines']),
  mixed: new Set(),
};

export interface ArmNightWorkDeps extends SuggestedWorkDeps {
  /** Night-aware provider resolution (`chat.providerForGezel`). */
  providerForGezel: (gezelId: string, opts?: { nightShift?: boolean }) => Promise<ProviderName>;
}

export interface ArmNightWorkResult {
  armed: SuggestedWorkItem[];
  /** Fits the folder but runs on a cloud provider: sent off the machine, so the person decides. */
  needsOk: SuggestedWorkItem[];
  skipped?: 'already-armed' | 'switched-off' | 'no-kind';
}

/**
 * Switch on a just-added folder's resident night work: the roster's
 * night-shift suggestions that suit the folder's kind. The add-folder sheet
 * and onboarding list exactly this before the person confirms, so their
 * click is the consent `enableSuggestedWork` documents. Work whose gezel runs
 * on a cloud provider is returned as `needsOk` instead of armed. Runs once
 * per project; a host the person later pauses stays paused.
 */
export async function armResidentNightWork(
  deps: ArmNightWorkDeps,
  projectId: string,
): Promise<ArmNightWorkResult> {
  const project = await deps.store.getProject(projectId);
  if (!project) return { armed: [], needsOk: [], skipped: 'no-kind' };
  if (project.properties?.[NIGHT_WORK_ARMED_AT_PROPERTY]) {
    return { armed: [], needsOk: [], skipped: 'already-armed' };
  }
  if (!projectNightWorkEnabled(project)) {
    return { armed: [], needsOk: [], skipped: 'switched-off' };
  }
  const kind = folderKindOf(project);
  if (!kind) return { armed: [], needsOk: [], skipped: 'no-kind' };

  const armable = ARMABLE_BY_KIND[kind];
  const candidates = (await resolveSuggestedWork(deps, projectId)).filter(
    (item) =>
      item.runMode === 'night-shift' &&
      item.source.kind === 'gezel-template' &&
      !item.taskRef &&
      item.state !== 'dismissed' &&
      armable.has(item.craftbookId),
  );
  const armed: SuggestedWorkItem[] = [];
  const needsOk: SuggestedWorkItem[] = [];
  for (const item of candidates) {
    const gezelId = item.source.kind === 'gezel-template' ? item.source.gezelId : undefined;
    const provider = gezelId
      ? await deps.providerForGezel(gezelId, { nightShift: true }).catch(() => null)
      : null;
    if (!provider || !isLocalProvider(provider)) {
      needsOk.push(item);
      continue;
    }
    try {
      armed.push((await enableSuggestedWork(deps, { projectId, key: item.key })).item);
    } catch (err) {
      log.warn(`[suggested-work] ${projectId}: could not arm ${item.key}: ${String(err)}`);
    }
  }
  await deps.store.updateProject(projectId, {
    properties: { [NIGHT_WORK_ARMED_AT_PROPERTY]: new Date().toISOString() },
  });
  if (armed.length > 0) {
    log.info(`[suggested-work] ${projectId}: armed ${armed.map((i) => i.craftbookId).join(', ')}`);
  }
  return { armed, needsOk };
}

/** The night books a folder of this kind may have switched on when added. */
export function armableNightBooks(kind: FolderKind): ReadonlySet<string> {
  return ARMABLE_BY_KIND[kind];
}

/**
 * The folder's "Work on this folder overnight" switch. Off stands the nightly
 * sweep and fix planning down for the folder (`projectNightWorkEnabled`) and
 * pauses its active night hosts; on resumes exactly the hosts the switch
 * paused, so a host the person paused by hand stays paused.
 */
export async function setFolderNightWork(
  deps: Pick<SuggestedWorkDeps, 'store' | 'tasks'>,
  projectId: string,
  enabled: boolean,
): Promise<void> {
  const project = await deps.store.getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const hosts = (await deps.store.listProjectTasks(projectId).catch(() => [])).filter(
    (t) => t.nightShift?.enabled === true && Boolean(t.spawnsCraftbook),
  );
  if (!enabled) {
    const paused: number[] = [];
    for (const host of hosts) {
      if (host.status !== 'active') continue;
      await deps.tasks.setStatus(projectId, host.num, 'paused');
      paused.push(host.num);
    }
    await deps.store.updateProject(projectId, {
      properties: { [NIGHT_WORK_PROPERTY]: 'off', [NIGHT_WORK_PAUSED_PROPERTY]: paused.join(',') },
    });
    return;
  }
  const pausedBySwitch = new Set(
    (project.properties?.[NIGHT_WORK_PAUSED_PROPERTY] ?? '').split(',').filter(Boolean).map(Number),
  );
  for (const host of hosts) {
    if (host.status === 'paused' && pausedBySwitch.has(host.num)) {
      await deps.tasks.setStatus(projectId, host.num, 'active');
    }
  }
  // An empty value removes the property.
  await deps.store.updateProject(projectId, {
    properties: { [NIGHT_WORK_PROPERTY]: '', [NIGHT_WORK_PAUSED_PROPERTY]: '' },
  });
}

/** Night hosts the switch paused, so switching back on resumes only those. */
const NIGHT_WORK_PAUSED_PROPERTY = 'gezel.nightWorkPausedHosts';
