import { randomUUID } from 'node:crypto';
import {
  type GezelConfig,
  type Question,
  createLogger,
  formatNightShiftSummary,
  hasNightShiftIndexing,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { DiffpackManager } from '../diffpack/manager.js';
import { writeWeeklyRecap } from '../digest/weekly-recap.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { findNightShiftOversightTask } from '../meester/night-shift-oversight.js';
import type { ReportActionManager } from '../report-actions/report-action-manager.js';
import type { TaskManager } from './manager.js';
import { buildNightShiftReview, nightShiftReportAttachmentPath } from './night-review.js';
import type { NightShiftManager } from './night-shift-manager.js';
import { buildNightShiftTally, nightShiftTallyPeriod } from './night-tally.js';

const log = createLogger('service');

export interface NightShiftReviewCardDeps {
  store: Store;
  tasks: TaskManager;
  history: HistoryManager;
  contentIndex: ContentIndex;
  reportActions: ReportActionManager;
  diffpacks: DiffpackManager;
  chatEvents: ChatEventBus;
  nightShift: Pick<NightShiftManager, 'currentWindow' | 'windowOutcome'>;
  /** Whether a folder of the person's own is owed tonight's index sweep. */
  hasNightSweepProject: () => Promise<boolean>;
  /** The shift's own clock; see `StartServiceOptions.nightShiftNow`. */
  nightShiftNow?: () => Date;
}

/**
 * Morning review question: once per settled night window (deduped on
 * the window key against the question store, so restarts and
 * slept-through-window-end catch-ups never double-ask), summarize what
 * the shift accomplished as a needs-input card with report links.
 */
export async function postNightShiftReviewCard(
  deps: NightShiftReviewCardDeps,
  windowKey: string,
): Promise<void> {
  const {
    store,
    tasks,
    history,
    contentIndex,
    reportActions,
    diffpacks,
    chatEvents,
    nightShift,
    hasNightSweepProject,
  } = deps;
  const existing = await store.listProjectQuestions('default').catch(() => []);
  if (
    existing.some(
      (q) => q.intent?.kind === 'night-shift-review' && q.intent.windowKey === windowKey,
    )
  ) {
    return;
  }
  const review = await buildNightShiftReview(
    { store, tasks, reportActions, diffpacks },
    nightShift.currentWindow(),
    // The shift's own clock, so the review and the settled window agree.
    deps.nightShiftNow?.() ?? new Date(),
  );
  if (review.windowKey !== windowKey) return;
  const outcome = nightShift.windowOutcome(windowKey);
  // A paused review never re-arms on its own (its pause is meant for the
  // person), so the morning card is where they hear about it.
  const oversight = await findNightShiftOversightTask(store);
  const pausedReview =
    oversight?.status === 'paused' ? { projectId: 'default', num: oversight.num } : undefined;
  // The sweep's own output: the only durable record of indexing volume.
  const settledAt = deps.nightShiftNow?.() ?? new Date();
  const tally = await buildNightShiftTally(
    { history, store, contentIndex },
    nightShiftTallyPeriod(settledAt, nightShift.currentWindow(), {
      active: false,
      startedAt: null,
    }),
  ).catch(() => null);
  const indexing = tally
    ? {
        filesIndexed: tally.filesIndexed,
        filesReviewed: tally.filesReviewed,
        mediaDescribed: tally.mediaDescribed,
      }
    : undefined;
  const swept = hasNightShiftIndexing(indexing);
  const weeklyRecap = await writeWeeklyRecap({ store, history }, settledAt).catch(
    (err: unknown) => {
      log.warn(`[night-shift] weekly recap failed: ${String(err)}`);
      return null;
    },
  );
  const empty =
    review.tasksCompleted.length === 0 &&
    review.reports.length === 0 &&
    review.diffpacks.length === 0 &&
    !swept;
  if (empty && !pausedReview && !weeklyRecap) {
    // A night that produced nothing still gets a card saying why — but only
    // when work was owed. An install with no folders and nothing queued
    // shouldn't hear about every night it had nothing to do.
    const owed =
      (await hasNightSweepProject()) ||
      (await tasks.list({ status: 'active' }).catch(() => [])).some(
        (t) => t.nightShift?.enabled === true,
      );
    if (!owed) return;
  }
  const quiet = empty ? { reason: outcome.reason ?? ('no-work' as const) } : undefined;
  const config = await store.readConfig().catch(() => ({}) as GezelConfig);
  // `suggested`, not `total`: the tally is a call to action, and an
  // action already fired or dismissed is not one the user still owes
  // a look. Same count Home's "Last night" panel names.
  const actionTotal = review.reports.reduce((n, r) => n + r.actionCounts.suggested, 0);
  const card: Question = {
    id: randomUUID(),
    projectId: 'default',
    gezelId: config.meesterGezelId ?? '',
    // No live session — the answer route early-returns for this intent.
    sessionId: '',
    prompt: formatNightShiftSummary({
      tasks: review.tasksCompleted.length,
      reports: review.reports.length,
      proposals: review.diffpacks.length,
      actions: actionTotal,
      ...(quiet ? { quiet } : {}),
      ...(pausedReview ? { pausedReview: true } : {}),
      ...(swept && indexing ? { indexing } : {}),
    }),
    choices: ['Dismiss'],
    allowWriteIn: false,
    multiSelect: false,
    ...(review.reports[0]
      ? { documentPath: nightShiftReportAttachmentPath(review.reports[0]) }
      : {}),
    intent: {
      kind: 'night-shift-review',
      windowKey: review.windowKey,
      tasksCompleted: review.tasksCompleted.length,
      reports: review.reports.map((r) => ({
        projectId: r.projectId,
        path: r.path,
        title: r.title,
        actionCount: r.actionCounts.total,
      })),
      ...(quiet ? { quiet } : {}),
      ...(pausedReview ? { pausedReview } : {}),
      ...(swept && indexing ? { indexing } : {}),
      ...(weeklyRecap ? { weeklyRecap } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  await store.writeQuestion(card);
  // Announced like any card: the desktop app raises its one morning
  // notification from this, and open windows fold the card in.
  chatEvents.publishProjectEvent('default', { type: 'question_asked', question: card });
  // One audit record per settled window, written under the same per-window
  // dedupe as the card, so a restart replaying the settle can't double it.
  await history
    .log({
      kind: 'night-shift.window-settled',
      projectId: 'default',
      summary: quiet
        ? `Night shift ${windowKey}: nothing done (${quiet.reason})`
        : `Night shift ${windowKey}: ${review.tasksCompleted.length} task(s), ${review.reports.length} report(s), ${review.diffpacks.length} proposal(s)`,
      details: {
        windowKey,
        ran: outcome.ran,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.startedAt ? { startedAt: outcome.startedAt } : {}),
        ...(outcome.endedAt ? { endedAt: outcome.endedAt } : {}),
        tasksCompleted: review.tasksCompleted.length,
        reports: review.reports.length,
        proposals: review.diffpacks.length,
      },
    })
    .catch((err) => log.warn(`[night-shift] settle history event failed: ${String(err)}`));
}
