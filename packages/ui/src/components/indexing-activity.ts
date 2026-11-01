import type { ActivityItem, ChatEvent, Project } from '@bendyline/gezel';

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

export function indexingActivityId(event: IndexProgress): string {
  return `index:${event.phase}:${event.projectId ?? ''}`;
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
