import {
  type HistoryEvent,
  type HistoryEventKind,
  type NightShiftTallyResponse,
  type NightShiftWindow,
  isInNightShiftWindow,
  lastNightShiftWindow,
} from '@bendyline/gezel';

/**
 * The Night Shift tally: how much the crew actually got through in one
 * period, for the moon menu's "so far tonight" / "last night" block.
 *
 * Derived on every read from traces the app already keeps, exactly like
 * {@link buildNightShiftReview} — no counters to reset, and a daemon that
 * restarts at 3am doesn't lose the night:
 *   - the audit log, sliced to the period and filtered to the kinds that
 *     represent finished work (task/step completions, writes, renders,
 *     questions, tool calls);
 *   - each project's content index, whose enrichment tiers stamp their own
 *     success rows (`summaries.created_at`, `file_reviews.reviewed_at`,
 *     `shadow_state.updated_at`) — the only durable record of indexing
 *     volume, since the per-batch progress events are ephemeral SSE.
 *
 * The counts are install-wide: a shift is not scoped to one project.
 */

/** Audit kinds worth counting — anything else is noise for this surface. */
const TALLIED_KINDS: HistoryEventKind[] = [
  'task.status.changed',
  'task.step.completed',
  'workspace.write',
  // Only creations: an overwrite of an existing document goes to the
  // library's own audit trail, not the history log.
  'document.created',
  'render.generated',
  'user.question.asked',
  'tool.called',
];

export interface NightShiftTallyDeps {
  history: {
    listEvents(filter: {
      kinds?: HistoryEventKind[];
      from?: string;
      to?: string;
    }): Promise<HistoryEvent[]>;
  };
  store: { listProjects(): Promise<Array<{ id: string }>> };
  contentIndex: {
    workCountsSince(
      projectId: string,
      since: string,
      until: string,
    ): Promise<{ summarized: number; reviewed: number; described: number } | null>;
  };
}

export interface NightShiftTallyPeriod {
  since: Date;
  until: Date;
  /** True while this period is the running shift (counts still climbing). */
  live: boolean;
}

/**
 * The stretch of time a tally covers. Normally the night window itself —
 * the same period the morning review reports on, so the counts and the
 * "Done last night" list can't disagree — capped at `now` while it's still
 * running. A shift the user started by hand outside the window has no
 * window to lean on, so it counts from the moment they started it; one
 * started shortly BEFORE the window opened keeps its earlier start rather
 * than dropping the work it already did.
 */
export function nightShiftTallyPeriod(
  now: Date,
  window: NightShiftWindow,
  shift: { active: boolean; startedAt: string | null },
): NightShiftTallyPeriod {
  const { start, end } = lastNightShiftWindow(now, window);
  let since = start;
  if (shift.active && shift.startedAt) {
    const startedAt = new Date(shift.startedAt);
    if (!Number.isNaN(startedAt.getTime())) {
      const windowOpen = isInNightShiftWindow(now, window);
      if (!windowOpen || startedAt < since) since = startedAt;
    }
  }
  const until = shift.active ? now : new Date(Math.min(now.getTime(), end.getTime()));
  // A manual shift can outlive the window it started in; never invert.
  return { since, until: until < since ? since : until, live: shift.active };
}

export async function buildNightShiftTally(
  deps: NightShiftTallyDeps,
  period: NightShiftTallyPeriod,
): Promise<NightShiftTallyResponse> {
  const since = period.since.toISOString();
  const until = period.until.toISOString();

  const tally: NightShiftTallyResponse = {
    since,
    until,
    live: period.live,
    tasksCompleted: 0,
    stepsCompleted: 0,
    filesIndexed: 0,
    filesReviewed: 0,
    mediaDescribed: 0,
    filesWritten: 0,
    documentsCreated: 0,
    imagesRendered: 0,
    questionsRaised: 0,
    toolCalls: 0,
  };

  const events = await deps.history
    .listEvents({ kinds: TALLIED_KINDS, from: since, to: until })
    .catch(() => [] as HistoryEvent[]);
  for (const event of events) {
    switch (event.kind) {
      case 'task.status.changed':
        // The same kind carries pauses and cancellations; only completion
        // is work finished.
        if (event.details?.status === 'complete') tally.tasksCompleted++;
        break;
      case 'task.step.completed':
        tally.stepsCompleted++;
        break;
      case 'workspace.write':
        tally.filesWritten++;
        break;
      case 'document.created':
        tally.documentsCreated++;
        break;
      case 'render.generated':
        tally.imagesRendered++;
        break;
      case 'user.question.asked':
        tally.questionsRaised++;
        break;
      case 'tool.called':
        tally.toolCalls++;
        break;
    }
  }

  const projects = await deps.store.listProjects().catch(() => []);
  for (const project of projects) {
    const counts = await deps.contentIndex
      .workCountsSince(project.id, since, until)
      .catch(() => null);
    if (!counts) continue;
    tally.filesIndexed += counts.summarized;
    tally.filesReviewed += counts.reviewed;
    tally.mediaDescribed += counts.described;
  }

  return tally;
}

/** Whether anything at all was counted — the surfaces hide an empty tally. */
export function nightShiftTallyIsEmpty(tally: NightShiftTallyResponse): boolean {
  return (
    tally.tasksCompleted === 0 &&
    tally.stepsCompleted === 0 &&
    tally.filesIndexed === 0 &&
    tally.filesReviewed === 0 &&
    tally.mediaDescribed === 0 &&
    tally.filesWritten === 0 &&
    tally.documentsCreated === 0 &&
    tally.imagesRendered === 0 &&
    tally.questionsRaised === 0 &&
    tally.toolCalls === 0
  );
}
