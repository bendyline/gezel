import { isConfidentYes } from '../camera/review-prompt.js';
import { localDay } from '../notifications/policy.js';
import type { CameraEvent } from '../schemas/devices.js';
import type { Lookout, LookoutActiveHours, LookoutCounter } from '../schemas/lookout.js';

/**
 * Whether a camera event fires a lookout. Pure: the manager persists the
 * returned counter whatever the verdict (a `sure` lookout's first yes must be
 * remembered even though it does not fire yet).
 *
 * Order matters and is pinned by tests: state → snooze → hours → condition →
 * once per episode → cooldown → daily limit. A lookout fires at most once per
 * episode, so a cat that sits for five minutes is one alarm.
 */

export type LookoutHoldReason =
  | 'not-armed'
  | 'snoozed'
  | 'outside-hours'
  | 'no-match'
  | 'waiting-for-second-look'
  | 'already-fired'
  | 'cooldown'
  | 'daily-limit';

export type LookoutDecision =
  | { fire: true; counter: LookoutCounter; frame?: string }
  | { fire: false; reason: LookoutHoldReason; counter?: LookoutCounter };

/** Episodes remembered per lookout; older ones cannot recur. */
const EPISODE_MEMORY = 50;

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local-time window check; `from` after `to` wraps past midnight. */
export function withinActiveHours(hours: LookoutActiveHours | undefined, now: Date): boolean {
  if (!hours) return true;
  const from = minutesOf(hours.from);
  const to = minutesOf(hours.to);
  const t = now.getHours() * 60 + now.getMinutes();
  if (from === to) return true;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** The counter as of today: a new local day resets the counts, not the history. */
export function currentCounter(counter: LookoutCounter | undefined, now: Date): LookoutCounter {
  const day = localDay(now);
  if (!counter) return { day, fired: 0, followUps: 0, firedEpisodes: [], yesByEpisode: {} };
  if (counter.day === day) return { ...counter, firedEpisodes: [...counter.firedEpisodes] };
  return {
    day,
    fired: 0,
    followUps: 0,
    ...(counter.lastFiredAt ? { lastFiredAt: counter.lastFiredAt } : {}),
    firedEpisodes: [...counter.firedEpisodes],
    yesByEpisode: {},
  };
}

export function admitLookout(
  lookout: Lookout,
  stored: LookoutCounter | undefined,
  event: CameraEvent,
  now: Date,
): LookoutDecision {
  if (lookout.state !== 'armed' || !lookout.enabled) return { fire: false, reason: 'not-armed' };
  if (lookout.source.kind !== 'camera' || lookout.source.bindingId !== event.bindingId) {
    return { fire: false, reason: 'no-match' };
  }
  if (lookout.snoozedUntil && Date.parse(lookout.snoozedUntil) > now.getTime()) {
    return { fire: false, reason: 'snoozed' };
  }
  if (!withinActiveHours(lookout.activeHours, now)) return { fire: false, reason: 'outside-hours' };

  const counter = currentCounter(stored, now);
  if (counter.firedEpisodes.includes(event.episodeId)) {
    return { fire: false, reason: 'already-fired' };
  }

  const condition = lookout.condition;
  if (condition.kind === 'motion') {
    if (event.phase !== 'started' && event.phase !== 'reviewed') {
      return { fire: false, reason: 'no-match' };
    }
  } else {
    if (event.phase !== 'reviewed' || !event.review) return { fire: false, reason: 'no-match' };
    if (!isConfidentYes(event.review.answers[lookout.id])) {
      return { fire: false, reason: 'no-match' };
    }
    if (condition.kind === 'ask' && condition.strictness === 'sure') {
      const yes = (counter.yesByEpisode[event.episodeId] ?? 0) + 1;
      counter.yesByEpisode = { ...counter.yesByEpisode, [event.episodeId]: yes };
      if (yes < 2) return { fire: false, reason: 'waiting-for-second-look', counter };
    }
  }

  if (
    counter.lastFiredAt &&
    now.getTime() - Date.parse(counter.lastFiredAt) < lookout.limits.cooldownMinutes * 60_000
  ) {
    return { fire: false, reason: 'cooldown', counter };
  }
  if (counter.fired >= lookout.limits.maxPerDay) {
    return { fire: false, reason: 'daily-limit', counter };
  }

  counter.fired += 1;
  counter.lastFiredAt = now.toISOString();
  counter.firedEpisodes = [...counter.firedEpisodes, event.episodeId].slice(-EPISODE_MEMORY);
  const { [event.episodeId]: _done, ...restYes } = counter.yesByEpisode;
  counter.yesByEpisode = restYes;
  const frame = event.review?.frame ?? event.keyframePaths[event.keyframePaths.length - 1];
  return { fire: true, counter, ...(frame ? { frame } : {}) };
}

/** Plain-language reason for a lookout that matched but did not fire. */
export function lookoutHoldText(reason: LookoutHoldReason): string {
  switch (reason) {
    case 'not-armed':
      return 'This lookout is off.';
    case 'snoozed':
      return 'Snoozed.';
    case 'outside-hours':
      return 'Outside its active hours.';
    case 'no-match':
      return 'Nothing matched.';
    case 'waiting-for-second-look':
      return 'Waiting to see it on a second picture.';
    case 'already-fired':
      return 'Already acted on this sighting.';
    case 'cooldown':
      return 'Resting after its last alert.';
    case 'daily-limit':
      return 'Reached its limit for today.';
  }
}
