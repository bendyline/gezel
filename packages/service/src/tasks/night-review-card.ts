import { randomUUID } from 'node:crypto';
import {
  type GezelConfig,
  type NightShiftQuietReason,
  type NightShiftReviewIntent,
  type NightShiftReviewResponse,
  QUIET_NIGHT_GRACE_MS,
  type Question,
  createLogger,
  formatNightShiftSummary,
  hasNightShiftIndexing,
  isWithinFirstUse,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { DiffpackManager } from '../diffpack/manager.js';
import { writeWeeklyRecap } from '../digest/weekly-recap.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ContentIndex } from '../index-store/content-index.js';
import {
  findNightShiftOversightTask,
  isNightShiftOversightReport,
  isNightShiftOversightTask,
  nightShiftReviewScope,
} from '../meester/night-shift-oversight.js';
import type { ReportActionManager } from '../report-actions/report-action-manager.js';
import type { TaskManager } from './manager.js';
import { buildNightShiftReview, nightShiftReportAttachmentPath } from './night-review.js';
import type { NightShiftManager } from './night-shift-manager.js';
import { buildNightShiftTally, nightShiftTallyPeriod } from './night-tally.js';

const log = createLogger('service');

/**
 * Quiet nights the person can do something about: plug the computer in, or
 * loosen the cloud plan's quota reserve. The others are ordinary (the
 * computer slept, gezel wasn't running, the person stopped the shift, nothing
 * was owed), and a card about them every morning was noise.
 */
const ACTIONABLE_QUIET_REASONS: ReadonlySet<NightShiftQuietReason> = new Set([
  'on-battery',
  'quota-held',
]);

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

type ReviewCard = Question & { intent: NightShiftReviewIntent };

function isReviewCard(question: Question): question is ReviewCard {
  return question.intent?.kind === 'night-shift-review';
}

/** A settled night as its `night-shift.window-settled` record tells it. */
interface RecordedNight {
  windowKey: string;
  at: string;
  ran: boolean;
}

/**
 * Settle one night window, once (deduped on the window key against both the
 * question store and the night's history record, so restarts and
 * slept-through-window-end catch-ups never decide twice). Every settled night
 * is recorded for the weekly recap. A morning card is posted only when the
 * night made something, or when it sat idle for a reason the person can fix
 * and has not been told about yet; a new card retires the ones it repeats.
 */
export async function postNightShiftReviewCard(
  deps: NightShiftReviewCardDeps,
  windowKey: string,
): Promise<void> {
  const { store, tasks, history, contentIndex, reportActions, diffpacks, chatEvents, nightShift } =
    deps;
  const questions: Question[] = await store.listProjectQuestions('default').catch(() => []);
  const cards = questions.filter(isReviewCard);
  if (cards.some((q) => q.intent.windowKey === windowKey)) return;
  const nights = await recordedNights(history);
  if (nights.some((n) => n.windowKey === windowKey)) return;

  // The shift's own clock, so the review and the settled window agree.
  const settledAt = deps.nightShiftNow?.() ?? new Date();
  const review = await buildNightShiftReview(
    { store, tasks, reportActions, diffpacks },
    nightShift.currentWindow(),
    settledAt,
  );
  if (review.windowKey !== windowKey) return;
  await store.cacheStartupNightReview(review).catch(() => {});
  const outcome = nightShift.windowOutcome(windowKey);
  // A paused review is resumed at the next window (releasePausedReview in
  // meester/night-shift-oversight.ts); the morning card tells the person it
  // will retry, and nobody has to press Resume.
  const oversight = await findNightShiftOversightTask(store);
  const pausedReview =
    oversight?.status === 'paused' ? { projectId: 'default', num: oversight.num } : undefined;
  // The sweep's own output: the only durable record of indexing volume.
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
  const config = await store.readConfig().catch(() => ({}) as GezelConfig);

  const made = await whatTheNightMade(deps, review);
  const worked =
    review.tasksCompleted.length > 0 || made.reports > 0 || made.proposals > 0 || swept;
  const listsAnything =
    review.tasksCompleted.length > 0 ||
    review.reports.length > 0 ||
    review.diffpacks.length > 0 ||
    swept;
  const reason = outcome.reason ?? 'no-work';
  // The quiet sentence is the whole card, so a card with anything to list (a
  // proposal still waiting, say) never carries one.
  const quiet =
    !listsAnything &&
    (await quietNightWorthACard(deps, { reason, config, cards, nights, settledAt }))
      ? { reason }
      : undefined;

  if (worked || quiet) {
    const weeklyRecap = await writeWeeklyRecap({ store, history }, settledAt).catch(
      (err: unknown) => {
        log.warn(`[night-shift] weekly recap failed: ${String(err)}`);
        return null;
      },
    );
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
    // notification from this (never for a quiet card), and open windows
    // fold the card in.
    chatEvents.publishProjectEvent('default', { type: 'question_asked', question: card });
    await retireEarlierCards(deps, cards, { quiet: quiet !== undefined });
  } else {
    log.debug(`[night-shift] ${windowKey}: nothing new overnight (${reason}); no card`);
  }

  // A new home's first boot settles the night before it existed; that night
  // was never the crew's.
  const endedMs = Date.parse(review.windowEnd);
  const firstUseMs = config.firstUseAt ? Date.parse(config.firstUseAt) : Number.NaN;
  if (Number.isFinite(endedMs) && Number.isFinite(firstUseMs) && endedMs <= firstUseMs) return;
  await history
    .log({
      kind: 'night-shift.window-settled',
      projectId: 'default',
      summary: worked
        ? `Night shift ${windowKey}: ${review.tasksCompleted.length} task(s), ${made.reports} report(s), ${made.proposals} proposal(s)`
        : `Night shift ${windowKey}: nothing done (${reason})`,
      details: {
        windowKey,
        ran: outcome.ran,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.startedAt ? { startedAt: outcome.startedAt } : {}),
        ...(outcome.endedAt ? { endedAt: outcome.endedAt } : {}),
        // What this night made, so the weekly recap counts a proposal
        // left waiting for a week once, not once a night.
        tasksCompleted: review.tasksCompleted.length,
        reports: made.reports,
        proposals: made.proposals,
      },
    })
    .catch((err) => log.warn(`[night-shift] settle history event failed: ${String(err)}`));
}

/**
 * What the night itself produced, as opposed to what the review lists. The
 * review keeps showing a change proposal until the person decides on it, and
 * its report count includes the nightly review's own write-up; neither, on
 * its own, is something that happened last night worth a card.
 */
async function whatTheNightMade(
  deps: Pick<NightShiftReviewCardDeps, 'store' | 'diffpacks'>,
  review: NightShiftReviewResponse,
): Promise<{ reports: number; proposals: number }> {
  let reports = review.reports.length;
  // The review of no projects writes a note saying so; that is not a report.
  if (review.reports.some((r) => isNightShiftOversightReport(r.projectId, r.path))) {
    const projects = await deps.store.listProjects().catch(() => null);
    if (projects && nightShiftReviewScope(projects).length === 0) reports--;
  }
  let proposals = 0;
  if (review.diffpacks.length > 0) {
    const startMs = Date.parse(review.windowStart);
    const endMs = Date.parse(review.windowEnd);
    const listed = new Set(review.diffpacks.map((p) => `${p.projectId}/${p.packId}`));
    for (const projectId of new Set(review.diffpacks.map((p) => p.projectId))) {
      for (const pack of await deps.diffpacks.list(projectId).catch(() => [])) {
        if (!listed.has(`${projectId}/${pack.packId}`)) continue;
        const at = Date.parse(pack.sealedAt ?? pack.createdAt);
        if (at >= startMs && at < endMs) proposals++;
      }
    }
  }
  return { reports, proposals };
}

/**
 * Whether a night that produced nothing deserves a card: a reason the person
 * can act on, work they were actually owed (the Meester's own review is not
 * theirs), past the first few days, and news. The same reason is said once,
 * then not again until a night has run in between.
 */
async function quietNightWorthACard(
  deps: Pick<NightShiftReviewCardDeps, 'tasks' | 'hasNightSweepProject'>,
  ctx: {
    reason: NightShiftQuietReason;
    config: GezelConfig;
    cards: ReviewCard[];
    nights: RecordedNight[];
    settledAt: Date;
  },
): Promise<boolean> {
  const { reason, config, cards, nights, settledAt } = ctx;
  if (!ACTIONABLE_QUIET_REASONS.has(reason)) return false;
  // A new install's grace runs from its first use. An install that predates
  // that stamp gets the same few days from the first night this build
  // settled, so an upgrade does not open on a run of quiet-night cards.
  // Harness homes are established from their first boot.
  const graceFrom =
    config.firstUseAt ??
    (process.env.GEZEL_DISABLE_FIRST_USE_GRACE === '1'
      ? undefined
      : (earliest(nights.map((n) => n.at)) ?? settledAt.toISOString()));
  if (isWithinFirstUse(graceFrom, settledAt.getTime(), QUIET_NIGHT_GRACE_MS)) {
    log.debug(`[night-shift] quiet night (${reason}) during the first days; no card`);
    return false;
  }
  const owed =
    (await deps.hasNightSweepProject()) ||
    (await deps.tasks.list({ status: 'active' }).catch(() => [])).some(
      (t) => t.nightShift?.enabled === true && !isNightShiftOversightTask(t),
    );
  if (!owed) return false;
  const latest = cards.reduce<ReviewCard | null>(
    (best, q) => (!best || q.intent.windowKey > best.intent.windowKey ? q : best),
    null,
  );
  if (latest?.intent.quiet?.reason === reason) {
    const toldAt = latest.intent.windowKey;
    if (!nights.some((n) => n.windowKey > toldAt && n.ran)) return false;
  }
  return true;
}

async function recordedNights(
  history: Pick<HistoryManager, 'listEvents'>,
): Promise<RecordedNight[]> {
  const events = await history
    .listEvents({ kinds: ['night-shift.window-settled'], projectId: 'default' })
    .catch(() => []);
  const nights: RecordedNight[] = [];
  for (const event of events) {
    const details = event.details as { windowKey?: unknown; ran?: unknown } | undefined;
    if (typeof details?.windowKey !== 'string') continue;
    nights.push({ windowKey: details.windowKey, at: event.at, ran: details.ran === true });
  }
  return nights;
}

function earliest(isoTimes: string[]): string | undefined {
  return isoTimes.reduce<string | undefined>((min, at) => (!min || at < min ? at : min), undefined);
}

/**
 * Close the earlier cards the new one makes redundant, so mornings nobody
 * looked at don't pile up in Activity. Only what the new card says again is
 * retired: a quiet card (its reason is history), and, under a card with work
 * on it, one that held no task or report of its own (its proposals are
 * listed until decided, and its indexing tally is a night's count). A card
 * carrying the week's recap is never retired. The review lists a single
 * night's reports and tasks, so a card holding those stays until the person
 * dismisses it: a quiet Saturday must not take Friday's unread reports with
 * it. Closed silently, like any card the runtime withdraws.
 */
async function retireEarlierCards(
  deps: Pick<NightShiftReviewCardDeps, 'store' | 'chatEvents'>,
  cards: ReviewCard[],
  next: { quiet: boolean },
): Promise<void> {
  const at = new Date().toISOString();
  for (const card of cards) {
    if (card.answer || !saysAgain(card.intent, next)) continue;
    const retired: Question = { ...card, answer: { silentSkip: true, at } };
    try {
      await deps.store.writeQuestion(retired);
    } catch (err) {
      log.warn(`[night-shift] could not retire the ${card.intent.windowKey} card: ${String(err)}`);
      continue;
    }
    deps.chatEvents.publishProjectEvent('default', {
      type: 'question_answered',
      question: retired,
    });
  }
}

function saysAgain(earlier: NightShiftReviewIntent, next: { quiet: boolean }): boolean {
  if (earlier.weeklyRecap) return false;
  if (earlier.quiet) return true;
  return !next.quiet && earlier.tasksCompleted === 0 && earlier.reports.length === 0;
}
