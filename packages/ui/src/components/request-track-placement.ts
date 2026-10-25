import type { RequestTrack, TimelineMessage, ToolCallCard } from '@bendyline/gezel';
import { craftbookCardDedupe } from './craftbook-card-dedupe.js';

/**
 * Where a request's tracker goes, and what it stands in for. The tracker
 * closes the thread rooted at the person's message; outside debug mode the
 * launch cards, joined-crew introductions, finished-card copy and rail cards
 * of the work it tracks stay out of the thread, because the tracker already
 * says all of it. Task-scoped sessions and plain replies are not tracked.
 */

type RootLike = Pick<
  TimelineMessage,
  'role' | 'sessionId' | 'at' | 'from' | 'origin' | 'nudge' | 'taskRef' | 'parentSession'
>;

/** The request a thread root asks for, when the root is the person's own message. */
export function requestKeyOfRoot(root: RootLike): string | undefined {
  if (root.role !== 'user' || root.from || root.origin === 'system' || root.nudge) return undefined;
  if (root.taskRef || root.parentSession) return undefined;
  return `${root.sessionId}@${root.at}`;
}

/** Requests with work behind them; a reply still being written gets no tracker. */
export function isTrackedWork(track: RequestTrack | undefined): track is RequestTrack {
  return track?.kind === 'work';
}

/** Every task ref a tracker in this thread speaks for. */
export function trackedTaskRefs(tracks: Iterable<RequestTrack>): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const track of tracks)
    if (isTrackedWork(track)) for (const ref of track.taskRefs) refs.add(ref);
  return refs;
}

/** Sessions whose silence the tracker already explains. */
export function trackedSessions(tracks: Iterable<RequestTrack>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const track of tracks) {
    if (!isTrackedWork(track)) continue;
    for (const id of track.liveSessionIds) ids.add(id);
    if (track.state !== 'ready') ids.add(track.sessionId);
  }
  return ids;
}

/** Craftbook cards of tracked tasks, by object identity, for `hiddenCards`. */
export function trackedTaskCards(
  messages: Iterable<Pick<TimelineMessage, 'toolCalls'>>,
  refs: ReadonlySet<string>,
): Set<ToolCallCard> {
  const out = new Set<ToolCallCard>();
  if (refs.size === 0) return out;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const card = call.card;
      if (card && 'taskRef' in card && typeof card.taskRef === 'string' && refs.has(card.taskRef)) {
        out.add(card);
      }
    }
  }
  return out;
}

/**
 * The craftbook cards a timeline hides outside debug mode: every card of
 * tracked work, and all but the earliest card of each other task
 * (craftbook-card-dedupe.ts). `shown` is what renders outside a fold, which
 * keeps its full transcript. A turn still streaming checks its cards against
 * `liveOwnedRefs`.
 */
export function timelineCardHiding(
  shown: readonly Pick<TimelineMessage, 'at' | 'toolCalls'>[],
  refs: ReadonlySet<string>,
): { hiddenCards: ReadonlySet<ToolCallCard>; liveOwnedRefs: ReadonlySet<string> } {
  const dedupe = craftbookCardDedupe(
    [...shown].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  );
  return {
    hiddenCards: new Set([...dedupe.hidden, ...trackedTaskCards(shown, refs)]),
    liveOwnedRefs: new Set([...dedupe.owned, ...refs]),
  };
}

/** A joined-crew introduction for tracked work: the tracker's "Who's helping?" holds it. */
export function isAbsorbedCrewIntro(
  message: Pick<TimelineMessage, 'synthetic' | 'crewIntroduction'>,
  refs: ReadonlySet<string>,
): boolean {
  const intro = message.crewIntroduction;
  return (
    message.synthetic === 'crew-introduction' &&
    intro?.moment === 'joined' &&
    refs.has(intro.taskRef)
  );
}

/** A wrap-up of tracked work: its finished card shows in the tracker instead. */
export function isTrackedWrapUp(
  message: Pick<TimelineMessage, 'synthetic' | 'referencedTasks'>,
  refs: ReadonlySet<string>,
): boolean {
  return (
    message.synthetic === 'task-wrapup' &&
    (message.referencedTasks ?? []).some((ref) => refs.has(ref))
  );
}
