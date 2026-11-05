import type { ActivityItem, ActivityStatusResponse, ChatEvent, Project } from '@bendyline/gezel';

export type IndexProgress = Extract<ChatEvent, { type: 'index_progress' }>;

// Some indexing phases emit batch heartbeats without a matching start/end.
// Keep those transient updates for the same window as the former header pill.
export const INDEX_ACTIVITY_LINGER_MS = 8_000;

const PHASE_LABELS: Record<IndexProgress['phase'], [string, string]> = {
  scan: ['Scanning', 'Scan finished'],
  shadow: ['Reading media', 'Media reading finished'],
  enrich: ['Studying', 'Study finished'],
  review: ['Reviewing', 'Review finished'],
  digest: ['Writing a digest', 'Digest finished'],
};

/**
 * One row per project. A catch-up drive reports its scan, media, study and
 * review phases as it goes; a row per phase counted that one job two or
 * three times.
 */
export function indexingActivityId(event: IndexProgress): string {
  return `index:${event.projectId ?? ''}`;
}

/** A project's indexing as Activity tracks it between events. */
export interface IndexingJob {
  /** The event its row shows. */
  shown: IndexProgress;
  /** Starts not yet ended, per phase. */
  open: Partial<Record<IndexProgress['phase'], number>>;
}

/** True from a start until its end: such a job stays listed during a long, quiet phase. */
export function indexingJobLive(job: IndexingJob): boolean {
  return Object.values(job.open).some((count) => (count ?? 0) > 0);
}

/**
 * Fold one event into its project's job. Starts and ends pair per phase:
 * the catch-up drive wraps the static rescan, which reports a scan start and
 * end of its own, and an end nothing started (a digest, a study receipt)
 * closes nothing. An end inside a job that is still live finishes one step
 * of it, so the row keeps showing the work.
 */
export function foldIndexingJob(job: IndexingJob | undefined, event: IndexProgress): IndexingJob {
  const open = { ...job?.open };
  const count = open[event.phase] ?? 0;
  if (event.state === 'started') open[event.phase] = count + 1;
  else if (event.state === 'ended' && count > 0) open[event.phase] = count - 1;
  const next = { shown: event, open };
  return job && event.state === 'ended' && indexingJobLive(next)
    ? { shown: job.shown, open }
    : next;
}

/**
 * An indexing job's model calls hold provider slots with no chat session,
 * which the snapshot counts as the anonymous "Background work" row. When
 * every such slot belongs to a project whose indexing already has a working
 * row, that row is the same job again.
 */
export function withoutIndexingBackground(
  items: ActivityItem[],
  queues: ActivityStatusResponse['queues'],
  indexing: ActivityItem[],
): ActivityItem[] {
  const working = indexing.filter((item) => item.section === 'working');
  if (!working.length) return items;
  const indexingCall = (row: { projectId?: string; gezelId?: string }) =>
    row.projectId !== undefined &&
    working.some(
      (job) => job.projectId === row.projectId && (!job.gezelId || job.gezelId === row.gezelId),
    );
  let anonymous = 0;
  let indexingSlots = 0;
  for (const state of Object.values(queues.providers)) {
    if (!state) continue;
    // Slots the queue does not describe could be any chore.
    anonymous += Math.max(0, state.running - state.active.length);
    for (const row of state.active) {
      if (row.sessionId) continue;
      anonymous++;
      if (indexingCall(row)) indexingSlots++;
    }
  }
  return anonymous > 0 && indexingSlots === anonymous
    ? items.filter((item) => item.id !== 'background:running')
    : items;
}

export function indexingActivityItem(
  event: IndexProgress,
  projects: ReadonlyMap<string, Project>,
): ActivityItem {
  const finished = event.state === 'ended';
  const phase = PHASE_LABELS[event.phase][finished ? 1 : 0];
  const project = event.projectId ? (projects.get(event.projectId)?.name ?? event.projectId) : '';
  return {
    id: indexingActivityId(event),
    section: finished ? 'ready' : 'working',
    title: project ? `${phase} · ${project}` : phase,
    detail:
      event.detail ?? (finished ? 'Background indexing finished.' : 'Updating the project index.'),
    projectId: event.projectId,
    gezelId: event.gezelId,
    questionIds: [],
  };
}
