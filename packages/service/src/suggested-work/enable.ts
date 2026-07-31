import {
  type Question,
  type SuggestedWorkItem,
  type Task,
  createLogger,
  nowIso,
  parseTaskRef,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  SCHEDULE_HOST_STEP,
  describeHostCadence,
  hostRecurrenceFields,
} from '../tasks/schedule-host.js';
import { originKey, resolveSuggestedWork } from './resolve.js';

const log = createLogger('suggested-work');

export interface SuggestedWorkDeps {
  store: Store;
  catalog: CatalogService;
  tasks: TaskManager;
  /** For collapsing a pending schedule-approval card when the toggle answers it. */
  chatEvents?: ChatEventBus;
  history?: HistoryManager;
}

/**
 * Enable a suggested-work item: resurrect its paused host when one
 * exists (the enable/disable toggle is pause/reactivate, so the user's
 * cron state and run history survive), otherwise materialize a fresh
 * origin-stamped host. The toggle IS the consent — hosts created here
 * start active, and any pending schedule-approval question on the host
 * is answered as approved so the card collapses everywhere.
 */
export async function enableSuggestedWork(
  deps: SuggestedWorkDeps,
  args: { projectId: string; key: string; params?: Record<string, string> },
): Promise<{ item: SuggestedWorkItem; task: Task }> {
  const { store, tasks } = deps;
  const { projectId, key } = args;
  const items = await resolveSuggestedWork(deps, projectId);
  const item = items.find((i) => i.key === key);
  if (!item) throw new Error(`unknown suggested-work key: ${key}`);

  let host: Task | null = null;
  if (item.taskRef) {
    host = await reactivateHost(deps, projectId, item, args.params);
  } else {
    // A live host for the same craftbook + runMode under a different
    // origin (e.g. the user built it by hand, or the other source got
    // there first) — adopt it rather than double-scheduling the work.
    const existing = (await store.listProjectTasks(projectId).catch(() => [])).find(
      (t) =>
        t.status === 'active' &&
        t.spawnsCraftbook?.id === item.craftbookId &&
        Boolean(t.nightShift?.enabled) === (item.runMode === 'night-shift'),
    );
    if (existing) {
      log.info(
        `[suggested-work] ${key}: adopting existing host ${existing.ref} for '${item.craftbookId}'`,
      );
      host = existing;
    } else {
      host = await createHost(deps, projectId, item, args.params);
    }
  }

  await store.setSuggestedWorkDismissed(projectId, key, false).catch(() => {});
  await deps.history?.log({
    kind: 'project.suggested-work.enabled',
    projectId,
    ...(item.source.kind === 'gezel-template' && item.source.gezelId
      ? { gezelId: item.source.gezelId }
      : {}),
    summary: `Enabled suggested work "${item.craftbookName ?? item.craftbookId}" (${item.runMode})`,
    details: { key, craftbookId: item.craftbookId, runMode: item.runMode, taskRef: host.ref },
  });

  return {
    item: { ...item, state: 'enabled', taskRef: host.ref },
    task: host,
  };
}

/**
 * Disable = pause the host (decision + history preserved; re-enable
 * resurrects it). A pending approval question is answered as declined so
 * the toggle and the question card never disagree.
 */
export async function disableSuggestedWork(
  deps: SuggestedWorkDeps,
  args: { projectId: string; key: string },
): Promise<SuggestedWorkItem> {
  const { projectId, key } = args;
  const items = await resolveSuggestedWork(deps, projectId);
  const item = items.find((i) => i.key === key);
  if (!item) throw new Error(`unknown suggested-work key: ${key}`);
  if (!item.taskRef) return item;

  const ref = parseTaskRef(item.taskRef);
  if (ref) {
    const host = await deps.tasks.getByRef(item.taskRef);
    if (host && host.status === 'active') {
      await deps.tasks.setStatus(ref.projectId, ref.num, 'paused');
    }
  }
  if (item.pendingQuestionId) {
    await answerPendingApproval(deps, projectId, item.pendingQuestionId, false);
  }
  await deps.history?.log({
    kind: 'project.suggested-work.disabled',
    projectId,
    summary: `Disabled suggested work "${item.craftbookName ?? item.craftbookId}" (${item.runMode})`,
    details: { key, craftbookId: item.craftbookId, runMode: item.runMode, taskRef: item.taskRef },
  });
  return { ...item, state: 'paused' };
}

export async function dismissSuggestedWork(
  deps: SuggestedWorkDeps,
  args: { projectId: string; key: string; dismissed: boolean },
): Promise<void> {
  await deps.store.setSuggestedWorkDismissed(args.projectId, args.key, args.dismissed);
}

async function reactivateHost(
  deps: SuggestedWorkDeps,
  projectId: string,
  item: SuggestedWorkItem,
  params: Record<string, string> | undefined,
): Promise<Task> {
  const { tasks } = deps;
  if (!item.taskRef) throw new Error('reactivateHost requires a taskRef');
  const ref = parseTaskRef(item.taskRef);
  const host = ref ? await tasks.getByRef(item.taskRef) : null;
  if (!ref || !host) throw new Error(`suggested-work host ${item.taskRef} not found`);
  // Re-write the cron before activating so `nextTickAt` re-derives from
  // NOW — the stale paused-era deadline would otherwise fire immediately
  // (same pattern as the schedule-approval answer route).
  if (host.cron) {
    await tasks.update(ref.projectId, ref.num, {
      cron: {
        expression: host.cron.expression,
        ...(host.cron.overlap ? { overlap: host.cron.overlap } : {}),
      },
      ...(params ? { spawnsCraftbookParams: params } : {}),
    });
  } else if (params) {
    await tasks.update(ref.projectId, ref.num, { spawnsCraftbookParams: params });
  }
  if (host.status !== 'active') {
    await tasks.setStatus(ref.projectId, ref.num, 'active');
  }
  if (item.pendingQuestionId) {
    await answerPendingApproval(deps, projectId, item.pendingQuestionId, true);
  }
  const fresh = await tasks.getByRef(item.taskRef);
  return fresh ?? host;
}

async function createHost(
  deps: SuggestedWorkDeps,
  projectId: string,
  item: SuggestedWorkItem,
  params: Record<string, string> | undefined,
): Promise<Task> {
  const { store, tasks } = deps;
  const project = await store.getProject(projectId);
  const sponsorGezelId =
    item.source.kind === 'gezel-template' ? item.source.gezelId : undefined;
  const assigneeGezelId = sponsorGezelId ?? project?.voormanGezelId;
  const sponsorLabel =
    item.source.kind === 'gezel-template'
      ? item.source.gezelName
        ? `${item.source.gezelName} (${item.source.role ?? 'gezel'})`
        : `the "${item.source.templateId}" role`
      : `the "${item.source.typeId}" project type`;
  const bookLabel = item.craftbookName ?? item.craftbookId;
  const mergedParams = { ...(item.params ?? {}), ...(params ?? {}) };
  const origin =
    item.source.kind === 'gezel-template'
      ? {
          kind: 'gezel-suggested-craftbook' as const,
          templateId: item.source.templateId,
          suggestionKey: suggestionKeyFromItemKey(item.key),
        }
      : {
          kind: 'project-type-schedule' as const,
          typeId: item.source.typeId,
          scheduleKey: item.source.scheduleKey,
        };

  const host = await tasks.create(
    projectId,
    {
      title:
        item.runMode === 'night-shift' ? `Night shift: ${bookLabel}` : `Schedule: ${bookLabel}`,
      description: `Recurring craftbook run suggested by ${sponsorLabel} and enabled by the user. ${describeHostCadence(item)} Each fire spawns a "${item.craftbookId}" child task; this host never runs steps itself.`,
      assignee: assigneeGezelId ? { kind: 'gezel', gezelId: assigneeGezelId } : { kind: 'user' },
      steps: [{ ...SCHEDULE_HOST_STEP }],
      spawnsCraftbookId: item.craftbookId,
      ...(Object.keys(mergedParams).length > 0 ? { spawnsCraftbookParams: mergedParams } : {}),
      ...hostRecurrenceFields(item),
      createdBy: { kind: 'user' },
    },
    { origin },
  );
  if (originKey(host) !== item.key) {
    // Origin/key derivations drifted apart — surface loudly in dev.
    log.warn(`[suggested-work] created host ${host.ref} origin does not round-trip key ${item.key}`);
  }
  return host;
}

function suggestionKeyFromItemKey(key: string): string {
  // `gezel-template:<templateId>:<suggestionKey>` — ids never contain ':'.
  const parts = key.split(':');
  return parts.slice(2).join(':');
}

/** Answer a pending schedule-approval question so its card collapses. */
async function answerPendingApproval(
  deps: SuggestedWorkDeps,
  projectId: string,
  questionId: string,
  approved: boolean,
): Promise<void> {
  const { store, chatEvents } = deps;
  const questions = await store.listProjectQuestions(projectId).catch(() => []);
  const question = questions.find((q) => q.id === questionId);
  if (!question || question.answer) return;
  const answered: Question = {
    ...question,
    answer: approved ? { selectedChoices: [0], at: nowIso() } : { declined: true, at: nowIso() },
  };
  await store.writeQuestion(answered);
  chatEvents?.publish(
    {
      sessionId: answered.sessionId,
      gezelId: answered.gezelId,
      projectId: answered.projectId,
    },
    { type: 'question_answered', question: answered },
  );
}
