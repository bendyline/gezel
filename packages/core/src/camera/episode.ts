import type { MotionReading } from './motion.js';

/**
 * Turns per-frame motion readings into **episodes**: one thing happening in
 * view, from the frames that confirm it to the quiet that ends it. Episodes
 * are what the rest of the camera pipeline reasons about — one review
 * schedule, one event record, and one answer per lookout per episode — so a
 * cat that wanders in and sits for a minute is one event, not ninety.
 *
 *   idle ──(confirmFrames of the last windowFrames moving)──► active
 *   active ──(neither moving nor present for quietMs)──────► ended
 *   active ──(present but still for stillMs)──────────────► ended (reference refresh)
 *   active ──(maxEpisodeMs)───────────────────────────────► ended
 */

export interface EpisodeTuning {
  confirmFrames: number;
  windowFrames: number;
  /** Nothing moving and nothing present for this long ends the episode. */
  quietMs: number;
  /**
   * Something present but motionless for this long ends the episode too:
   * past that point it is part of the room (a bag on the floor), and the
   * pipeline refreshes the empty-scene reference to absorb it.
   */
  stillMs: number;
  maxEpisodeMs: number;
  /**
   * With no episode and no motion for this long, the background is trusted
   * as the empty scene again.
   */
  referenceRefreshMs: number;
}

export const DEFAULT_EPISODE_TUNING: Readonly<EpisodeTuning> = {
  confirmFrames: 2,
  windowFrames: 3,
  quietMs: 8_000,
  stillMs: 3 * 60_000,
  maxEpisodeMs: 30 * 60_000,
  referenceRefreshMs: 2 * 60_000,
};

export interface Episode {
  id: string;
  startedAt: number;
  lastMotionAt: number;
  lastActivityAt: number;
  /** Strongest motion reading in the episode so far. */
  motionPeak: number;
  moving: boolean;
  present: boolean;
}

export type EpisodeTransition =
  | { kind: 'started'; episode: Episode }
  | { kind: 'ended'; episode: Episode; at: number; reason: 'quiet' | 'still' | 'max-length' };

export class EpisodeTracker {
  private readonly tuning: EpisodeTuning;
  private readonly newId: (at: number) => string;
  private recent: boolean[] = [];
  private episode: Episode | null = null;
  private lastMotionAt = 0;
  private lastRefreshAt = 0;

  constructor(opts: { tuning?: Partial<EpisodeTuning>; newId?: (at: number) => string } = {}) {
    this.tuning = { ...DEFAULT_EPISODE_TUNING, ...opts.tuning };
    this.newId = opts.newId ?? defaultEpisodeId;
  }

  get current(): Episode | null {
    return this.episode;
  }

  /**
   * Feed one reading. Returns the transition it caused, if any. A scene
   * change (lights) neither starts nor extends an episode.
   */
  feed(reading: MotionReading, at: number): EpisodeTransition | null {
    if (reading.moving) this.lastMotionAt = at;
    if (reading.sceneChange) {
      this.recent = [];
      return null;
    }
    const ep = this.episode;
    if (!ep) {
      this.recent.push(reading.moving);
      if (this.recent.length > this.tuning.windowFrames) this.recent.shift();
      const confirmed = this.recent.filter(Boolean).length >= this.tuning.confirmFrames;
      if (!confirmed) return null;
      this.recent = [];
      this.episode = {
        id: this.newId(at),
        startedAt: at,
        lastMotionAt: at,
        lastActivityAt: at,
        motionPeak: reading.motion,
        moving: true,
        present: reading.present,
      };
      return { kind: 'started', episode: { ...this.episode } };
    }

    ep.moving = reading.moving;
    ep.present = reading.present;
    if (reading.moving) {
      ep.lastMotionAt = at;
      ep.lastActivityAt = at;
      ep.motionPeak = Math.max(ep.motionPeak, reading.motion);
    } else if (reading.present) {
      ep.lastActivityAt = at;
    }

    let reason: 'quiet' | 'still' | 'max-length' | null = null;
    if (at - ep.startedAt >= this.tuning.maxEpisodeMs) reason = 'max-length';
    else if (at - ep.lastActivityAt >= this.tuning.quietMs) reason = 'quiet';
    else if (!reading.moving && at - ep.lastMotionAt >= this.tuning.stillMs) reason = 'still';
    if (!reason) return null;
    this.episode = null;
    this.recent = [];
    return { kind: 'ended', episode: { ...ep }, at, reason };
  }

  /**
   * Whether the pipeline should adopt the background as the empty scene now:
   * after an episode that ended by standing still, or after a long stretch
   * with no episode and no motion. Marks the refresh as done when true.
   */
  takeReferenceRefresh(at: number, endedStill = false): boolean {
    if (endedStill) {
      this.lastRefreshAt = at;
      return true;
    }
    if (this.episode) return false;
    const quietSince = Math.max(this.lastMotionAt, this.lastRefreshAt);
    if (at - quietSince < this.tuning.referenceRefreshMs) return false;
    this.lastRefreshAt = at;
    return true;
  }
}

/** `ep-20261021-141503-k3f9`: sortable, readable in a folder listing. */
export function defaultEpisodeId(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `ep-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
