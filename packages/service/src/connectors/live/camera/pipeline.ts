/**
 * One camera binding's perception loop, fed a frame at a time:
 *
 *   frame ─► motion/presence ─► episode ─► review schedule ─► vision review
 *     │                            │                              │
 *     └─► storage policy ─► captures/        event record ◄───────┘ ─► CameraEvent
 *
 * The cheap stages run on every frame (well under a millisecond at 160x90);
 * the vision model sees a frame only when an episode is underway and a
 * review is due. Disk writes are chained so a record is never refreshed out
 * of order, and nothing here blocks the next frame.
 */

import type {
  CameraBindingConfig,
  CameraEvent,
  LiveBindingStatus,
  LookoutQuestion,
} from '@bendyline/gezel';
import {
  EpisodeTracker,
  MotionDetector,
  createLogger,
  isConfidentYes,
  reviewDue,
  shouldSaveFrame,
} from '@bendyline/gezel';
import type { CameraFrame } from './capture-process.js';
import type { CapturesStore } from './captures-store.js';
import { CameraEventWriter, type EpisodeRecordState, type WrittenEpisode } from './event-writer.js';
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH } from './ffmpeg-args.js';
import type { CameraReviewer } from './reviewer.js';

const log = createLogger('camera');

/** Recent frames kept to pick the best one for a review. */
const RING_SIZE = 12;
/** Event records a camera writes per hour before it only reports. */
export const EVENTS_PER_HOUR = 60;

export interface CameraLookoutView {
  /** Questions the vision review answers for this camera's armed lookouts. */
  questions: LookoutQuestion[];
  /** An armed "anything moving" lookout watches this camera. */
  motion: boolean;
}

export interface CameraPipelineDeps {
  projectId: string;
  bindingId: string;
  cameraLabel: string;
  config: CameraBindingConfig;
  captures: CapturesStore;
  events: CameraEventWriter;
  reviewer: CameraReviewer;
  lookouts(): CameraLookoutView;
  /** Engagement allows autonomous model work (reviews). */
  reviewAllowed(): boolean;
  onEvent(event: CameraEvent): void;
  onStatus(patch: Partial<LiveBindingStatus>): void;
  /** The corpus changed; the artifacts index should catch up (debounced by the caller). */
  onRecordWritten(): void;
  signal: AbortSignal;
  now?(): number;
}

interface ActiveEpisode {
  state: EpisodeRecordState;
  reviews: number;
  lastReviewAt: number | undefined;
  /** Worth a record: a notable review, a lookout's yes, or motion when nothing reviews. */
  interesting: boolean;
  written: WrittenEpisode | null;
}

export class CameraPipeline {
  private readonly detector: MotionDetector;
  private readonly tracker = new EpisodeTracker();
  private readonly ring: Array<{ at: number; jpeg: Buffer; motion: number }> = [];
  private episode: ActiveEpisode | null = null;
  private reviewing = false;
  private lastSavedAt: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private eventsThisHour = { hour: -1, count: 0 };
  private lastStatusAt = 0;
  private config: CameraBindingConfig;

  constructor(private readonly deps: CameraPipelineDeps) {
    this.config = deps.config;
    this.detector = new MotionDetector({ sensitivity: deps.config.sensitivity });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  reconfigure(config: CameraBindingConfig): void {
    this.config = config;
    this.detector.setSensitivity(config.sensitivity);
  }

  feed(frame: CameraFrame): void {
    if (this.deps.signal.aborted) return;
    const at = frame.at;
    const reading = this.detector.feed({
      width: ANALYSIS_WIDTH,
      height: ANALYSIS_HEIGHT,
      data: frame.gray,
    });
    this.ring.push({ at, jpeg: frame.jpeg, motion: reading.motion });
    if (this.ring.length > RING_SIZE) this.ring.shift();

    const transition = this.tracker.feed(reading, at);
    if (transition?.kind === 'started')
      this.startEpisode(transition.episode.id, at, frame.jpeg, reading.motion, reading.present);
    const ep = this.episode;
    if (ep) {
      ep.state.motionPeak = Math.max(ep.state.motionPeak, reading.motion);
      ep.state.presence ||= reading.present;
    }

    if (
      shouldSaveFrame({
        policy: this.config.storage,
        intervalSeconds: this.config.intervalSeconds,
        now: at,
        lastSavedAt: this.lastSavedAt,
        inEpisode: ep !== null,
      })
    ) {
      this.lastSavedAt = at;
      this.enqueue(() => this.deps.captures.save(frame.jpeg, at));
    }

    if (ep && transition?.kind !== 'ended') this.maybeReview(ep, at);

    if (transition?.kind === 'ended') {
      this.endEpisode(at);
      if (transition.reason === 'still' && this.tracker.takeReferenceRefresh(at, true)) {
        this.detector.refreshReference();
      }
    } else if (!this.episode && this.tracker.takeReferenceRefresh(at)) {
      this.detector.refreshReference();
    }

    if (at - this.lastStatusAt >= 5_000 || transition) {
      this.lastStatusAt = at;
      const current = this.tracker.current;
      this.deps.onStatus({
        state: 'watching',
        lastFrameAt: new Date(at).toISOString(),
        ...(reading.moving ? { lastMotionAt: new Date(at).toISOString() } : {}),
        ...(current && this.episode
          ? {
              episode: {
                id: current.id,
                startedAt: new Date(current.startedAt).toISOString(),
                motion: current.moving,
                presence: current.present,
              },
            }
          : { episode: undefined }),
        capturesBytes: this.deps.captures.bytes,
      });
    }
  }

  private startEpisode(
    id: string,
    at: number,
    jpeg: Buffer,
    motion: number,
    present: boolean,
  ): void {
    const state: EpisodeRecordState = {
      episodeId: id,
      startedAt: at,
      motionPeak: motion,
      presence: present,
      reviews: [],
      keyframes: [],
    };
    CameraEventWriter.addKeyframe(state, jpeg, at);
    const view = this.deps.lookouts();
    // Without a vision review, motion is the only signal there is, so every
    // episode is worth a record; with one, the review decides.
    const interesting = !this.reviewEnabled() || view.motion;
    this.episode = { state, reviews: 0, lastReviewAt: undefined, interesting, written: null };
    const ep = this.episode;
    this.enqueue(async () => {
      if (ep.interesting) await this.writeRecord(ep);
      this.emit(ep, 'started', at);
    });
  }

  private endEpisode(at: number): void {
    const ep = this.episode;
    if (!ep) return;
    this.episode = null;
    ep.state.endedAt = at;
    this.enqueue(async () => {
      if (ep.interesting) await this.writeRecord(ep);
      this.emit(ep, 'ended', at);
    });
  }

  private reviewEnabled(): boolean {
    return this.config.review && this.deps.reviewAllowed();
  }

  private maybeReview(ep: ActiveEpisode, at: number): void {
    if (this.reviewing || !this.reviewEnabled()) return;
    if (
      !reviewDue(
        {
          episodeStartedAt: ep.state.startedAt,
          reviews: ep.reviews,
          lastReviewAt: ep.lastReviewAt,
        },
        at,
      )
    ) {
      return;
    }
    const since = ep.lastReviewAt ?? ep.state.startedAt;
    const candidates = this.ring.filter((f) => f.at >= since);
    // The strongest motion since the last look shows the subject most
    // clearly; with nothing moving (a still subject), the newest frame does.
    const best =
      candidates.reduce<(typeof candidates)[number] | null>(
        (b, f) => (f.motion > 0 && (!b || f.motion > b.motion) ? f : b),
        null,
      ) ?? this.ring[this.ring.length - 1];
    if (!best) return;
    ep.reviews++;
    ep.lastReviewAt = at;
    this.reviewing = true;
    const view = this.deps.lookouts();
    void this.deps.reviewer
      .review(
        {
          key: `${this.deps.projectId}/${this.deps.bindingId}`,
          jpeg: best.jpeg,
          questions: view.questions,
        },
        this.deps.signal,
      )
      .then((outcome) => {
        if (!outcome.ok) {
          if (outcome.reason === 'no-model') this.deps.onStatus({ review: 'no-model' });
          else if (outcome.reason === 'failed')
            log.info(`camera review skipped: ${outcome.detail ?? 'failed'}`);
          return;
        }
        this.deps.onStatus({ review: 'ready' });
        const r = outcome.review;
        const keyframe = CameraEventWriter.addKeyframe(ep.state, best.jpeg, best.at);
        ep.state.reviews.push({
          at: best.at,
          summary: r.summary,
          subjects: r.subjects,
          notable: r.notable,
          answers: r.answers,
          ...(outcome.modelId ? { modelId: outcome.modelId } : {}),
          keyframe,
        });
        const anyYes = Object.values(r.answers).some((a) => isConfidentYes(a));
        if (r.notable || anyYes) ep.interesting = true;
        // Nothing worth noting while something "is there": the presence was
        // a shadow or a moved chair. Adopt the scene as the new empty room.
        if (!r.notable && !anyYes && !this.tracker.current?.moving)
          this.detector.refreshReference();
        this.enqueue(async () => {
          if (ep.interesting) await this.writeRecord(ep);
          this.emit(ep, 'reviewed', this.now(), {
            summary: r.summary,
            subjects: r.subjects,
            notable: r.notable,
            answers: r.answers,
            durationMs: outcome.durationMs,
            ...(outcome.modelId ? { modelId: outcome.modelId } : {}),
            keyframe,
          });
        });
      })
      .finally(() => {
        this.reviewing = false;
      });
  }

  private async writeRecord(ep: ActiveEpisode): Promise<void> {
    if (this.deps.signal.aborted && !ep.state.endedAt) return;
    if (!ep.written) {
      const hour = Math.floor(this.now() / 3_600_000);
      if (this.eventsThisHour.hour !== hour) this.eventsThisHour = { hour, count: 0 };
      if (this.eventsThisHour.count >= EVENTS_PER_HOUR) return;
      this.eventsThisHour.count++;
    }
    try {
      const written = await this.deps.events.write(ep.state);
      if (written) {
        ep.written = written;
        this.deps.onRecordWritten();
        this.deps.onStatus({ lastEventAt: new Date(this.now()).toISOString() });
      }
    } catch (err) {
      log.warn('camera event record failed:', err instanceof Error ? err.message : err);
    }
  }

  private emit(
    ep: ActiveEpisode,
    phase: CameraEvent['phase'],
    at: number,
    review?: {
      summary: string;
      subjects: string[];
      notable: boolean;
      answers: Record<string, { match: boolean; confidence: 'low' | 'medium' | 'high' }>;
      durationMs: number;
      modelId?: string;
      keyframe: number;
    },
  ): void {
    const keyframePaths = ep.written?.keyframePaths ?? [];
    const event: CameraEvent = {
      projectId: this.deps.projectId,
      bindingId: this.deps.bindingId,
      cameraLabel: this.deps.cameraLabel,
      episodeId: ep.state.episodeId,
      phase,
      at: new Date(at).toISOString(),
      startedAt: new Date(ep.state.startedAt).toISOString(),
      ...(ep.state.endedAt !== undefined
        ? { endedAt: new Date(ep.state.endedAt).toISOString() }
        : {}),
      motionPeak: ep.state.motionPeak,
      presence: ep.state.presence,
      ...(review
        ? {
            review: {
              summary: review.summary,
              subjects: review.subjects,
              notable: review.notable,
              answers: review.answers,
              durationMs: review.durationMs,
              ...(review.modelId ? { modelId: review.modelId } : {}),
              ...(keyframePaths[review.keyframe] ? { frame: keyframePaths[review.keyframe] } : {}),
            },
          }
        : {}),
      ...(ep.written
        ? { recordPath: ep.written.recordPath, attachmentsDir: ep.written.attachmentsDir }
        : {}),
      keyframePaths,
    };
    try {
      this.deps.onEvent(event);
    } catch (err) {
      log.warn('camera event listener threw:', err);
    }
  }

  private enqueue(work: () => Promise<unknown>): void {
    this.chain = this.chain.then(work).catch((err) => {
      log.warn('camera pipeline write failed:', err instanceof Error ? err.message : err);
    });
  }

  /** Finish the open episode and wait for pending writes. */
  async close(): Promise<void> {
    if (this.episode) this.endEpisode(this.now());
    await this.chain;
  }
}
