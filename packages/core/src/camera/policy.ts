import type { CameraStoragePolicy } from '../schemas/devices.js';

/**
 * Which frames a camera keeps, and when its vision model looks. Pure so the
 * capture loop stays a loop and these rules stay testable.
 */

export interface SaveFrameInput {
  policy: CameraStoragePolicy;
  intervalSeconds: number;
  now: number;
  lastSavedAt: number | undefined;
  /** An episode is in progress (something moving or present). */
  inEpisode: boolean;
}

/** Whether this frame goes into the camera's private captures folder. */
export function shouldSaveFrame(input: SaveFrameInput): boolean {
  if (input.policy === 'interesting' || input.policy === 'latest-only') return false;
  if (input.policy === 'motion' && !input.inEpisode) return false;
  if (input.lastSavedAt === undefined) return true;
  // A frame arriving a hair early still counts: capture runs on its own
  // clock, and refusing a 9.98 s frame for a 10 s interval would halve the
  // effective rate.
  return input.now - input.lastSavedAt >= input.intervalSeconds * 1000 - 250;
}

export interface ReviewScheduleTuning {
  /** Wait after an episode starts so the subject is fully in frame. */
  settleMs: number;
  /** Look again this often while motion or presence lasts. */
  everyMs: number;
  maxPerEpisode: number;
}

export const DEFAULT_REVIEW_SCHEDULE: Readonly<ReviewScheduleTuning> = {
  settleMs: 1_000,
  everyMs: 15_000,
  maxPerEpisode: 8,
};

export interface ReviewScheduleState {
  episodeStartedAt: number;
  reviews: number;
  lastReviewAt: number | undefined;
}

/**
 * Whether the episode is due another look. Re-reviews matter: a cat walks in
 * (motion), then squats still for a minute (presence only), and the first
 * look usually sees the walking, not the act.
 */
export function reviewDue(
  state: ReviewScheduleState,
  now: number,
  tuning: ReviewScheduleTuning = DEFAULT_REVIEW_SCHEDULE,
): boolean {
  if (state.reviews >= tuning.maxPerEpisode) return false;
  if (state.lastReviewAt === undefined) return now - state.episodeStartedAt >= tuning.settleMs;
  return now - state.lastReviewAt >= tuning.everyMs;
}

/** `YYYY-MM-DD` and `HH` in local time, the folder levels for captures and events. */
export function localDayHour(at: number): { day: string; hour: string; stamp: string } {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hour: p(d.getHours()),
    stamp: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`,
  };
}
