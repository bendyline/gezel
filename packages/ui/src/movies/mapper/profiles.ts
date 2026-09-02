/**
 * Rendition profiles — the two ways a run recording plays back.
 *
 * `debug`: complete and chaptered. Every scene the distiller kept,
 * order-preserving log-compressed timing, wall-clock stamps on screen.
 * The eval-triage rendition.
 *
 * `marketing`: a ~2-minute cut. Salience-scored scene selection,
 * reading-time pacing scaled into the target duration, social captions,
 * cover and outro. The gezelgilde/gezel.com rendition.
 */
export type RenditionProfile = 'debug' | 'marketing';

export interface RenditionKnobs {
  /** Target duration in seconds (marketing only; debug derives its own). */
  targetDurationSeconds: number;
  /** Per-scene dwell bounds in seconds. */
  minSceneSeconds: number;
  maxSceneSeconds: number;
  /** Idle gaps longer than this become an explicit "time passes" beat. */
  gapBeatThresholdSeconds: number;
  gapBeatSeconds: number;
  /** Ceiling on blocks in the final doc (over → lowest-salience dropped). */
  maxBlocks: number;
  /** Show wall-clock stamps on scenes. */
  showTimestamps: boolean;
}

export const RENDITION_KNOBS: Record<RenditionProfile, RenditionKnobs> = {
  debug: {
    targetDurationSeconds: 0,
    minSceneSeconds: 2.5,
    maxSceneSeconds: 12,
    gapBeatThresholdSeconds: 60,
    gapBeatSeconds: 2,
    maxBlocks: 120,
    showTimestamps: true,
  },
  marketing: {
    targetDurationSeconds: 115,
    minSceneSeconds: 2,
    maxSceneSeconds: 9,
    gapBeatThresholdSeconds: Number.POSITIVE_INFINITY,
    gapBeatSeconds: 0,
    maxBlocks: 28,
    showTimestamps: false,
  },
};
